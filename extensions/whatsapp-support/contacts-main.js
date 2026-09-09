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
      if (!db.objectStoreNames.contains('contact')) return [];
      return await new Promise((resolve, reject) => {
        const contacts = [], request = db.transaction('contact', 'readonly').objectStore('contact').openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return resolve(contacts);
          const row = cursor.value || {}, name = row.name || row.shortName || row.pushname || row.verifiedName;
          const aliases = [row.id, row.phoneNumber].map(value => String(value || '').replace(/@c\.us$/, '@s.whatsapp.net')).filter(value => /^\d+@(s\.whatsapp\.net|lid)$/.test(value));
          if (name && aliases.length) contacts.push({ name: String(name).slice(0, 200), aliases: [...new Set(aliases)] });
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }
  readContacts().then(contacts => {
    for (let offset = 0; offset < contacts.length; offset += 500) window.postMessage({ source: SOURCE, contacts: contacts.slice(offset, offset + 500) }, location.origin);
    window.postMessage({ source: SOURCE, complete: true }, location.origin);
  }).catch(() => window.postMessage({ source: SOURCE, complete: true }, location.origin));
})();
