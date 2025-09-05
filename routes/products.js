const express = require('express');
const { getDb } = require('../services/db');
const { ObjectId } = require('mongodb');
const router = express.Router();

router.get('/api/products', async (_req,res)=>{
  const db = await getDb();
  const list = await db.collection('products').find({}).sort({ createdAt:-1 }).toArray();
  res.json(list.map(x=>({ ...x, _id: x._id.toString() })));
});

module.exports = router;
