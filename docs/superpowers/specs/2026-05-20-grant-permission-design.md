# 群内授权（`/grant` · `/revoke` · 授权卡片）设计

日期：2026-05-20
状态：v2 — 已纳入 Codex review 全部 8 项（见文末处置表）

## 背景与动机

botmux 的使用权限由每个 bot 的 `allowedUsers`（`bots.json` 中的字符串数组）控制：
启动时把 email 前缀解析成 `open_id` 写入内存 `resolvedAllowedUsers`，`canTalk` /
`canOperate` 两个闸门都查它。

**痛点**：要给新成员开权限，必须在启动前拿到对方的 `open_id`，而 `open_id` 无法
从 email 直接查到。于是「给别人加权限」非常不便。

**核心洞察**：飞书消息里只要出现 `@某人`，那条 mention 就**自带对方的 `open_id`**
（`message.mentions[].id.open_id`）。因此「在群里 @ 一下就能授权」天然绕开 email→open_id
的查询，这是本方案成立的根基。

## 目标

1. 新增 `/grant`（授权）、`/revoke`（撤销）两个群内命令，**仅 owner 可用**。
2. 支持两种授权范围：**授权本群**、**全局授权**。
3. 一张「授权卡片」，两种入口都弹它：
   - **入口 A（自助申请）**：无权限者 @机器人 时，不再静默/回「无操作权限」，而是自动弹卡片并 @owner。
   - **入口 B（owner 主动）**：owner 发 `/grant @张三`，弹同一张卡片，owner 直接点范围按钮。
4. 变更即时生效（同步内存），并持久化到 `bots.json`（重启保留）。

## 非目标

- 不做基于角色/分组的细粒度 RBAC，只有「本群」「全局」两档。
- 不引入 per-chat owner 列表；owner 始终等于 bot 的 `resolvedAllowedUsers[0]`（首个 `ou_`）。
- 不改动 oncall 的 chat 级开放语义；本方案是 per-user 授权，与 oncall 正交叠加。

## 术语：谁是 owner

owner = bot 的首个已授权用户，即 `resolvedAllowedUsers.find(u => u.startsWith('ou_'))`，
与现有「缺权限警告私信对象」（`bot-registry.ts:120`）同一口径。新增 `getOwnerOpenId(larkAppId)`
封装这一查询，全程复用。

**开放模式特例**：当 `allowedUsers` 为空时，现有语义是「所有人可用」。此时没有 owner，
也无需授权——`/grant` / `/revoke` 直接回一句「当前未设置 allowedUsers，所有人可用，无需授权」，
入口 A 的卡片也不触发。

## 数据模型

### 全局授权
复用现有机制：把 `open_id` 追加进 `bots.json` 对应 bot 条目的 `allowedUsers`（去重），
并同步追加到内存 `resolvedAllowedUsers`。

### 本群授权（新增）
`BotConfig` 新增字段：

```ts
/** Per-chat per-user grants: chat_id → 被授权的 open_id 列表。
 *  与全局 allowedUsers 正交：命中任一即放行。 */
chatGrants?: { [chatId: string]: string[] };
```

`BotState` 不新增字段——`chatGrants` 直接读 `bot.config.chatGrants`（与 oncall 的
`oncallChats` 一样走 in-memory config）。

**⚠️ 必须进 `parseBotConfigFile` 白名单**：`bot-registry.ts:278-292` 用字段白名单重建
`BotConfig`，未列出的字段重启后被丢弃。所以除了加 interface 字段，还要在解析处显式读取、
**校验过滤**（只保留 `chatId: string` → `string[]`，逐项 `typeof === 'string'`）并回填
`chatGrants`，否则 grant-store 写入 `bots.json` 后重启不进内存。

### 授权范围语义（Codex review #2 — 关键澄清）
**「授权本群」= 仅放行「与机器人对话/喂 prompt」，不授予 daemon 管理命令权。**

理由：`chatGrants` 若同时进 `canOperate`，本群授权用户就能跑 `/cd`、`/restart`、`/repo`、
`/schedule`，尤其 `/oncall bind`（把整个群对所有人开放）、`/adopt`、`get_write_link`（写终端
链接）——这比「让某人在本群用机器人」大一档，是权限膨胀。用户原话是「加使用权限/授权人」，
语义就是「能用」，管理权应保留给 owner / 全局 allowedUsers。

