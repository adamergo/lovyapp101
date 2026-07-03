const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { computeAffinity } = require("../helpers/affinity");

const router = express.Router();

function getUser(id) {
  return db.prepare("SELECT id, name, handle, avatar FROM users WHERE id = ?").get(id);
}

// Same idea as the feed ranker: unseen stories surface first, then within
// each bucket rank by affinity (closer friends) and recency.
function scoreStoryGroup(group, viewerId) {
  const anyUnviewed = group.stories.some(
    (s) => !db.prepare("SELECT 1 FROM story_views WHERE story_id = ? AND user_id = ?").get(s.id, viewerId)
  );
  const seenPenalty = anyUnviewed ? 0 : -1000;
  const affinity = computeAffinity(viewerId, group.user.id);
  const newestHoursAgo = Math.min(...group.stories.map((s) => (Date.now() - s.created_at) / 3600000));
  const recencyScore = 24 - newestHoursAgo;
  return seenPenalty + affinity * 10 + recencyScore;
}

router.get("/", requireAuth, (req, res) => {
  const now = Date.now();
  const rows = db
    .prepare("SELECT * FROM stories WHERE expires_at > ? ORDER BY created_at ASC")
    .all(now);

  const ownStories = rows
    .filter((s) => s.user_id === req.userId)
    .map((s) => ({ id: s.id, img: s.image, createdAt: s.created_at }));

  const byUser = new Map();
  rows
    .filter((s) => s.user_id !== req.userId)
    .forEach((s) => {
      if (!byUser.has(s.user_id)) byUser.set(s.user_id, { user: getUser(s.user_id), stories: [] });
      byUser.get(s.user_id).stories.push(s);
    });

  const groups = Array.from(byUser.values());
  groups.forEach((g) => {
    g.viewed = g.stories.every((s) =>
      db.prepare("SELECT 1 FROM story_views WHERE story_id = ? AND user_id = ?").get(s.id, req.userId)
    );
    g._score = scoreStoryGroup(g, req.userId);
  });
  groups.sort((a, b) => b._score - a._score);

  const tray = groups.map((g) => ({
    userId: g.user.id,
    name: g.user.name,
    avatar: g.user.avatar,
    viewed: g.viewed,
    stories: g.stories.map((s) => ({ id: s.id, img: s.image, createdAt: s.created_at })),
  }));

  res.json({ own: ownStories, tray });
});

router.post("/", requireAuth, (req, res) => {
  const { image } = req.body || {};
  if (!image) return res.status(400).json({ error: "Story needs an image" });
  const now = Date.now();
  const info = db
    .prepare("INSERT INTO stories (user_id, image, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(req.userId, image, now, now + 24 * 3600 * 1000);
  res.status(201).json({ id: info.lastInsertRowid, img: image, createdAt: now });
});

router.post("/:id/view", requireAuth, (req, res) => {
  const storyId = Number(req.params.id);
  const story = db.prepare("SELECT * FROM stories WHERE id = ?").get(storyId);
  if (!story) return res.status(404).json({ error: "Story not found" });
  db.prepare("INSERT OR IGNORE INTO story_views (story_id, user_id) VALUES (?, ?)").run(storyId, req.userId);
  res.json({ ok: true });
});

module.exports = router;
