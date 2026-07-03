const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { emitToUser } = require("../realtime");

const router = express.Router();

const DAY_MS = 24 * 60 * 60 * 1000;

function getUser(id) {
  return db.prepare("SELECT id, name, handle, avatar FROM users WHERE id = ?").get(id);
}

function computeStreak(userA, userB) {
  const rows = db
    .prepare(
      `SELECT DISTINCT (created_at / ?) as day FROM messages
       WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
       ORDER BY day DESC`
    )
    .all(DAY_MS, userA, userB, userB, userA)
    .map((r) => Math.floor(r.day));

  if (rows.length === 0) return { streak: 0, expiring: false };

  const today = Math.floor(Date.now() / DAY_MS);
  if (rows[0] < today - 1) return { streak: 0, expiring: false };

  let streak = 1;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1] - rows[i] === 1) streak++;
    else break;
  }
  const expiring = rows[0] === today - 1;
  return { streak, expiring };
}

function formatTime(ts) {
  const diffMin = (Date.now() - ts) / 60000;
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${Math.round(diffMin)}m`;
  if (diffMin < 1440) return `${Math.round(diffMin / 60)}h`;
  return `${Math.round(diffMin / 1440)}d`;
}

router.get("/conversations", requireAuth, (req, res) => {
  const partnerIds = db
    .prepare(
      `SELECT DISTINCT CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END as other
       FROM messages WHERE sender_id = ? OR receiver_id = ?`
    )
    .all(req.userId, req.userId, req.userId)
    .map((r) => r.other);

  const conversations = partnerIds.map((otherId) => {
    const last = db
      .prepare(
        `SELECT * FROM messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(req.userId, otherId, otherId, req.userId);
    const unreadCount = db
      .prepare("SELECT COUNT(*) as c FROM messages WHERE sender_id = ? AND receiver_id = ? AND read = 0")
      .get(otherId, req.userId).c;
    const { streak, expiring } = computeStreak(req.userId, otherId);
    const user = getUser(otherId);

    return {
      id: otherId,
      name: user.name,
      avatar: user.avatar,
      last: last.sender_id === req.userId ? `You: ${last.text}` : last.text,
      time: formatTime(last.created_at),
      unread: unreadCount > 0,
      streak,
      streakExpiring: expiring,
    };
  });

  conversations.sort((a, b) => Number(b.unread) - Number(a.unread));
  res.json({ conversations });
});

router.get("/:userId", requireAuth, (req, res) => {
  const otherId = Number(req.params.userId);
  const other = getUser(otherId);
  if (!other) return res.status(404).json({ error: "User not found" });

  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
       ORDER BY created_at ASC`
    )
    .all(req.userId, otherId, otherId, req.userId);

  db.prepare("UPDATE messages SET read = 1 WHERE sender_id = ? AND receiver_id = ? AND read = 0").run(
    otherId,
    req.userId
  );

  const messages = rows.map((m) => ({
    id: m.id,
    senderId: m.sender_id,
    receiverId: m.receiver_id,
    text: m.text,
    createdAt: m.created_at,
    mine: m.sender_id === req.userId,
  }));

  res.json({ user: other, messages });
});

router.post("/:userId", requireAuth, (req, res) => {
  const otherId = Number(req.params.userId);
  const other = getUser(otherId);
  if (!other) return res.status(404).json({ error: "User not found" });

  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "Message text is required" });

  const now = Date.now();
  const info = db
    .prepare("INSERT INTO messages (sender_id, receiver_id, text, read, created_at) VALUES (?, ?, ?, 0, ?)")
    .run(req.userId, otherId, text.trim(), now);

  const message = {
    id: info.lastInsertRowid,
    senderId: req.userId,
    receiverId: otherId,
    text: text.trim(),
    createdAt: now,
    mine: false,
  };
  emitToUser(otherId, "message", message);

  res.status(201).json({ message: { ...message, mine: true } });
});

module.exports = router;
