const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { createNotification } = require("../helpers/notify");

const router = express.Router();

router.get("/search", requireAuth, (req, res) => {
  const q = String(req.query.q || "").trim();

  if (!q) {
    // No query: surface people-you-may-know suggestions (not already followed).
    const rows = db
      .prepare(
        `SELECT id, name, handle, avatar FROM users
         WHERE id != ? AND id NOT IN (SELECT followee_id FROM follows WHERE follower_id = ?)
         ORDER BY RANDOM() LIMIT 5`
      )
      .all(req.userId, req.userId);
    return res.json({ users: rows });
  }

  const rows = db
    .prepare(
      `SELECT id, name, handle, avatar FROM users WHERE (name LIKE ? OR handle LIKE ?) AND id != ? LIMIT 20`
    )
    .all(`%${q}%`, `%${q}%`, req.userId);
  res.json({ users: rows });
});

router.get("/me/stats", requireAuth, (req, res) => {
  const posts = db.prepare("SELECT COUNT(*) as c FROM posts WHERE author_id = ?").get(req.userId).c;
  const postLikes = db
    .prepare(
      `SELECT COUNT(*) as c FROM likes WHERE post_id IN (SELECT id FROM posts WHERE author_id = ?)`
    )
    .get(req.userId).c;
  const snapLikes = db
    .prepare(
      `SELECT COUNT(*) as c FROM snap_likes WHERE snap_id IN (SELECT id FROM snaps WHERE user_id = ?)`
    )
    .get(req.userId).c;
  const commentsReceived = db
    .prepare(
      `SELECT COUNT(*) as c FROM comments WHERE post_id IN (SELECT id FROM posts WHERE author_id = ?)`
    )
    .get(req.userId).c;
  const followers = db.prepare("SELECT COUNT(*) as c FROM follows WHERE followee_id = ?").get(req.userId).c;
  const following = db.prepare("SELECT COUNT(*) as c FROM follows WHERE follower_id = ?").get(req.userId).c;

  res.json({
    posts,
    likesReceived: postLikes + snapLikes,
    commentsReceived,
    followers,
    following,
  });
});

router.get("/:handle", requireAuth, (req, res) => {
  const user = db
    .prepare("SELECT id, name, handle, avatar, created_at FROM users WHERE handle = ?")
    .get(req.params.handle);
  if (!user) return res.status(404).json({ error: "User not found" });

  const followers = db.prepare("SELECT COUNT(*) as c FROM follows WHERE followee_id = ?").get(user.id).c;
  const following = db.prepare("SELECT COUNT(*) as c FROM follows WHERE follower_id = ?").get(user.id).c;
  const isFollowing = !!db
    .prepare("SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?")
    .get(req.userId, user.id);

  res.json({ user: { ...user, followers, following, isFollowing, isSelf: user.id === req.userId } });
});

router.post("/:id/follow", requireAuth, (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.userId) return res.status(400).json({ error: "You can't follow yourself" });
  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(targetId);
  if (!target) return res.status(404).json({ error: "User not found" });

  const existing = db
    .prepare("SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?")
    .get(req.userId, targetId);

  if (existing) {
    db.prepare("DELETE FROM follows WHERE follower_id = ? AND followee_id = ?").run(req.userId, targetId);
    return res.json({ following: false });
  }

  db.prepare("INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)").run(
    req.userId,
    targetId,
    Date.now()
  );
  const me = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
  createNotification({
    userId: targetId,
    actorId: req.userId,
    type: "follow",
    postId: null,
    text: `${me.name} started following you`,
  });
  res.json({ following: true });
});

module.exports = router;