因此：
- `chatGrants` **只进 `canTalk`，绝不进 `canOperate`**。
- 卡片敏感动作已走 `canOperate`（`card-handler.ts:152`），故自动不受 chatGrant 影响——
  只要不把 chatGrant 加进 canOperate 即可。
- **但 daemon 命令路径在非 oncall 群没查 canOperate**（`daemon.ts:455-464` / `760-768` 仅在
  `isChatOncallBoundForAnyBot` 时才查）。chat-granted 用户能过 `canTalk` 到达命令分支，存在缺口。
  **修复**：把这两处的 oncall 前置条件去掉，改为**所有群**的 daemon 命令都要求 `canOperate`
  （对现有 allowedUsers 用户是 no-op，因为他们本就过 canOperate；只挡住 chat-granted 用户）。

### 闸门改动
仅 `canTalk` 增加一条放行规则（`canOperate` **不动**）：

```ts
function hasChatGrant(larkAppId, chatId, openId): boolean {
  return !!chatId && !!openId &&
    !!getBot(larkAppId).config.chatGrants?.[chatId]?.includes(openId);
}
```

- `canTalk`：oncall 放行 → known peer bot 放行 → `allowedUsers` 命中 → **`chatGrants` 命中** → 否则拒。
- `canOperate`：维持现状（`allowedUsers` 命中），**不加 chatGrants**。
- daemon 命令路径：去掉 oncall 前置，统一要求 `canOperate`（见上）。

注意：开放模式（`allowedUsers` 为空）下闸门本就返回 `true`，`chatGrants` 不影响。

## 持久化层：`grant-store.ts`

镜像 `oncall-store.ts` 的并发安全写法（`withFileLock` + 原子 rename + 内存同步）。

**先做一个小重构**：把 `oncall-store.ts` 里私有的 `rmwBotEntry` / `readRawConfig` /
`writeRawConfigAtomic` / `findEntryIndex` / `requireConfigPath` 抽到共享模块
`src/services/config-store.ts`，`oncall-store.ts` 与新 `grant-store.ts` 都从它 import。
（纯提取，不改行为；让两个 store 共享同一把跨进程文件锁。）

**⚠️ 文件权限（Codex review #5）**：`bots.json` 含 `appSecret`，setup 写它用 `0o600`
（`bots-store.ts:9-13`），但 oncall-store 现有 `writeRawConfigAtomic` 的临时文件没指定 mode
（`oncall-store.ts:29-32`），rename 后会把 `bots.json` 落成 umask 默认权限（可能 0644）。
抽取时**顺手修掉**：temp 文件以 `{ mode: 0o600 }` 写入，并在 rename 前 `fchmod`/写入即正确，
保证最终文件保持 `0o600`。（这是抽取附带的安全修复，不是行为回归。）

`grant-store.ts` 暴露：

```ts
// 全局
addGlobalGrant(larkAppId, openId): Promise<{ok:true; created:boolean} | {ok:false; reason}>
removeGlobalGrant(larkAppId, openId): Promise<{ok:true; existed:boolean} | {ok:false; reason}>
// 本群
addChatGrant(larkAppId, chatId, openId): Promise<{ok:true; created:boolean} | {ok:false; reason}>
removeChatGrant(larkAppId, chatId, openId): Promise<{ok:true; existed:boolean} | {ok:false; reason}>
```

每个写函数：`rmwBotEntry` 改 `bots.json` → 成功后同步内存（`resolvedAllowedUsers` 或
`config.chatGrants`）→ `logger.info`。`removeGlobalGrant` 同时从 `allowedUsers` 和
`resolvedAllowedUsers` 删除。

**⚠️ 防误删致开放模式（Codex review #1 — Critical）**：开放模式（`allowedUsers` 为空 →
全员可用）和「无人授权」用的是同一个空数组，语义相反。若 `removeGlobalGrant` 删掉**最后一个**
全局 `open_id`（尤其 owner 自己），受限 bot 会反向变成**全员开放**。
**修复**：`removeGlobalGrant` 增加守卫——当移除后 `allowedUsers` 会变空时，**拒绝并返回
`reason:'would_open_bot'`**；同样禁止撤销当前 owner 的全局授权。撤销不能制造「空 = 开放」。
（如果将来要支持「彻底锁死无人可用」，需引入显式 `restricted: true` 状态，本期不做。）

