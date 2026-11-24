// Asisto | Version: 5.00.294 | Fecha: 2026-10-15
(function(root) {
  const normalize = value => String(value || '').normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
  const displayName = value => normalize(normalize(value).replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D]/gu, ''));
  function indexContacts(chats) {
    const byJid = new Map(), byName = new Map(), byDisplayName = new Map();
    const add = (map, key, chat) => { if (!key) return; if (!map.has(key)) map.set(key, []); map.get(key).push(chat); };
    for (const chat of chats) {
      for (const alias of new Set([chat.jid, ...(chat.aliases || [])])) add(byJid, alias, chat);
      add(byName, normalize(chat.name), chat);
      add(byDisplayName, displayName(chat.name), chat);
    }
    return { byJid, byName, byDisplayName };
  }
  function matchContact(chats, { jid = '', name = '' }) {
    const phone = /^[+\d\s().-]{7,}$/.test(name) ? name.replace(/\D/g, '') + '@s.whatsapp.net' : '';
    const identity = jid || phone;
    const indexed = !Array.isArray(chats);
    const exact = identity ? (indexed ? chats.byJid.get(identity) || [] : chats.filter(chat => chat.jid === identity || chat.aliases?.includes(identity))) : [];
    if (identity && !exact.length) return null;
    let candidates = exact.length ? exact : (indexed ? (name ? chats.byName.get(normalize(name)) || [] : []) : chats.filter(chat => name && normalize(chat.name) === normalize(name)));
    const plainName = displayName(name);
    if (!identity && plainName && (!candidates.length || plainName === normalize(name))) {
      candidates = indexed ? chats.byDisplayName.get(plainName) || [] : chats.filter(chat => displayName(chat.name) === plainName);
    }
    if (!candidates.length) return null;
    // LID/phone aliases can represent the same contact. Equal names alone cannot.
    const first = candidates[0], aliases = new Set([first.jid, ...(first.aliases || [])]);
    if (candidates.some(chat => !aliases.has(chat.jid) && !chat.aliases?.some(alias => aliases.has(alias)))) return null;
    return { jid: first.jid, name: first.name, count: candidates.reduce((sum, chat) => sum + chat.count, 0) };
  }
  root.AsistoMatch = { matchContact, indexContacts };
  if (typeof module !== 'undefined') module.exports = root.AsistoMatch;
})(globalThis);
