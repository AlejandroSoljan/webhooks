  const oldDoc = settings.findOne({ _id: "behavior" });
  const key = `behavior:${TENANT_ID}`;
  if (oldDoc) {
    const { _id, ...rest } = oldDoc;
    const newDoc = { ...rest, _id: key, tenantId: TENANT_ID, updatedAt: new Date() };
    await settings.replaceOne({ _id: key }, newDoc, { upsert: true });
    await settings.deleteOne({ _id: "behavior" });
    console.log(`✔ settings: renombrado "behavior" -> "${key}"`);
  } else {
    await settings.updateOne(
      { _id: key },
      { $setOnInsert: { text: "Sos un asistente claro, amable y conciso. Respondé en español.", updatedAt: new Date(), tenantId: TENANT_ID } },
      { upsert: true }
    );
    console.log(`ℹ settings: no había "behavior", se aseguró "${key}"`);
  }

  // Índices
  await db.collection("products").createIndexes([
    { key: { tenantId: 1, active: 1, createdAt: -1 }, name: "products_tenant_active_createdAt" },
    { key: { tenantId: 1, descripcion: 1 },          name: "products_tenant_descripcion" },
    { key: { tenantId: 1, updatedAt: -1 },           name: "products_tenant_updatedAt" }
  ]);
  await db.collection("conversations").createIndexes([
    { key: { tenantId: 1, waId: 1, status: 1 }, name: "conversations_tenant_wa_status" },
    { key: { tenantId: 1, openedAt: -1 },       name: "conversations_tenant_openedAt" },
    { key: { tenantId: 1, processed: 1, openedAt: -1 }, name: "conversations_tenant_processed_openedAt" }
  ]);
  await db.collection("messages").createIndexes([
    { key: { conversationId: 1, ts: 1 }, name: "messages_conversation_ts" },
    { key: { tenantId: 1, ts: -1 },      name: "messages_tenant_ts" }
  ]);
  try {
    await db.collection("messages").createIndex({ expireAt: 1 }, { name: "messages_expireAt_TTL", expireAfterSeconds: 0 });
  } catch (e) {
    console.warn("TTL messages.expireAt:", e.message);
  }
  await db.collection("orders").createIndexes([
    { key: { conversationId: 1 }, name: "orders_conversationId" },
    { key: { tenantId: 1, processed: 1, createdAt: -1 }, name: "orders_tenant_processed_createdAt" }
  ]);
  await db.collection("settings").createIndexes([
    { key: { tenantId: 1 }, name: "settings_tenant" }
  ]);

  await client.close();
  console.log("✅ Migración completada");
}

run().catch(e => { console.error(e); process.exit(1); });