**revoke 语义**：`/revoke @user` 做「彻底撤销」——同时调用 `removeChatGrant(本群)` 和
`removeGlobalGrant`，回执里说明实际移除了哪些范围（本群/全局/无/被守卫拒绝）。理由：撤销应
彻底切断；用户要的就是 `/revoke @xx` 一键收回。受上面守卫约束：不会把全局清空。

**⚠️ revoke 不清理历史副作用（Codex review #8）**：被撤销用户此前用 `/schedule` 建的定时任务
不会被 revoke 停掉（schedule task 当前无 creator open_id、无运行时权限复查，
`schedule-store.ts:126-168`）。本期**明确不处理**，仅在回执/文档说明；如需联动需另加 creator
字段与撤销时禁用策略（独立任务）。

## 命令层：`im/lark/grant-command.ts`

`/grant`、`/revoke` 是**元命令**，必须在 dispatcher 路由/spawn 之前拦截，否则会被当成 prompt
喂给 CLI 会话。但**不能照搬 `/introduce` 的「无条件拦截」**（Codex review #3）：`/introduce`
（`event-dispatcher.ts:779-783`）有意让每个被 @ 的 bot 各自记录 mentions，所以无条件；而 `/grant`
若裸发，在多 bot 群里可能被多个 daemon 重复处理，或（若飞书只推 @bot 消息）根本收不到。

**修复**：
- 入口 B 固定为 **`@bot /grant @user`**——拦截时先 `isBotMentioned(larkAppId, message, senderOpenId)`
  确认本 bot 被 @，否则不处理（p2p / 单 bot 群可放宽）。
- 解析 target mention 时**排除 bot 自己的 open_id**（不能直接取 `message.mentions[0]`，否则会把
  被 @ 的机器人自己当成授权对象）。取第一个非本 bot 的人类 mention。

新增 `tryHandleGrantCommand(larkAppId, message, senderOpenId, chatId, ...)`，在 introduce
拦截之后调用；命中且本 bot 被 @ 时处理并返回 `true`（短路）。

### `/grant`
- 解析文本（容忍 `@_user_N` 占位符 → 从 `message.mentions` 取 `open_id`，与 message-parser 同款解析）。
- **owner 闸门**：`senderOpenId !== getOwnerOpenId(larkAppId)` → 回「仅 owner 可授权」。
- 无 mention（`/grant` 单发）→ 回用法提示。
- 有 mention（`/grant @张三`）→ 弹**授权卡片**（owner 发起态），owner 点范围按钮完成。
- （可选增强，先不做）`/grant @张三 here` / `/grant @张三 global` 直接授权跳过卡片。

### `/revoke`
- 同样 owner 闸门 + mention 解析。
- `/revoke @张三` → 调用彻底撤销，回执说明移除范围。直接执行，不弹卡片。
- 同时把该用户从入口 A 的「pending 节流表」里清掉（见下）。

### 命令注册
- `DAEMON_COMMANDS`（command-handler.ts:29）**不加** `/grant` `/revoke`——它们走 dispatcher 拦截，不进 command-handler 的 session 分支。
- 但需确保 dispatcher 的 `/grant` `/revoke` 拦截在「命中 daemon 命令」判断之前，避免误入 CLI。

## 授权卡片

复用 `card-builder.ts` 的卡片构造风格，新增 `buildGrantCard(...)`：

- 文案：「用户 @<申请人> 申请使用我，请 @<owner> 选择授权范围」（卡片正文 mention owner，
  保证 owner 收到红点）。
- 按钮三枚，`value` 各带 action + 上下文 + **nonce**：
  - `[ 授权本群 ]` → `{ action: 'grant_chat', target_open_id, chat_id, nonce }`
  - `[ 全局授权 ]` → `{ action: 'grant_global', target_open_id, chat_id, nonce }`
  - `[ 拒绝 ]` → `{ action: 'grant_deny', target_open_id, chat_id, nonce }`
