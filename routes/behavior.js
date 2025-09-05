// routes/behavior.js
const express = require("express");
const { getBehaviorUI, getBehavior, saveBehavior } = require("../services/behaviorService");

const router = express.Router();

router.get("/comportamiento", getBehaviorUI);
router.get("/api/behavior", getBehavior);
router.post("/api/behavior", saveBehavior);

module.exports = router;
