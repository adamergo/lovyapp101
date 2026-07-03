const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { createNotification } = require("../helpers/notify");
const { emitToUser } = require("../realtime");
const { computeAffinity } = require("../helpers/affinity");

const router = express.Router();

// Reels "For You" ranking: blends recency, engagement, and the viewer's affinity
// toward the creator (same shape as the posts algorithm) so the reel feed adapts
// per-viewer instead of being one global chronological list.
function scoreSnap(stats) {
  const recencyScore = 12 / (stats.hoursAgo + 2);
  const engagement = stats.likes * 1 + stats.comments * 2 + stats.reposts * 2 + stats.shares * 3 + stats.views * 0.02;
  const engagementScore = Math.log(engagement + 1) * 1.5;
  const affinityScore = stats.affinity * 10;
  return recencyScore + engagementScore + affinityScore;
}

function getUser(id) {
  return db.prepare("SELECT id, name, handle, avatar FROM users WHERE id = ?").get(id);
}

function formatViews(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

function countFor(table, snapId) {
  return db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE snap_id = ?`).get(snapId).c;
}

function serializeSnap(row, viewerId, mode) {
  const author = getUser(row.user_id);
  const likes = countFor("snap_likes", row.id);
  const comments = countFor("snap_comments", row.id);
  const reposts = countFor("snap_reposts", row.id);
  const shares = countFor("snap_shares", row.id);
  const liked = !!db.prepare("SELECT 1 FROM snap_likes WHERE snap_id = ? AND user_id = ?").get(row.id, viewerId);
  const reposted = !!db.prepare("SELECT 1 FROM snap_reposts WHERE snap_id = ? AND user_id = ?").get(row.id, viewerId);
  const hoursAgo = (Date.now() - row.created_at) / 3600000;
  const affinity = computeAffinity(viewerId, row.user_id);

  const engagement = likes + comments * 2 + reposts * 2 + shares * 3;
  let badge = null;
  if (mode !== "recent") {
    if (affinity >= 0.7) badge = { label: "Close Friend", icon: "uil-users-alt" };
    else if (engagement >= 300 || row.views >= 15000) badge = { label: "Trending", icon: "uil-fire" };
    else if (hoursAgo <= 1) badge = { label: "New", icon: "uil-bolt" };
  }

  return {
    id: row.id,
    author: author ? author.name : "Unknown",
    authorId: row.user_id,
    avatar: author ? author.avatar : "",
    thumb: row.thumb,
    title: row.title,
    type: row.type || "image",
    views: formatViews(row.views),
    likes,
    comments,
    reposts,
    shares,
    liked,
    reposted,
    affinity,
    hoursAgo,
    badge,
  };
}

router.get("/", requireAuth, (req, res) => {
  const mode = req.query.mode === "recent" ? "recent" : "fyp";
  const rows = db.prepare("SELECT * FROM snaps ORDER BY created_at DESC").all();
  const snaps = rows.map((r) => serializeSnap(r, req.userId, mode));

  if (mode === "fyp") {
    const rawStats = rows.map((r) => ({
      hoursAgo: (Date.now() - r.created_at) / 3600000,
      likes: countFor("snap_likes", r.id),
      comments: countFor("snap_comments", r.id),
      reposts: countFor("snap_reposts", r.id),
      shares: countFor("snap_shares", r.id),
      views: r.views,
      affinity: computeAffinity(req.userId, r.user_id),
    }));
    const scored = rows.map((r, i) => ({ id: r.id, score: scoreSnap(rawStats[i]) }));
    const scoreById = new Map(scored.map((s) => [s.id, s.score]));
    snaps.sort((a, b) => scoreById.get(b.id) - scoreById.get(a.id));
  }

  res.json({ snaps });
});

router.post("/", requireAuth, (req, res) => {
  const { thumb, title, type } = req.body || {};
  if (!thumb || !title) return res.status(400).json({ error: "Reel needs a video/image and a title" });
  const snapType = type === "video" ? "video" : "image";
  const info = db
    .prepare("INSERT INTO snaps (user_id, thumb, title, views, type, created_at) VALUES (?, ?, ?, 0, ?, ?)")
    .run(req.userId, thumb, title, snapType, Date.now());
  const row = db.prepare("SELECT * FROM snaps WHERE id = ?").get(info.lastInsertRowid);
  res.status(201).json({ snap: serializeSnap(row, req.userId, "recent") });
});

router.post("/:id/view", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  db.prepare("UPDATE snaps SET views = views + 1 WHERE id = ?").run(id);
  const row = db.prepare("SELECT * FROM snaps WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "Snap not found" });
  res.json({ snap: serializeSnap(row, req.userId) });
});

router.post("/:id/like", requireAuth, (req, res) => {
  const snapId = Number(req.params.id);
  const snap = db.prepare("SELECT * FROM snaps WHERE id = ?").get(snapId);
  if (!snap) return res.status(404).json({ error: "Snap not found" });

  const existing = db.prepare("SELECT 1 FROM snap_likes WHERE snap_id = ? AND user_id = ?").get(snapId, req.userId);
  if (existing) {
    db.prepare("DELETE FROM snap_likes WHERE snap_id = ? AND user_id = ?").run(snapId, req.userId);
  } else {
    db.prepare("INSERT INTO snap_likes (snap_id, user_id, created_at) VALUES (?, ?, ?)").run(snapId, req.userId, Date.now());
    createNotification({
      userId: snap.user_id,
      actorId: req.userId,
      type: "like",
      postId: null,
      text: `${getUser(req.userId).name} liked your snap`,
    });
  }

  const row = db.prepare("SELECT * FROM snaps WHERE id = ?").get(snapId);
  res.json({ snap: serializeSnap(row, req.userId) });
});

router.post("/:id/comments", requireAuth, (req, res) => {
  const snapId = Number(req.params.id);
  const snap = db.prepare("SELECT * FROM snaps WHERE id = ?").get(snapId);
  if (!snap) return res.status(404).json({ error: "Snap not found" });

  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "Comment text is required" });

  db.prepare("INSERT INTO snap_comments (snap_id, user_id, text, created_at) VALUES (?, ?, ?, ?)").run(
    snapId,
    req.userId,
    text.trim(),
    Date.now()
  );

  createNotification({
    userId: snap.user_id,
    actorId: req.userId,
    type: "comment",
    postId: null,
    text: `${getUser(req.userId).name} commented on your snap: "${text.trim().slice(0, 60)}"`,
  });

  const row = db.prepare("SELECT * FROM snaps WHERE id = ?").get(snapId);
  res.status(201).json({ snap: serializeSnap(row, req.userId) });
});

router.post("/:id/repost", requireAuth, (req, res) => {
  const snapId = Number(req.params.id);
  const snap = db.prepare("SELECT * FROM snaps WHERE id = ?").get(snapId);
  if (!snap) return res.status(404).json({ error: "Snap not found" });

  const existing = db.prepare("SELECT 1 FROM snap_reposts WHERE snap_id = ? AND user_id = ?").get(snapId, req.userId);
  if (existing) {
    db.prepare("DELETE FROM snap_reposts WHERE snap_id = ? AND user_id = ?").run(snapId, req.userId);
  } else {
    db.prepare("INSERT INTO snap_reposts (snap_id, user_id, created_at) VALUES (?, ?, ?)").run(snapId, req.userId, Date.now());
    createNotification({
      userId: snap.user_id,
      actorId: req.userId,
      type: "repost",
      postId: null,
      text: `${getUser(req.userId).name} reposted your snap`,
    });
  }

  const row = db.prepare("SELECT * FROM snaps WHERE id = ?").get(snapId);
  res.json({ snap: serializeSnap(row, req.userId) });
});

router.post("/:id/share", requireAuth, (req, res) => {
  const snapId = Number(req.params.id);
  const snap = db.prepare("SELECT * FROM snaps WHERE id = ?").get(snapId);
  if (!snap) return res.status(404).json({ error: "Snap not found" });

  const { toUserId } = req.body || {};
  db.prepare("INSERT INTO snap_shares (snap_id, user_id, to_user_id, created_at) VALUES (?, ?, ?, ?)").run(
    snapId,
    req.userId,
    toUserId || null,
    Date.now()
  );

  if (toUserId) {
    const sharer = getUser(req.userId);
    const messageText = `${sharer.name} shared a snap with you: ${snap.title}`;
    const info = db
      .prepare("INSERT INTO messages (sender_id, receiver_id, text, read, created_at) VALUES (?, ?, ?, 0, ?)")
      .run(req.userId, toUserId, messageText, Date.now());
    emitToUser(Number(toUserId), "message", {
      id: info.lastInsertRowid,
      senderId: req.userId,
      receiverId: Number(toUserId),
      text: messageText,
      createdAt: Date.now(),
    });
  }

  const row = db.prepare("SELECT * FROM snaps WHERE id = ?").get(snapId);
  res.json({ snap: serializeSnap(row, req.userId) });
});

module.exports = router;
