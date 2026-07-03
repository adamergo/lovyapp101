const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { createNotification } = require("../helpers/notify");
const { computeAffinity } = require("../helpers/affinity");

const router = express.Router();

function getUser(id) {
  return db.prepare("SELECT id, name, handle, avatar FROM users WHERE id = ?").get(id);
}

function countFor(table, postId) {
  return db.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE post_id = ?`).get(postId).c;
}

function scorePost(stats) {
  const recencyScore = 12 / (stats.hoursAgo + 2);
  const engagement = stats.likes + stats.comments * 2 + stats.shares * 3;
  const engagementScore = Math.log(engagement + 1) * 1.5;
  const affinityScore = stats.affinity * 10;
  return recencyScore + engagementScore + affinityScore;
}

function rankReason(stats) {
  if (stats.affinity >= 0.7) return { label: "Close Friend", icon: "uil-users-alt" };
  const engagement = stats.likes + stats.comments * 2 + stats.shares * 3;
  if (engagement >= 500) return { label: "Trending", icon: "uil-fire" };
  if (stats.hoursAgo <= 1) return { label: "New", icon: "uil-bolt" };
  return null;
}

function serializeQuoted(postId) {
  if (!postId) return null;
  const row = db.prepare("SELECT * FROM posts WHERE id = ?").get(postId);
  if (!row) return null;
  const author = getUser(row.author_id);
  return {
    id: row.id,
    author: author ? author.name : "Unknown",
    avatar: author ? author.avatar : "",
    image: row.image || "",
    caption: row.caption,
  };
}

function serializePost(row, viewerId, mode) {
  const author = getUser(row.author_id);
  const hoursAgo = (Date.now() - row.created_at) / 3600000;
  const likes = countFor("likes", row.id);
  const comments = countFor("comments", row.id);
  const shares = db.prepare("SELECT COUNT(*) as c FROM shares WHERE post_id = ?").get(row.id).c;
  const reposts = countFor("reposts", row.id);
  const affinity = computeAffinity(viewerId, row.author_id);
  const liked = !!db.prepare("SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?").get(row.id, viewerId);
  const saved = !!db.prepare("SELECT 1 FROM saves WHERE post_id = ? AND user_id = ?").get(row.id, viewerId);
  const reposted = !!db.prepare("SELECT 1 FROM reposts WHERE post_id = ? AND user_id = ?").get(row.id, viewerId);

  const stats = { hoursAgo, likes, comments, shares, affinity };
  const badge = mode === "foryou" || mode === "explore" ? rankReason(stats) : null;

  return {
    id: row.id,
    author: author ? author.name : "Unknown",
    authorId: row.author_id,
    avatar: author ? author.avatar : "",
    image: row.image || "",
    caption: row.caption,
    hoursAgo,
    likes,
    comments,
    shares,
    reposts,
    affinity,
    liked,
    saved,
    reposted,
    quoteOf: row.quote_of,
    quoted: serializeQuoted(row.quote_of),
    badge,
  };
}

function scoreExplore(stats) {
  const recencyScore = 12 / (stats.hoursAgo + 2);
  const engagement = stats.likes + stats.comments * 2 + stats.shares * 3;
  const engagementScore = Math.log(engagement + 1) * 1.5;
  return recencyScore + engagementScore;
}

router.get("/feed", requireAuth, (req, res) => {
  const mode = ["recent", "explore"].includes(req.query.mode) ? req.query.mode : "foryou";

  const rows =
    mode === "explore"
      ? db
          .prepare(
            `SELECT * FROM posts
             WHERE author_id != ? AND author_id NOT IN (SELECT followee_id FROM follows WHERE follower_id = ?)
             ORDER BY created_at DESC`
          )
          .all(req.userId, req.userId)
      : db.prepare("SELECT * FROM posts ORDER BY created_at DESC").all();

  const posts = rows.map((r) => serializePost(r, req.userId, mode));

  if (mode === "recent") {
    posts.sort((a, b) => a.hoursAgo - b.hoursAgo);
  } else if (mode === "explore") {
    posts.sort((a, b) => scoreExplore(b) - scoreExplore(a));
  } else {
    posts.sort((a, b) => scorePost(b) - scorePost(a));
  }

  res.json({ posts });
});

router.get("/bookmarks", requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT posts.* FROM posts
       JOIN saves ON saves.post_id = posts.id
       WHERE saves.user_id = ?
       ORDER BY saves.created_at DESC`
    )
    .all(req.userId);
  res.json({ posts: rows.map((r) => serializePost(r, req.userId, "recent")) });
});

router.post("/", requireAuth, (req, res) => {
  const { caption, image } = req.body || {};
  if (!caption && !image) return res.status(400).json({ error: "Post needs a caption or an image" });

  const info = db
    .prepare(`INSERT INTO posts (author_id, image, caption, quote_of, created_at) VALUES (?, ?, ?, NULL, ?)`)
    .run(req.userId, image || null, caption || "", Date.now());

  const row = db.prepare("SELECT * FROM posts WHERE id = ?").get(info.lastInsertRowid);
  res.status(201).json({ post: serializePost(row, req.userId, "recent") });
});