- 入口 A 与入口 B 用同一张卡，仅文案前缀略不同（「申请使用」vs「请选择对 @X 的授权范围」）。

**⚠️ nonce 防旧卡重放（Codex review #6 — 关键）**：发卡时生成随机 `nonce`，写进 pending 表
（key=`bot:chat:target`，value 含 nonce）。card-handler 处理 grant action 前先校验
**pending 仍存在且 nonce 匹配**；否则只 toast「该授权请求已失效」。这样 `/revoke` 清 pending、
或 daemon 重启清空内存表后，**旧卡片点击一律失效**——owner 误点过期卡不会重新授权。内存表
重启重置在这里反而是安全特性。

### 卡片点击处理（card-handler.ts）

在 `handleCardAction` **靠前**处理这三个 action（在现有 session 解析逻辑之前），
因为它们不绑定 DaemonSession（无 `root_id`/`ds`）：

1. **owner 闸门（强）**：必须用**当前 app** 的 `operator.open_id === getOwnerOpenId(larkAppId)`
   → 否则 toast「仅 owner 可操作」，不改任何状态。比现有 `isSensitive` 的 `canOperate` 更严。
2. **nonce 校验**：pending 表里该 `(bot,chat,target)` 仍存在且 nonce 匹配 → 继续；否则 toast
   「该授权请求已失效」（旧卡 / revoke 后 / 重启后）。
3. `grant_chat` → `addChatGrant`；`grant_global` → `addGlobalGrant`；`grant_deny` → 不授权。
4. 三种都更新卡片为终态（「✅ 已授权本群 / ✅ 已全局授权 / 🚫 已拒绝」），按钮置灰/移除，避免重复点击。
5. 清理该 `(bot,chat,target)` 的 pending 记录。

## 入口 A：无权限者自助申请

改 `event-dispatcher.ts:884` 的 `access === 'not_allowed'` 分支：原本回「⚠️ 无操作权限」，改为：

- 若**开放模式**（无 owner）→ 维持原逻辑（理论上开放模式不会进 not_allowed，但兜底保留）。
- 否则：发**授权卡片**（@owner，申请人 = `senderOpenId`），代替「无操作权限」文本。

**⚠️ 覆盖 ownsSession 场景（Codex review #7）**：现有逻辑在 `ownsSession === true` 时连
「无操作权限」都不回（`event-dispatcher.ts:884-888`），会漏掉「普通群已有 chat-scope session、
无权限者来 @ 申请」的场景。目标是「无权限者 @机器人就弹申请卡」，所以 `access === 'not_allowed'`
**无论 ownsSession 真假都走节流+卡片**；只是**绝不把该消息送进已有 session**（不喂 prompt）。

### 节流（必须）
避免无权限者每发一句就刷一张卡。用**内存** Map：

```ts
key = `${larkAppId}:${chatId}:${requesterOpenId}`
```

- 已有 pending（卡片已发、owner 未处置）或在冷却窗口内（如 10 分钟）→ 静默不再发。
- owner 处置（授权/拒绝）或 `/revoke` → 清除该 key，允许将来再次申请。
- 仅内存（daemon 重启后重置可接受——重启后第一条会重新弹卡，符合直觉）。

## 模块清单

