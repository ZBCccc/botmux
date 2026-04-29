// Sessions page: filter bar, table, detail drawer with locate (30s cooldown) + close.
import { store } from './store.js';

const PAGE_HTML = `
<form id="filters" class="filters">
  <input type="search" name="q" placeholder="search workingDir / title / ids" />
  <select name="cli" multiple size="4">
    <option value="claude-code">claude-code</option>
    <option value="codex">codex</option>
    <option value="gemini">gemini</option>
    <option value="opencode">opencode</option>
    <option value="aiden">aiden</option>
    <option value="coco">coco</option>
    <option value="unknown">unknown</option>
  </select>
  <select name="status">
    <option value="">any status</option>
    <option>starting</option><option>working</option>
    <option>idle</option><option>analyzing</option><option>closed</option>
  </select>
  <select name="adopt">
    <option value="">adopt: any</option>
    <option value="yes">adopt: yes</option>
    <option value="no">adopt: no</option>
  </select>
  <label><input type="checkbox" name="active" checked> active only</label>
</form>
<table id="sessions-table">
  <thead><tr>
    <th>bot</th><th>cli</th><th>status</th><th>title</th><th>workingDir</th>
    <th>spawned</th><th>last</th><th>adopt</th><th></th>
  </tr></thead>
  <tbody></tbody>
</table>
<dialog id="drawer"></dialog>
`;

function relTime(ms: number): string {
  if (!ms) return '-';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h';
  return Math.floor(diff / 86_400_000) + 'd';
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}

const ICON_MIRROR = '\u{1FA9E}';
const ICON_PIN = '\u{1F4CD}';
const ICON_SCREEN = '\u{1F5A5}️';

