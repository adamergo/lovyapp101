const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { createNotification } = require("../helpers/notify");
const { emitToUser } = require("../realtime");
const { computeAffinity } = require("../helpers/affinity");

const router = express.Router();

function getUser(id) {
  return db.prepare("SELECT id, name, handle, avatar FROM users WHERE id = ?").get(id);
}

function formatCount(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

function countLikes(trackId) {
  return db.prepare("SELECT COUNT(*) as c FROM track_likes WHERE track_id = ?").get(trackId).c;
}

function countShares(trackId) {
  return db.prepare("SELECT COUNT(*) as c FROM track_shares WHERE track_id = ?").get(trackId).c;
}

// Music "For You" ranking: same recency + engagement + affinity blend used for the
// post and reel feeds, so tracks a listener's friends love (or that are trending
// across the app) surface even if they don't follow the uploader.
function scoreTrack(stats) {
  const recencyScore = 10 / (stats.hoursAgo + 2);
  const engagement = stats.likes * 2 + stats.shares * 3 + stats.plays * 0.05;
  const engagementScore = Math.log(engagement + 1) * 1.5;
  const affinityScore = stats.affinity * 8;
  return recencyScore + engagementScore + affinityScore;
}

function serializeTrack(row, viewerId, mode) {
  const author = getUser(row.uploader_id);
  const likes = countLikes(row.id);
  const shares = countShares(row.id);
  const liked = !!db.prepare("SELECT 1 FROM track_likes WHERE track_id = ? AND user_id = ?").get(row.id, viewerId);
  const hoursAgo = (Date.now() - row.created_at) / 3600000;
  const affinity = computeAffinity(viewerId, row.uploader_id);

  let badge = null;
  if (mode !== "recent") {
    if (affinity >= 0.7) badge = { label: "Close Friend", icon: "uil-users-alt" };
    else if (row.plays >= 15000 || likes >= 300) badge = { label: "Trending", icon: "uil-fire" };
    else if (hoursAgo <= 1) badge = { label: "New", icon: "uil-bolt" };
  }

  return {
    id: row.id,
    author: author ? author.name : "Unknown",
    authorId: row.uploader_id,
    avatar: author ? author.avatar : "",
    title: row.title,
    artist: row.artist,
    cover: row.cover || "",
    audio: row.audio,
    plays: formatCount(row.plays),
    likes,
    shares,
    liked,
    hoursAgo,
    affinity,
    badge,
  };
}

router.get("/feed", requireAuth, (req, res) => {
  const mode = req.query.mode === "recent" ? "recent" : "fyp";
  const rows = db.prepare("SELECT * FROM tracks ORDER BY created_at DESC").all();
  const tracks = rows.map((r) => serializeTrack(r, req.userId, mode));

  if (mode === "fyp") {
    const scoreById = new Map(
      rows.map((r) => [
        r.id,
        scoreTrack({
          hoursAgo: (Date.now() - r.created_at) / 3600000,
          likes: countLikes(r.id),
          shares: countShares(r.id),
          plays: r.plays,
          affinity: computeAffinity(req.userId, r.uploader_id),
        }),
      ])
    );
    tracks.sort((a, b) => scoreById.get(b.id) - scoreById.get(a.id));
  } else {
    tracks.sort((a, b) => a.hoursAgo - b.hoursAgo);
  }

  res.json({ tracks });
});

router.post("/", requireAuth, (req, res) => {
  const { title, artist, audio, cover } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: "Give your track a title" });
  if (!audio) return res.status(400).json({ error: "Upload an audio file to share music" });

  const info = db
    .prepare(
      "INSERT INTO tracks (uploader_id, title, artist, cover, audio, plays, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)"
    )
    .run(req.userId, title.trim(), (artist || getUser(req.userId).name).trim(), cover || null, audio, Date.now());

  const row = db.prepare("SELECT * FROM tracks WHERE id = ?").get(info.lastInsertRowid);
  res.status(201).json({ track: serializeTrack(row, req.userId, "recent") });
});

router.post("/:id/play", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  db.prepare("UPDATE tracks SET plays = plays + 1 WHERE id = ?").run(id);
  const row = db.prepare("SELECT * FROM tracks WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "Track not found" });
  res.json({ track: serializeTrack(row, req.userId) });
});

router.post("/:id/like", requireAuth, (req, res) => {
  const trackId = Number(req.params.id);
  const track = db.prepare("SELECT * FROM tracks WHERE id = ?").get(trackId);
  if (!track) return res.status(404).json({ error: "Track not found" });

  const existing = db.prepare("SELECT 1 FROM track_likes WHERE track_id = ? AND user_id = ?").get(trackId, req.userId);
  if (existing) {
    db.prepare("DELETE FROM track_likes WHERE track_id = ? AND user_id = ?").run(trackId, req.userId);
  } else {
    db.prepare("INSERT INTO track_likes (track_id, user_id, created_at) VALUES (?, ?, ?)").run(trackId, req.userId, Date.now());
    if (track.uploader_id !== req.userId) {
      createNotification({
        userId: track.uploader_id,
        actorId: req.userId,
        type: "like",
        postId: null,
        text: `${getUser(req.userId).name} liked your track "${track.title}"`,
      });
    }
  }

  const row = db.prepare("SELECT * FROM tracks WHERE id = ?").get(trackId);
  res.json({ track: serializeTrack(row, req.userId) });
});

router.post("/:id/share", requireAuth, (req, res) => {
  const trackId = Number(req.params.id);
  const track = db.prepare("SELECT * FROM tracks WHERE id = ?").get(trackId);
  if (!track) return res.status(404).json({ error: "Track not found" });

  const { toUserId } = req.body || {};
  db.prepare("INSERT INTO track_shares (track_id, user_id, to_user_id, created_at) VALUES (?, ?, ?, ?)").run(
    trackId,
    req.userId,
    toUserId || null,
    Date.now()
  );

  if (toUserId) {
    const sharer = getUser(req.userId);
    const messageText = `${sharer.name} shared a track with you: ${track.title} — ${track.artist}`;
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

  const row = db.prepare("SELECT * FROM tracks WHERE id = ?").get(trackId);
  res.json({ track: serializeTrack(row, req.userId) });
});

module.exports = router;