| 文件 | 改动 |
| --- | --- |
| `src/services/config-store.ts` | **新增**：从 oncall-store 提取的共享 rmw/锁/IO helper；temp 写入保 `0o600`（#5） |
| `src/services/oncall-store.ts` | 改为 import 共享 helper（纯重构） |
| `src/services/grant-store.ts` | **新增**：add/removeGlobalGrant、add/removeChatGrant；removeGlobalGrant 防清空守卫（#1） |
| `src/bot-registry.ts` | `BotConfig.chatGrants` 字段；`getOwnerOpenId()`；**`parseBotConfigFile` 白名单解析+过滤 `chatGrants`**（#4） |
| `src/im/lark/event-dispatcher.ts` | `canTalk` 加 chatGrants 放行（**`canOperate` 不动**, #2）；not_allowed 分支改弹卡片+节流，覆盖 ownsSession（#7）；grant-command 拦截（要求 isBotMentioned, #3） |
| `src/daemon.ts` | 去掉 daemon 命令路径（`455-464`/`760-768`）的 oncall 前置，**所有群** daemon 命令统一要求 `canOperate`（#2） |
| `src/im/lark/grant-command.ts` | **新增**：`tryHandleGrantCommand`（/grant、/revoke）；isBotMentioned 守卫 + 排除 bot 自身 mention（#3） |
| `src/im/lark/card-builder.ts` | **新增**：`buildGrantCard`（按钮带 nonce, #6） |
| `src/im/lark/card-handler.ts` | 处理 `grant_chat`/`grant_global`/`grant_deny`：owner 强闸门 + nonce 校验（#6），在 session 解析之前 |
| `src/im/lark/grant-pending.ts` | **新增**：内存 pending+节流表（key=`bot:chat:target`→{nonce,ts}），含 nonce 生成/校验/清除 |
| `src/i18n/zh.ts` `en.ts` | 命令回执、卡片、toast、失效提示文案 |
| `src/core/command-handler.ts` `/help` | 文档里补 `/grant` `/revoke` 说明 |

## 测试要点

- `grant-store`：add/remove 全局与本群，去重、幂等、内存与 `bots.json` 同步、并发锁（与 oncall 同款）。
- **#1**：`removeGlobalGrant` 删到只剩最后一个 / owner 时被守卫拒绝（`would_open_bot`），bot 不变开放。
- **#2**：`chatGrants` 命中只过 `canTalk` 不过 `canOperate`；chat-granted 用户在非 oncall 群跑 `/cd`/`/oncall bind` 被 `canOperate` 挡；现有 allowedUsers 用户不受影响（回归）。
- **#3**：裸 `/grant @x`（未 @bot）不被处理；`@bot /grant @x` 生效；mention 解析排除 bot 自身。
- **#4**：写入 `chatGrants` → 重启 → `parseBotConfigFile` 正确回填进内存。
- **#5**：写 `bots.json` 后文件权限仍是 `0o600`。
- **#6**：旧卡 / revoke 后 / 重启后点击授权 → nonce 不匹配 → toast 失效，不重新授权。
- **#7**：not_allowed 在 ownsSession=true 时也弹卡，且消息不进 session。
- 闸门跨 chat 不串；开放模式不受影响。
- 命令解析：`/grant @x`、`/revoke @x`、无 mention、非 owner 调用被拒。
- 卡片点击：非 owner（非 owner 本人）点击被拦（toast）；三种 action 终态正确；pending 清除。
- 入口 A：not_allowed → 弹卡（@owner）；同人重复发不刷屏；revoke 后可再次申请。

## 待评审决策点（已与用户确认）

1. 命令名：`/grant` ✔
2. 谁能批准卡片：**仅 owner**（当前 app 的 `operator.open_id === getOwnerOpenId`）✔
3. 撤销：`/revoke @xx`（彻底撤销本群+全局，但受 #1 守卫不清空全局）✔

## Codex review 处置（基于 a2cb248，全部采纳）

| # | 级别 | 处置 |
| --- | --- | --- |
| 1 | Critical | removeGlobalGrant 守卫：不允许删到空 / 删 owner，避免「空=开放」反转 |
| 2 | High | chatGrant 只进 canTalk；daemon 命令统一要求 canOperate（去掉 oncall 前置） |
| 3 | High | /grant 拦截要求 isBotMentioned；mention 解析排除 bot 自身 |
| 4 | Medium | chatGrants 进 parseBotConfigFile 白名单解析+过滤 |
| 5 | Medium | config-store temp 写入保 0o600 |
| 6 | Medium | 授权卡带 nonce，card-handler 校验 pending+nonce，旧卡失效 |
| 7 | Med/Low | not_allowed 覆盖 ownsSession 场景，但不喂 session |
| 8 | Low | 明确记录：revoke 不停历史 schedule（本期不联动） |

**唯一产品决策（#2 语义）**：「授权本群」= 仅对话使用，不含 daemon 管理命令权——管理权保留
owner / 全局 allowedUsers。符合用户「加使用权限」的原意。