export function renderSessionsPage(root: HTMLElement) {
  root.innerHTML = PAGE_HTML;
  const tbody = root.querySelector<HTMLElement>('#sessions-table tbody')!;
  const filtersForm = root.querySelector<HTMLFormElement>('#filters')!;
  const drawer = root.querySelector<HTMLDialogElement>('#drawer')!;

  function rowHtml(s: any) {
    return `<tr data-id="${escapeHtml(s.sessionId)}">
      <td>${escapeHtml(s.botName ?? '')}</td>
      <td><span class="badge cli-${escapeHtml(s.cliId ?? 'unknown')}">${escapeHtml(s.cliId ?? 'unknown')}</span></td>
      <td><span class="status status-${escapeHtml(s.status)}">${escapeHtml(s.status)}</span></td>
      <td>${escapeHtml((s.title ?? '').slice(0, 40))}</td>
      <td title="${escapeHtml(s.workingDir ?? '')}">${escapeHtml((s.workingDir ?? '').slice(-30))}</td>
      <td>${relTime(s.spawnedAt)}</td>
      <td>${relTime(s.lastMessageAt)}</td>
      <td>${s.adopt ? ICON_MIRROR : ''}</td>
      <td><button class="open">⋯</button></td>
    </tr>`;
  }

  function filtered(): any[] {
    const f = new FormData(filtersForm);
    const q = ((f.get('q') as string) ?? '').toLowerCase();
    const cli = f.getAll('cli') as string[];
    const status = f.get('status') as string;
    const adopt = f.get('adopt') as string;
    const active = !!f.get('active');
    return [...store.sessions.values()]
      .filter(s => !cli.length || cli.includes(s.cliId ?? 'unknown'))
      .filter(s => !status || s.status === status)
      .filter(s => !adopt || (adopt === 'yes') === !!s.adopt)
      .filter(s => !active || s.status !== 'closed')
      .filter(s => !q || JSON.stringify(s).toLowerCase().includes(q))
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0));
  }

  function rerender() {
    tbody.innerHTML = filtered().map(rowHtml).join('');
  }

  function openDrawer(s: any) {
    const closed = s.status === 'closed';
    drawer.innerHTML = `
      <article>
        <header>
          <h3>${escapeHtml(s.title ?? s.sessionId)}</h3>
          <code>${escapeHtml(s.sessionId)}</code> <button data-copy="${escapeHtml(s.sessionId)}">copy</button>
        </header>
        <p><b>bot:</b> ${escapeHtml(s.botName ?? '-')} · <b>cli:</b> ${escapeHtml(s.cliId ?? '?')} · <b>status:</b> ${escapeHtml(s.status)}</p>
        <p><b>chatId:</b> <code>${escapeHtml(s.chatId)}</code> <button data-copy="${escapeHtml(s.chatId)}">copy</button></p>
        <p><b>rootMessageId:</b> <code>${escapeHtml(s.rootMessageId ?? '')}</code> <button data-copy="${escapeHtml(s.rootMessageId ?? '')}">copy</button></p>
        ${s.threadId ? `<p><b>threadId:</b> <code>${escapeHtml(s.threadId)}</code></p>` : ''}
        <p><b>workingDir:</b> ${escapeHtml(s.workingDir ?? '-')}</p>
        <div class="actions">
          <button id="locate-btn" type="button">${ICON_PIN} 定位到飞书话题</button>
          ${s.webPort ? `<a class="btn-link" href="http://${escapeHtml(location.hostname)}:${s.webPort}" target="_blank">${ICON_SCREEN} 打开 xterm</a>` : ''}
          ${!closed ? `<button id="close-btn" type="button" class="contrast">关闭会话</button>` : ''}
        </div>
        <form method="dialog"><button>关闭</button></form>
      </article>`;

    drawer.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach(b => {
      b.onclick = () => {
        navigator.clipboard.writeText(b.dataset.copy ?? '');
        b.textContent = 'copied';
        setTimeout(() => { b.textContent = 'copy'; }, 800);
      };
    });

    const locateBtn = drawer.querySelector<HTMLButtonElement>('#locate-btn');
    if (locateBtn) {
      locateBtn.onclick = async () => {
        locateBtn.disabled = true;
        locateBtn.textContent = `${ICON_PIN} 发送中...`;
        try {
          const r = await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/locate`, { method: 'POST' });
          const body = await r.json();
          if (body.ok) {
            window.open(s.feishuChatLink, '_blank');
            let left = 30;
            locateBtn.textContent = `${ICON_PIN} (冷却 ${left}s)`;
            const tick = setInterval(() => {
              left -= 1;
              if (left <= 0) {
                clearInterval(tick);
                locateBtn.disabled = false;
                locateBtn.textContent = `${ICON_PIN} 定位到飞书话题`;
              } else {
                locateBtn.textContent = `${ICON_PIN} (冷却 ${left}s)`;
              }
            }, 1000);
          } else {
            const reason = body.error ?? r.status;
            alert('Locate failed: ' + reason);
            locateBtn.disabled = false;
            locateBtn.textContent = `${ICON_PIN} 定位到飞书话题`;
          }
        } catch (e) {
          alert('Locate error: ' + e);
          locateBtn.disabled = false;
          locateBtn.textContent = `${ICON_PIN} 定位到飞书话题`;
        }
      };
    }

    const closeBtn = drawer.querySelector<HTMLButtonElement>('#close-btn');
    if (closeBtn) {
      closeBtn.onclick = async () => {
        if (!confirm('关闭这个会话?')) return;
        closeBtn.disabled = true;
        try {
          await fetch(`/api/sessions/${encodeURIComponent(s.sessionId)}/close`, { method: 'POST' });
        } finally {
          drawer.close();
        }
      };
    }

    drawer.showModal();
  }

  tbody.addEventListener('click', e => {
    const tr = (e.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-id]');
    if (!tr) return;
    const sid = tr.dataset.id!;
    const s = store.sessions.get(sid);
    if (s) openDrawer(s);
  });
  filtersForm.addEventListener('input', rerender);
  store.on(rerender);
  rerender();
}
