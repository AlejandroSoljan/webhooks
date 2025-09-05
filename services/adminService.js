// services/adminService.js
async function renderAdminUI(req, res) {
  res.send("<h1>Admin UI</h1>");
}

async function getConversations(req, res) {
  res.json([]);
}

async function getMessages(req, res) {
  res.json([]);
}

async function getOrder(req, res) {
  res.json({});
}

async function processOrder(req, res) {
  res.json({ success: true });
}

async function printTicket(req, res) {
  res.send("Imprimiendo ticket...");
}

module.exports = {
  renderAdminUI,
  getConversations,
  getMessages,
  getOrder,
  processOrder,
  printTicket,
};
