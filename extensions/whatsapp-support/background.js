// Asisto | Version: 5.00.130 | Fecha: 2026-09-10
const BASE = 'https://asistobot.com.ar/api/support/extension';
const LOCAL = 'http://127.0.0.1:17658/extension-session';
let deviceToken = '';
async function request(path, body, grant) {
  const response = await fetch(BASE + path, { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000), headers: {
    'X-Asisto-Extension-Id': chrome.runtime.id, ...(deviceToken ? { Authorization: 'Bearer ' + deviceToken } : {}), ...(body ? { 'Content-Type': 'application/json', 'X-Asisto-Extension': grant } : {}),
  }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('authentication_required');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'request_failed');
  return result;
}
async function authenticatedSession() {
  // The local WhatsApp agent owns this workflow. A browser cookie may belong
  // to another tenant and must never select the extension's account.
  deviceToken = '';
    const local = await fetch(LOCAL, { cache: 'no-store', signal: AbortSignal.timeout(5000), headers: { 'X-Asisto-Local': '1', 'X-Asisto-Extension-Id': chrome.runtime.id } });
    if (local.status === 403) throw new Error('agent_access_denied');
    if (!local.ok || !local.headers.get('content-type')?.includes('application/json')) throw new Error('agent_not_authorized');
    const result = await local.json();
    if (!/^[A-Za-z0-9_-]{43}$/.test(result.token || '')) throw new Error('agent_not_authorized');
    deviceToken = result.token;
    return request('/session');
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const fromWhatsApp = sender.tab && sender.url?.startsWith('https://web.whatsapp.com/');
  const fromPanel = sender.url === chrome.runtime.getURL('panel.html');
  if (sender.id !== chrome.runtime.id || (!fromWhatsApp && !fromPanel)) return false;
  if (message.action === 'OPEN' && fromWhatsApp) {
    // Called immediately inside the click message to preserve Chrome's user gesture.
    const opened = chrome.sidePanel.open({ tabId: sender.tab.id });
    Promise.all([opened, chrome.storage.session.set({ ['selection-' + sender.tab.id]: { jid: String(message.jid || ''), name: String(message.name || ''), draftId: String(message.draftId || ''), refreshAt: Date.now() } })]).then(() => reply({ ok: true }), () => reply({ error: 'panel_open_failed' }));
    return true;
  }
  if (fromWhatsApp && !['INDEX', 'CONTACT', 'CONTACTS', 'MESSAGES', 'ASSIGN_MESSAGES', 'ACTIVE_CONTEXT'].includes(message.action)) return false;
  (async () => {
    const session = await authenticatedSession();
    if (message.action === 'SESSION') return { ...session, csrf: undefined };
    if (message.action === 'INDEX') {
      if (sender.tab?.id) chrome.sidePanel.setOptions?.({ tabId: sender.tab.id, path: 'panel.html', enabled: true }).catch(() => {});
      return { ...await request('/index'), owner: session.tenantId + ':' + session.userId };
    }
    if (message.action === 'ACTIVE_CONTEXT' && sender.tab?.id) {
      const key = 'selection-' + sender.tab.id, stored = await chrome.storage.session.get(key);
      return stored[key] || null;
    }
    if (message.owner && message.owner !== session.tenantId + ':' + session.userId) throw new Error('account_changed');
    const id = encodeURIComponent(String(message.id || ''));
    switch (message.action) {
      case 'CONTACT_CONTROL': return request('/contact-control?q=' + encodeURIComponent(String(message.query || '')));
      case 'SET_CONTACT_CONTROL': return request('/contact-control', { jid: String(message.jid || ''), excluded: message.excluded === true }, session.csrf);
      case 'CONTACT': return request('/contact', { jid: String(message.jid || ''), name: String(message.name || '') }, session.csrf);
      case 'CONTACTS': return request('/contacts', { contacts: Array.isArray(message.contacts) ? message.contacts : [] }, session.csrf);
      case 'DRAFTS': return request('/drafts?jid=' + encodeURIComponent(String(message.jid || '')));
      case 'MESSAGES': return request('/messages?jid=' + encodeURIComponent(String(message.jid || '')));
      case 'ASSIGN_MESSAGES': return request('/messages/assign', { jid: String(message.jid || ''), messageIds: Array.isArray(message.messageIds) ? message.messageIds : [], selectedMessages: Array.isArray(message.selectedMessages) ? message.selectedMessages : [], destination: String(message.destination || ''), existingAction: String(message.existingAction || ''), reassign: message.reassign === true, duplicate: message.duplicate === true }, session.csrf);
      case 'DETAIL': return request('/drafts/' + id);
      case 'SAVE': return request('/drafts/' + id + '/save', { revision: message.revision, fields: message.fields }, session.csrf);
      case 'RECONCILE': return request('/drafts/' + id + '/reconcile', { revision: message.revision, fields: message.fields }, session.csrf);
      case 'QUEUE': return request('/drafts/' + id + '/queue', { revision: message.revision }, session.csrf);
      case 'MANUAL_HUBSPOT': {
        const job = { id: message.id, revision: message.revision, fields: message.fields, owner: session.tenantId + ':' + session.userId, createdAt: Date.now() };
        await chrome.storage.session.set({ hubspotManualJob: job });
        const tabs = await chrome.tabs.query({ url: 'https://app.hubspot.com/*' });
        if (tabs[0]?.id) {
          await chrome.tabs.update(tabs[0].id, { active: true }); await chrome.windows.update(tabs[0].windowId, { focused: true });
          await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, files: ['hubspot-ui.js'] });
        }
        else await chrome.tabs.create({ url: 'https://app.hubspot.com/contacts/', active: true });
        return { started: true };
      }
      case 'DISMISS': return request('/drafts/' + id + '/dismiss', { revision: message.revision }, session.csrf);
      case 'HUBSPOT': return request('/hubspot');
      case 'HUBSPOT_SEARCH': return request('/hubspot/search?type=' + encodeURIComponent(String(message.type || '')) + '&q=' + encodeURIComponent(String(message.query || '')));
      case 'CONNECT': return request('/hubspot/connect', { token: message.token }, session.csrf);
      case 'PUBLISH': return request('/drafts/' + id + '/publish', { revision: message.revision, mapping: message.mapping }, session.csrf);
      default: throw new Error('invalid_action');
    }
  })().then(data => reply({ data }), error => reply({ error: error.message === 'Failed to fetch' ? 'connection_failed' : error.message }));
  return true;
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith('https://app.hubspot.com/')) return false;
  (async () => {
    const stored = await chrome.storage.session.get('hubspotManualJob'), job = stored.hubspotManualJob;
    if (message.action === 'HUBSPOT_UI_READY') return job && Date.now() - job.createdAt < 15 * 60 * 1000 ? job : null;
    if (message.action === 'HUBSPOT_UI_COMPLETE' && job && message.id === job.id) {
      const session = await authenticatedSession();
      const result = await request('/drafts/' + encodeURIComponent(job.id) + '/manual-complete', { revision: job.revision, ticketId: String(message.ticketId || 'manual') }, session.csrf);
      await chrome.storage.session.remove('hubspotManualJob');
      return result;
    }
    if (message.action === 'HUBSPOT_UI_FAILED' && job) { await chrome.storage.session.set({ hubspotManualResult: { error: String(message.error || 'No se pudo completar HubSpot'), at: Date.now() } }); await chrome.storage.session.remove('hubspotManualJob'); return { saved: false }; }
    return null;
  })().then(data => reply({ data }), error => reply({ error: error.message }));
  return true;
});
chrome.action.onClicked.addListener(tab => { if (tab.id) { chrome.sidePanel.setOptions?.({ tabId: tab.id, path: 'panel.html', enabled: true }).catch(() => {}); chrome.sidePanel.open({ tabId: tab.id }).catch(() => {}); } });
