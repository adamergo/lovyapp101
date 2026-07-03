const db = require("../db");
const { emitToUser } = require("../realtime");

function iconForType(type) {
  switch (type) {
    case "like":
      return "uil-heart";
    case "comment":
      return "uil-comment-dots";
    case "follow":
      return "uil-user-plus";
    case "save":
      return "uil-bookmark";
    case "mention":
      return "uil-at";
    case "repost":
      return "uil-repeat";
    default:
      return "uil-bell";
  }
}

function serializeNotification(n) {
  const actor = n.actor_id ? db.prepare("SELECT id, name, avatar FROM users WHERE id = ?").get(n.actor_id) : null;
  return {
    id: n.id,
    icon: iconForType(n.type),
    text: n.text,
    unread: !n.read,
    createdAt: n.created_at,
    actor,
    postId: n.post_id,
  };
}

function createNotification({ userId, actorId, type, postId, text }) {
  if (userId === actorId) return null;
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO notifications (user_id, actor_id, type, post_id, text, read, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)`
    )
    .run(userId, actorId || null, type, postId || null, text, now);
  const notif = db.prepare("SELECT * FROM notifications WHERE id = ?").get(info.lastInsertRowid);
  const serialized = serializeNotification(notif);
  emitToUser(userId, "notification", serialized);
  return serialized;
}

module.exports = { createNotification, serializeNotification };
