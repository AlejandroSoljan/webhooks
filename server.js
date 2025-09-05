// server.js
const express = require("express");
require("dotenv").config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static
app.use("/public", express.static("public"));

// Rutas
const webhookRoutes = require("./routes/webhook");
const adminRoutes = require("./routes/admin");
const behaviorRoutes = require("./routes/behavior");

app.use("/", webhookRoutes);
app.use("/", adminRoutes);
app.use("/", behaviorRoutes);

// Error global
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor en http://localhost:${PORT}`));
