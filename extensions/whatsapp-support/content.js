// Asisto | Version: 5.00.069 | Fecha: 2026-09-08
(() => {
  let chats = [], owner = '', timer, stopped = false;
  const remembered = new Map();
  const extractJid = value => (value || '').match(/(?:^|_)([0-9]+@(?:s\.whatsapp\.net|lid))(?:_|$)/)?.[1] || '';
  function update() {
    if (stopped) return;
    observer.disconnect();
    // Work only with displayed contact labels. Never inspect WhatsApp's private stores.
    const targets = [...document.querySelectorAll('#pane-side [role="row"], #pane-side [role="listitem"], #main header')];
    const retained = new Set();
    for (const target of targets) {
      if (target.closest('[data-asisto-owned]')) continue;
      const label = target.querySelector('span[title][dir="auto"], span[title]');
      if (!label) continue;
      const jid = extractJid(target.getAttribute('data-id') || target.querySelector('[data-id]')?.getAttribute('data-id')) || (target.matches('#main header') ? extractJid(document.querySelector('#main [data-id]')?.getAttribute('data-id')) : '');
      const name = label.getAttribute('title');
      if (jid && name && remembered.get(jid) !== name) {
        remembered.set(jid, name);
        chrome.runtime.sendMessage({ action: 'CONTACT', jid, name }).then(result => {
          if (result?.data?.saved) refresh();
          else if (result?.error) remembered.delete(jid);
        }).catch(() => {});
      }
      const match = AsistoMatch.matchContact(chats, { jid, name });
      let button = target.querySelector('.asisto-task-badge');
      if (!match) { button?.remove(); continue; }
      if (!button) {
        button = document.createElement('button'); button.className = 'asisto-task-badge'; button.type = 'button'; button.dataset.asistoOwned = '1';
        button.addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation();
          if (!event.isTrusted) return;
          chrome.runtime.sendMessage({ action: 'OPEN', jid: button.dataset.jid, name: button.dataset.name }).catch(() => {});
        });
        label.insertAdjacentElement('afterend', button);
      }
      button.dataset.jid = match.jid; button.dataset.name = match.name;
      button.textContent = '✓ ' + match.count;
      button.title = `Asisto: ${match.count} tarea${match.count === 1 ? '' : 's'}. Revisar resumen`;
      button.setAttribute('aria-label', button.title); retained.add(button);
    }
    document.querySelectorAll('.asisto-task-badge').forEach(button => { if (!retained.has(button)) button.remove(); });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['title', 'data-id'] });
  }
  const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(update, 180); });
  async function refresh() {
    try { const result = await chrome.runtime.sendMessage({ action: 'INDEX' }); if (owner !== result?.data?.owner) remembered.clear(); owner = result?.data?.owner || ''; chats = result?.data?.chats || []; }
    catch { chats = []; if (!chrome.runtime?.id) stopped = true; }
    update();
  }
  refresh(); const interval = setInterval(() => { if (stopped) clearInterval(interval); else refresh(); }, 30000);
})();
