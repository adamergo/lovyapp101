const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { serializeNotification } = require("../helpers/notify");

const router = express.Router();

router.get("/", requireAuth, (req, res) => {
  const rows = db
    .prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30")
    .all(req.userId);
  const notifications = rows
    .map(serializeNotification)
    .sort((a, b) => Number(b.unread) - Number(a.unread));
  res.json({ notifications });
});

router.post("/:id/read", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  db.prepare("UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?").run(id, req.userId);
  res.json({ ok: true });
});

router.post("/read-all", requireAuth, (req, res) => {
  db.prepare("UPDATE notifications SET read = 1 WHERE user_id = ?").run(req.userId);
  res.json({ ok: true });
});

module.exports = router;
