// Asisto | Version: 5.00.070 | Fecha: 2026-09-09
(() => {
  const SOURCE = 'asisto-whatsapp-contacts-v1';
  async function readContacts() {
    const databases = await indexedDB.databases();
    if (!databases.some(database => database.name === 'model-storage')) return [];
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('model-storage');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const wid = value => typeof value === 'string' ? value : value?._serialized || (value?.user && value?.server ? value.user + '@' + value.server : '');
      const scan = (store, select) => {
        if (!db.objectStoreNames.contains(store)) return Promise.resolve([]);
        return new Promise((resolve, reject) => {
          const rows = [], request = db.transaction(store, 'readonly').objectStore(store).openCursor();
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return resolve(rows);
            const selected = select(cursor.value || {}, cursor.primaryKey);
            if (selected) rows.push(selected);
            cursor.continue();
          };
          request.onerror = () => reject(request.error);
        });
      };
      const [people, groups] = await Promise.all([
        scan('contact', row => {
          const name = row.name || row.shortName || row.pushname || row.verifiedName;
          const aliases = [row.id, row.phoneNumber].map(value => wid(value).replace(/@c\.us$/, '@s.whatsapp.net')).filter(value => /^\d+@(s\.whatsapp\.net|lid)$/.test(value));
          return name && aliases.length ? { name: String(name).slice(0, 200), aliases: [...new Set(aliases)] } : null;
        }),
        scan('chat', (row, key) => {
          const jid = wid(row.id) || wid(key), name = row.subject || row.groupMetadata?.subject || row.name || row.formattedTitle || row.contact?.name;
          return name && /^\d+(?:-\d+)?@g\.us$/.test(jid) ? { name: String(name).slice(0, 200), aliases: [jid] } : null;
        })
      ]);
      return [...people, ...groups];
    } finally { db.close(); }
  }
  let contactsReady = false, cachedContacts = [];
  function publishContacts() {
    if (!contactsReady) return;
    for (let offset = 0; offset < cachedContacts.length; offset += 500) window.postMessage({ source: SOURCE, contacts: cachedContacts.slice(offset, offset + 500) }, location.origin);
    window.postMessage({ source: SOURCE, complete: true }, location.origin);
  }
  window.addEventListener('message', event => {
    if (event.source === window && event.origin === location.origin && event.data?.source === SOURCE && event.data.request === true) publishContacts();
  });
  readContacts().then(contacts => { cachedContacts = contacts; contactsReady = true; publishContacts(); }).catch(() => { contactsReady = true; publishContacts(); });
})();
