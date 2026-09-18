// Asisto | Version: 5.00.159 | Fecha: 2026-09-18
const { ObjectId } = require('mongodb');

function validProductImageUrl(value) {
  if (value === '') return true;
  if (typeof value !== 'string' || value.length > 1000) return false;
  return /^https:\/\/[^\s<>"']+$/i.test(value)
    || /^\/resto\/image\/[a-f\d]{24}$/.test(value)
    || /^\/static\/restaurant_demo\/[a-z0-9_-]+\.webp$/.test(value);
}

function mountProductImageRoutes(app, { getDb, resolveTenantId, express }) {
  app.post('/api/products/images', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '2mb' }), async (req, res) => {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ error: 'dominio_requerido' });
    const contentType = String(req.headers['content-type'] || '').split(';')[0];
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType) || !Buffer.isBuffer(req.body) || req.body.length < 12 || req.body.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'imagen_invalida' });
    const bytes = req.body;
    const signatureOk = contentType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : contentType === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!signatureOk) return res.status(400).json({ error: 'imagen_invalida' });
    const db = await getDb();
    const result = await db.collection('product_images').insertOne({ tenantId, contentType, bytes, createdAt: new Date() });
    res.status(201).json({ url: `/resto/image/${result.insertedId}` });
  });
  app.get('/resto/image/:id', async (req, res) => {
    if (!ObjectId.isValid(req.params.id)) return res.status(404).end();
    const db = await getDb();
    const image = await db.collection('product_images').findOne({ _id: new ObjectId(req.params.id) });
    if (!image) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=604800, immutable').type(image.contentType).send(image.bytes.buffer ? Buffer.from(image.bytes.buffer) : image.bytes);
  });
}

module.exports = { validProductImageUrl, mountProductImageRoutes };
