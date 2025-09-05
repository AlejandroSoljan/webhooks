// routes/admin.js
const express = require("express");
const {
  renderAdminUI,
  getConversations,
  getMessages,
  getOrder,
  processOrder,
  printTicket,
} = require("../services/adminService");

const router = express.Router();

router.get("/admin", renderAdminUI);
router.get("/api/admin/conversations", getConversations);
router.get("/api/admin/messages/:id", getMessages);
router.get("/api/admin/order/:id", getOrder);
router.post("/api/admin/order/:id/process", processOrder);
router.get("/admin/print/:id", printTicket);

module.exports = router;
