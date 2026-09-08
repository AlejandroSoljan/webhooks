// Asisto | Version: 5.00.068 | Fecha: 2026-09-08
(function(root) {
  const normalize = value => String(value || '').normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
  function matchContact(chats, { jid = '', name = '' }) {
    const phone = /^[+\d\s().-]{7,}$/.test(name) ? name.replace(/\D/g, '') + '@s.whatsapp.net' : '';
    const identity = jid || phone;
    const exact = identity ? chats.filter(chat => chat.jid === identity || chat.aliases?.includes(identity)) : [];
    if (identity && !exact.length) return null;
    const candidates = exact.length ? exact : chats.filter(chat => name && normalize(chat.name) === normalize(name));
    if (!candidates.length) return null;
    // LID/phone aliases can represent the same contact. Equal names alone cannot.
    const first = candidates[0], aliases = new Set([first.jid, ...(first.aliases || [])]);
    if (candidates.some(chat => !aliases.has(chat.jid) && !chat.aliases?.some(alias => aliases.has(alias)))) return null;
    return { jid: first.jid, name: first.name, count: candidates.reduce((sum, chat) => sum + chat.count, 0) };
  }
  root.AsistoMatch = { matchContact };
  if (typeof module !== 'undefined') module.exports = root.AsistoMatch;
})(globalThis);
