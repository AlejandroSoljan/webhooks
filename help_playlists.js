const { randomUUID } = require('node:crypto');
const MAX_LIST_LIMIT = 100;

function publicPlaylist(playlist) {
  return {
    id: playlist._id, agente: playlist.agente, nombre: playlist.nombre,
    descripcion: playlist.descripcion, vimeo_ids: playlist.vimeo_ids,
    creada_en: playlist.creada_en
  };
}

// Uses the same integration credential and agent ownership as the Help API.
function mountHelpPlaylists(app, { json, requireAccess, resolveOwner, getDb }) {
  async function handle(req, res, create, mutation) {
    res.set('Cache-Control', 'no-store');
    const edit = mutation === 'edit';
    const input = (create || edit ? req.body : req.query) || {};
    const agent = input?.agente === undefined ? 'MANAGER' : input.agente;
    if (typeof agent !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(agent)) {
      return res.status(400).json({ ok: false, error: 'agente_invalid' });
    }
    const agente = agent.toUpperCase();
    const list = !create && req.params.id === undefined;
    let limit = MAX_LIST_LIMIT, offset = 0;
    if (list) {
      for (const [key, max] of [['limit', MAX_LIST_LIMIT], ['offset', 10000]]) {
        const value = input[key];
        if (value !== undefined && (typeof value !== 'string' || !/^\d{1,5}$/.test(value) ||
            Number(value) > max || (key === 'limit' && Number(value) < 1))) {
          return res.status(400).json({ ok: false, error: `${key}_invalid` });
        }
      }
      limit = Number(input.limit ?? MAX_LIST_LIMIT);
      offset = Number(input.offset ?? 0);
    }
    if (!create && !list && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(req.params.id)) {
      return res.status(400).json({ ok: false, error: 'playlist_id_invalid' });
    }
    const fields = {};
    if (create || edit) {
      if ((create || Object.hasOwn(input, 'nombre')) &&
          (typeof input.nombre !== 'string' || !input.nombre.trim() || input.nombre.length > 200)) {
        return res.status(400).json({ ok: false, error: 'nombre_invalid' });
      }
      if ((create || Object.hasOwn(input, 'descripcion')) &&
          (typeof input.descripcion !== 'string' || !input.descripcion.trim() || input.descripcion.length > 4000)) {
        return res.status(400).json({ ok: false, error: 'descripcion_invalid' });
      }
      if ((create || Object.hasOwn(input, 'vimeo_ids')) &&
          (!Array.isArray(input.vimeo_ids) || input.vimeo_ids.length < 1 || input.vimeo_ids.length > 500 ||
           input.vimeo_ids.some(id => typeof id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(id)))) {
        return res.status(400).json({ ok: false, error: 'vimeo_ids_invalid' });
      }
      for (const key of ['nombre', 'descripcion', 'vimeo_ids']) {
        if (Object.hasOwn(input, key)) fields[key] = input[key];
      }
      if (edit && !Object.keys(fields).length) {
        return res.status(400).json({ ok: false, error: 'playlist_fields_required' });
      }
    }
    try {
      const owner = await resolveOwner(agente, { force: true });
      if (!owner?.domain || owner.enabled !== true) {
        return res.status(403).json({ ok: false, error: 'help_disabled' });
      }
      const db = await getDb();
      const collection = db.collection('help_playlists');
      if (list) {
        const rows = await collection.find({ tenantId: owner.domain, agente })
          .sort({ creada_en: -1, _id: -1 }).skip(offset).limit(limit + 1).toArray();
        return res.json({ ok: true, playlists: rows.slice(0, limit).map(publicPlaylist),
          limit, offset, has_more: rows.length > limit });
      }
      const filter = { _id: req.params.id, tenantId: owner.domain, agente };
      let playlist;
      if (create) {
        await collection.createIndex({ tenantId: 1, agente: 1, creada_en: -1, _id: -1 });
        playlist = {
          _id: randomUUID(), tenantId: owner.domain, agente,
          nombre: input.nombre, descripcion: input.descripcion,
          vimeo_ids: input.vimeo_ids.slice(), creada_en: new Date().toISOString()
        };
        await collection.insertOne(playlist);
      } else if (edit) {
        playlist = await collection.findOneAndUpdate(filter, { $set: fields }, { returnDocument: 'after' });
      } else if (mutation === 'delete') {
        if ((await collection.deleteOne(filter)).deletedCount) return res.status(204).end();
      } else playlist = await collection.findOne(filter);
      if (!playlist) return res.status(404).json({ ok: false, error: 'playlist_not_found' });
      return res.status(create ? 201 : 200).json({ ok: true, ...publicPlaylist(playlist) });
    } catch {
      return res.status(500).json({ ok: false, error: 'playlist_internal_error' });
    }
  }
  app.post('/api/ext/ayuda/playlists', requireAccess, json, (req, res) => handle(req, res, true));
  app.get('/api/ext/ayuda/playlists', requireAccess, (req, res) => handle(req, res, false));
  app.get('/api/ext/ayuda/playlists/:id', requireAccess, (req, res) => handle(req, res, false));
  app.patch('/api/ext/ayuda/playlists/:id', requireAccess, json, (req, res) => handle(req, res, false, 'edit'));
  app.delete('/api/ext/ayuda/playlists/:id', requireAccess, (req, res) => handle(req, res, false, 'delete'));
  app.post('/api/ext/help/playlists', requireAccess, json, (req, res) => handle(req, res, true));
  app.get('/api/ext/help/playlists', requireAccess, (req, res) => handle(req, res, false));
  app.get('/api/ext/help/playlists/:id', requireAccess, (req, res) => handle(req, res, false));
  app.patch('/api/ext/help/playlists/:id', requireAccess, json, (req, res) => handle(req, res, false, 'edit'));
  app.delete('/api/ext/help/playlists/:id', requireAccess, (req, res) => handle(req, res, false, 'delete'));
}

module.exports = { mountHelpPlaylists };
