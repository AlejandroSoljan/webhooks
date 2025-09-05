// routes/webhook.js
const express = require("express");
const { handleWebhookGet, handleWebhookPost } = require("../services/webhookService");

const router = express.Router();

router.get("/webhook", handleWebhookGet);
router.post("/webhook", handleWebhookPost);

module.exports = router;
