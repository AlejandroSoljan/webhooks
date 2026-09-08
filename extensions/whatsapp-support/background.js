// Asisto | Version: 5.00.069 | Fecha: 2026-09-08
const BASE = 'https://asistobot.com.ar/api/support/extension';
async function request(path, body, grant) {
  const response = await fetch(BASE + path, { credentials: 'include', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000), headers: {
    'X-Asisto-Extension-Id': chrome.runtime.id, ...(body ? { 'Content-Type': 'application/json', 'X-Asisto-Extension': grant } : {}),
  }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('authentication_required');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'request_failed');
  return result;
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const fromWhatsApp = sender.tab && sender.url?.startsWith('https://web.whatsapp.com/');
  const fromPanel = sender.url === chrome.runtime.getURL('panel.html');
  if (sender.id !== chrome.runtime.id || (!fromWhatsApp && !fromPanel)) return false;
  if (message.action === 'OPEN' && fromWhatsApp) {
    // Called immediately inside the click message to preserve Chrome's user gesture.
    const opened = chrome.sidePanel.open({ tabId: sender.tab.id });
    Promise.all([opened, chrome.storage.session.set({ ['selection-' + sender.tab.id]: { jid: String(message.jid || ''), name: String(message.name || '') } })]).then(() => reply({ ok: true }), () => reply({ error: 'panel_open_failed' }));
    return true;
  }
  if (fromWhatsApp && !['INDEX', 'CONTACT'].includes(message.action)) return false;
  (async () => {
    const session = await request('/session');
    if (message.action === 'SESSION') return { ...session, csrf: undefined };
    if (message.action === 'INDEX') return { ...await request('/index'), owner: session.tenantId + ':' + session.userId };
    if (message.owner && message.owner !== session.tenantId + ':' + session.userId) throw new Error('account_changed');
    const id = encodeURIComponent(String(message.id || ''));
    switch (message.action) {
      case 'CONTACT': return request('/contact', { jid: String(message.jid || ''), name: String(message.name || '') }, session.csrf);
      case 'DRAFTS': return request('/drafts?jid=' + encodeURIComponent(String(message.jid || '')));
      case 'DETAIL': return request('/drafts/' + id);
      case 'SAVE': return request('/drafts/' + id + '/save', { revision: message.revision, fields: message.fields }, session.csrf);
      case 'HUBSPOT': return request('/hubspot');
      case 'CONNECT': return request('/hubspot/connect', { token: message.token }, session.csrf);
      case 'PUBLISH': return request('/drafts/' + id + '/publish', { revision: message.revision, mapping: message.mapping }, session.csrf);
      default: throw new Error('invalid_action');
    }
  })().then(data => reply({ data }), error => reply({ error: error.message === 'Failed to fetch' ? 'connection_failed' : error.message }));
  return true;
});
chrome.action.onClicked.addListener(tab => { if (tab.id) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {}); });