router.post("/:id/quote", requireAuth, (req, res) => {
  const originalId = Number(req.params.id);
  const original = db.prepare("SELECT * FROM posts WHERE id = ?").get(originalId);
  if (!original) return res.status(404).json({ error: "Post not found" });

  const { caption } = req.body || {};
  if (!caption || !caption.trim()) return res.status(400).json({ error: "Quote needs a comment" });

  const info = db
    .prepare(`INSERT INTO posts (author_id, image, caption, quote_of, created_at) VALUES (?, NULL, ?, ?, ?)`)
    .run(req.userId, caption.trim(), originalId, Date.now());

  createNotification({
    userId: original.author_id,
    actorId: req.userId,
    type: "repost",
    postId: originalId,
    text: `${getUser(req.userId).name} quoted your post`,
  });

  const row = db.prepare("SELECT * FROM posts WHERE id = ?").get(info.lastInsertRowid);
  res.status(201).json({ post: serializePost(row, req.userId, "recent") });
});

router.post("/:id/like", requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(postId);
  if (!post) return res.status(404).json({ error: "Post not found" });

  const existing = db.prepare("SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?").get(postId, req.userId);
  if (existing) {
    db.prepare("DELETE FROM likes WHERE post_id = ? AND user_id = ?").run(postId, req.userId);
  } else {
    db.prepare("INSERT INTO likes (post_id, user_id, created_at) VALUES (?, ?, ?)").run(postId, req.userId, Date.now());
    createNotification({
      userId: post.author_id,
      actorId: req.userId,
      type: "like",
      postId,
      text: `${getUser(req.userId).name} liked your post`,
    });
  }

  const row = db.prepare("SELECT * FROM posts WHERE id = ?").get(postId);
  res.json({ post: serializePost(row, req.userId, "recent") });
});

router.get("/:id/comments", requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  const rows = db
    .prepare("SELECT * FROM comments WHERE post_id = ? ORDER BY created_at ASC")
    .all(postId);
  const comments = rows.map((c) => {
    const author = getUser(c.user_id);
    return { id: c.id, text: c.text, createdAt: c.created_at, author };
  });
  res.json({ comments });
});

router.post("/:id/comments", requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(postId);
  if (!post) return res.status(404).json({ error: "Post not found" });

  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: "Comment text is required" });

  const info = db
    .prepare("INSERT INTO comments (post_id, user_id, text, created_at) VALUES (?, ?, ?, ?)")
    .run(postId, req.userId, text.trim(), Date.now());

  createNotification({
    userId: post.author_id,
    actorId: req.userId,
    type: "comment",
    postId,
    text: `${getUser(req.userId).name} commented: "${text.trim().slice(0, 60)}"`,
  });

  const row = db.prepare("SELECT * FROM posts WHERE id = ?").get(postId);
  res.status(201).json({ commentId: info.lastInsertRowid, post: serializePost(row, req.userId, "recent") });
});

router.post("/:id/repost", requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(postId);
  if (!post) return res.status(404).json({ error: "Post not found" });

  const existing = db.prepare("SELECT 1 FROM reposts WHERE post_id = ? AND user_id = ?").get(postId, req.userId);
  if (existing) {
    db.prepare("DELETE FROM reposts WHERE post_id = ? AND user_id = ?").run(postId, req.userId);
  } else {
    db.prepare("INSERT INTO reposts (post_id, user_id, created_at) VALUES (?, ?, ?)").run(postId, req.userId, Date.now());
    createNotification({
      userId: post.author_id,
      actorId: req.userId,
      type: "repost",
      postId,
      text: `${getUser(req.userId).name} reposted your post`,
    });
  }

  const row = db.prepare("SELECT * FROM posts WHERE id = ?").get(postId);
  res.json({ post: serializePost(row, req.userId, "recent") });
});

router.post("/:id/save", requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(postId);
  if (!post) return res.status(404).json({ error: "Post not found" });

  const existing = db.prepare("SELECT 1 FROM saves WHERE post_id = ? AND user_id = ?").get(postId, req.userId);
  if (existing) {
    db.prepare("DELETE FROM saves WHERE post_id = ? AND user_id = ?").run(postId, req.userId);
  } else {
    db.prepare("INSERT INTO saves (post_id, user_id, created_at) VALUES (?, ?, ?)").run(postId, req.userId, Date.now());
  }

  const row = db.prepare("SELECT * FROM posts WHERE id = ?").get(postId);
  res.json({ post: serializePost(row, req.userId, "recent") });
});

router.post("/:id/share", requireAuth, (req, res) => {
  const postId = Number(req.params.id);
  const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(postId);
  if (!post) return res.status(404).json({ error: "Post not found" });

  const { toUserId } = req.body || {};
  db.prepare("INSERT INTO shares (post_id, user_id, to_user_id, created_at) VALUES (?, ?, ?, ?)").run(
    postId,
    req.userId,
    toUserId || null,
    Date.now()
  );

  if (toUserId) {
    const sharer = getUser(req.userId);
    const messageText = `${sharer.name} shared a post with you: ${post.caption ? post.caption.slice(0, 80) : "a post"}`;
    const info = db
      .prepare("INSERT INTO messages (sender_id, receiver_id, text, read, created_at) VALUES (?, ?, ?, 0, ?)")
      .run(req.userId, toUserId, messageText, Date.now());
    const { emitToUser } = require("../realtime");
    emitToUser(Number(toUserId), "message", {
      id: info.lastInsertRowid,
      senderId: req.userId,
      receiverId: Number(toUserId),
      text: messageText,
      createdAt: Date.now(),
    });
  }

  const row = db.prepare("SELECT * FROM posts WHERE id = ?").get(postId);
  res.json({ post: serializePost(row, req.userId, "recent") });
});

module.exports = router;
