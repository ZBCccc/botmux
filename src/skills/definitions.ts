/**
 * Canonical skill definitions shipped with botmux.
 *
 * Each skill is a SKILL.md ready to drop into any CLI's skills directory.
 * Skills here MUST:
 *   - use `botmux <subcmd>` shell commands (CLI is the canonical interface)
 *   - not depend on MCP tools (which may not be wired on every CLI)
 *   - keep frontmatter minimal — just `name` and `description` for discovery
 */

export interface SkillDef {
  /** Filesystem-safe name — becomes the directory name under {skillsDir}/ */
  name: string;
  /** Markdown content including YAML frontmatter */
  content: string;
}

const SCHEDULE_SKILL = `---
name: botmux-schedule
description: 当用户要求创建定时任务/提醒（"每天X点提醒"、"30分钟后"、"每周一"、"remind me"、"schedule"）时触发。使用 botmux schedule 命令操作定时任务（增删查改），支持 Lark 话题内自动路由。
---

# botmux-schedule — 定时任务

当用户要求"定时"/"提醒"/"每天"/"每周"/"N 分钟后"等时间相关的自动化请求时，使用本技能创建/管理定时任务。

## 核心原则

1. **创建前必须跟用户确认** schedule 和 prompt 的具体内容，避免误加
2. **默认不传 --chat-id / --root-msg-id** —— 在 Lark 话题的 CLI 会话内运行时 botmux 会自动推断
3. 创建后把 task id 和下次执行时间回显给用户
4. 如果用户是在编程会话里顺手说"以后每天X点都这样做"，先问他：是否希望到点以后自动在当前话题里继续

## 支持的 schedule 格式

| 格式 | 说明 | 示例 |
|---|---|---|
| cron 表达式 | 5 字段 | \`"0 9 * * *"\` 每天 09:00 |
| 英文 duration | 一次性 | \`"30m"\` 30 分钟后 / \`"2h"\` / \`"1d"\` |
| 英文 interval | 循环 | \`"every 30m"\` / \`"every 2h"\` |
| ISO 时间 | 一次性 | \`"2026-05-01T10:00"\` |
| 中文自然语言 | 推荐给中文用户 | \`"每日17:50"\` / \`"每周一10:00"\` / \`"30分钟后"\` / \`"明天9:00"\` |

## 子命令

### 创建

\`\`\`
botmux schedule add "<schedule>" "<prompt>" [--name <name>] [--deliver origin|local]
\`\`\`

prompt 是到点时会被执行的内容，就像用户新开一个话题向你发送这段 prompt 一样。
可选 \`--deliver local\` 表示只记录不推送（适合"每小时检查一次，没事就别打扰我"）。

### 查看

\`\`\`
botmux schedule list
\`\`\`

### 管理

\`\`\`
botmux schedule pause <id>     # 暂停（不删除）
botmux schedule resume <id>    # 恢复
botmux schedule remove <id>    # 删除
botmux schedule run <id>       # 标记立即执行（< 30 秒内 daemon 会触发）
\`\`\`

## 典型用法

**用户**："每天早上 9 点生成一下昨天的 PR 汇总"

你先跟用户确认：我打算建一个每天 09:00 的定时任务，到点自动在本话题生成 PR 汇总，可以吗？

用户确认后执行：

\`\`\`bash
botmux schedule add "每日9:00" "生成昨天的 GitHub PR 汇总（合并的 / 待 review 的），按 repo 分组"
\`\`\`

**用户**："30 分钟后提醒我检查一下部署状态"

\`\`\`bash
botmux schedule add "30m" "检查部署状态（调用 kubectl get pods 看看有无 CrashLoop）"
\`\`\`

## 到点会发生什么

- botmux daemon 每 30 秒 tick 一次，到点会在**原话题**里自动续一条消息并把 prompt 喂给一个新的 CLI 会话
- 工作目录与创建任务时一致
- 如果原话题的会话还活着，prompt 会直接注入现有会话（不会开新会话）
`;

const THREAD_MESSAGES_SKILL = `---
name: botmux-thread-messages
description: 需要查看当前 Lark 话题的历史消息时触发。适合"看看这个话题之前聊了什么"、"最近的消息"、"上下文"类请求。在 CLI 会话内自动推断 session-id。
---

# botmux-thread-messages — 读取话题消息历史

想回顾当前 Lark 话题里用户之前发过什么、别的机器人说了什么时使用。

## 用法

\`\`\`bash
# 拉取最近 50 条（默认）
botmux thread messages

# 拉取最近 100 条
botmux thread messages --limit 100

# 指定 session-id（不在 CLI 会话内时用）
botmux thread messages --session-id <uuid>
\`\`\`

## 输出

JSON 格式，字段：

\`\`\`json
{
  "sessionId": "...",
  "threadId": "...",
  "messages": [
    { "messageId": "...", "senderId": "...", "senderType": "user|app", "msgType": "text|post|interactive", "content": "...", "createTime": "..." }
  ],
  "total": 17
}
\`\`\`

## 注意

- 只返回属于当前话题的消息（按 rootMessageId 过滤）
- senderType="app" 表示机器人发的消息（包括 Claude Code / Codex / 其它 bot），"user" 表示用户
- 需要先把 JSON 读进来再做总结，不要直接把 JSON 扔给用户
`;

export const BUILTIN_SKILLS: SkillDef[] = [
  { name: 'botmux-schedule', content: SCHEDULE_SKILL },
  { name: 'botmux-thread-messages', content: THREAD_MESSAGES_SKILL },
];
