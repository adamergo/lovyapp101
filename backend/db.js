const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const DB_PATH = path.join(__dirname, "lovyapp.db");
const isNewDb = !fs.existsSync(DB_PATH);

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
db.exec(schema);

// Defensive migration for databases created before the `theme` column existed.
try {
  db.exec("ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'light'");
} catch (err) {
  if (!/duplicate column/i.test(err.message)) throw err;
}

// Defensive migration for databases created before reels (video snaps) existed.
try {
  db.exec("ALTER TABLE snaps ADD COLUMN type TEXT NOT NULL DEFAULT 'image'");
} catch (err) {
  if (!/duplicate column/i.test(err.message)) throw err;
}

if (isNewDb) {
  seed();
}

function seed() {
  const now = Date.now();
  const insertUser = db.prepare(
    `INSERT INTO users (name, handle, email, password_hash, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const demoPassword = bcrypt.hashSync("password123", 10);

  const users = [
    { name: "Diana Ayi", handle: "dayi", email: "diana@lovyapp.demo", avatar: "/media/pfp.jpg" },
    { name: "Jenny Wilson", handle: "jwilson", email: "jenny@lovyapp.demo", avatar: "/media/insta.jpg" },
    { name: "Cody Fisher", handle: "cfisher", email: "cody@lovyapp.demo", avatar: "/media/wallpaper.jpg" },
    { name: "Robert Fox", handle: "rfox", email: "robert@lovyapp.demo", avatar: "/media/insta.jpg" },
    { name: "Leslie Alexander", handle: "lalexander", email: "leslie@lovyapp.demo", avatar: "/media/wallpaper.jpg" },
    { name: "Maren Vaccaro", handle: "mvaccaro", email: "maren@lovyapp.demo", avatar: "/media/pfp.jpg" },
  ];

  const userIds = users.map((u) =>
    insertUser.run(u.name, u.handle, u.email, demoPassword, u.avatar, now).lastInsertRowid
  );
  const [diana, jenny, cody, robert, leslie, maren] = userIds;

  const insertFollow = db.prepare(
    `INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)`
  );
  [
    [diana, jenny],
    [diana, cody],
    [jenny, diana],
    [cody, diana],
    [leslie, diana],
  ].forEach(([a, b]) => insertFollow.run(a, b, now));

  const insertPost = db.prepare(
    `INSERT INTO posts (author_id, image, caption, quote_of, created_at) VALUES (?, ?, ?, NULL, ?)`
  );
  const hoursAgo = (h) => now - h * 3600 * 1000;
  const posts = [
    { author: diana, image: "/media/wallpaper.jpg", caption: "Golden hour never disappoints 🌅", h: 2 },
    { author: jenny, image: "/media/insta.jpg", caption: "Can't stop listening to this album 🎧", h: 0.2 },
    { author: robert, image: "/media/pfp.jpg", caption: "Studio session recap, this one was a marathon", h: 72 },
    { author: leslie, image: "/media/pfp.jpg", caption: "Coffee & code ☕", h: 5 },
    { author: cody, image: "/media/insta.jpg", caption: "New setup is finally done!", h: 0.5 },
    { author: maren, image: "/media/wallpaper.jpg", caption: "Throwback to last summer", h: 26 },
  ];
  const postIds = posts.map((p) => insertPost.run(p.author, p.image, p.caption, hoursAgo(p.h)).lastInsertRowid);

  const insertLike = db.prepare(`INSERT OR IGNORE INTO likes (post_id, user_id, created_at) VALUES (?, ?, ?)`);
  const allUserIds = userIds;
  postIds.forEach((postId, i) => {
    const likeCount = [300, 40, 950, 500, 120, 85][i] || 10;
    for (let n = 0; n < Math.min(likeCount, allUserIds.length * 3); n++) {
      const liker = allUserIds[n % allUserIds.length];
      insertLike.run(postId, liker, now);
    }
  });

  const insertComment = db.prepare(
    `INSERT INTO comments (post_id, user_id, text, created_at) VALUES (?, ?, ?, ?)`
  );
  insertComment.run(postIds[0], jenny, "Absolutely stunning!", now);
  insertComment.run(postIds[0], cody, "Where was this taken?", now);
  insertComment.run(postIds[2], leslie, "That sounds intense, well done!", now);

  const insertStory = db.prepare(
    `INSERT INTO stories (user_id, image, created_at, expires_at) VALUES (?, ?, ?, ?)`
  );
  [
    { user: jenny, image: "/media/pfp.jpg", h: 0.5 },
    { user: cody, image: "/media/wallpaper.jpg", h: 1 },
    { user: robert, image: "/media/insta.jpg", h: 10 },
    { user: leslie, image: "/media/insta.jpg", h: 20 },
    { user: maren, image: "/media/pfp.jpg", h: 15 },
  ].forEach((s) => insertStory.run(s.user, s.image, hoursAgo(s.h), hoursAgo(s.h - 24)));

  const insertSnap = db.prepare(
    `INSERT INTO snaps (user_id, thumb, title, views, created_at) VALUES (?, ?, ?, ?, ?)`
  );
  const snapIds = [
    { user: diana, thumb: "/media/insta.jpg", title: "Sunset vibes", views: 12400 },
    { user: cody, thumb: "/media/wallpaper.jpg", title: "Studio session", views: 8100 },
    { user: jenny, thumb: "/media/pfp.jpg", title: "Behind the scenes", views: 21000 },
    { user: robert, thumb: "/media/insta.jpg", title: "Quick tip", views: 3700 },
    { user: leslie, thumb: "/media/wallpaper.jpg", title: "Weekend recap", views: 15900 },
  ].map((r) => insertSnap.run(r.user, r.thumb, r.title, r.views, now).lastInsertRowid);

  const insertSnapLike = db.prepare(
    `INSERT OR IGNORE INTO snap_likes (snap_id, user_id, created_at) VALUES (?, ?, ?)`
  );
  snapIds.forEach((snapId, i) => {
    const likeCount = [340, 95, 610, 48, 220][i] || 10;
    for (let n = 0; n < Math.min(likeCount, allUserIds.length); n++) {
      insertSnapLike.run(snapId, allUserIds[n], now);
    }
  });

  const insertTrack = db.prepare(
    `INSERT INTO tracks (uploader_id, title, artist, cover, audio, plays, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const trackIds = [
    { user: diana, title: "Golden Hour", artist: "Diana Ayi", cover: "/media/wallpaper.jpg", audio: "/media/golden-hour.mp3", plays: 18400 },
    { user: cody, title: "Studio Loop", artist: "Cody Fisher", cover: "/media/insta.jpg", audio: "/media/studio-loop.mp3", plays: 9200 },
    { user: jenny, title: "Night Drive", artist: "Jenny Wilson", cover: "/media/pfp.jpg", audio: "/media/night-drive.mp3", plays: 26100 },
    { user: robert, title: "Quiet Mornings", artist: "Robert Fox", cover: "/media/wallpaper.jpg", audio: "/media/quiet-mornings.mp3", plays: 4300 },
  ].map((t) => insertTrack.run(t.user, t.title, t.artist, t.cover, t.audio, t.plays, now).lastInsertRowid);

  const insertTrackLike = db.prepare(
    `INSERT OR IGNORE INTO track_likes (track_id, user_id, created_at) VALUES (?, ?, ?)`
  );
  trackIds.forEach((trackId, i) => {
    const likeCount = [420, 130, 610, 55][i] || 10;
    for (let n = 0; n < Math.min(likeCount, allUserIds.length); n++) {
      insertTrackLike.run(trackId, allUserIds[n], now);
    }
  });

  const insertMessage = db.prepare(
    `INSERT INTO messages (sender_id, receiver_id, text, read, created_at) VALUES (?, ?, ?, ?, ?)`
  );
  insertMessage.run(jenny, diana, "Sounds good, see you then!", 0, now - 2 * 60 * 1000);
  insertMessage.run(diana, jenny, "See you at 5!", 1, now - 3 * 60 * 1000);
  insertMessage.run(cody, diana, "Sent the files over 👍", 0, now - 60 * 60 * 1000);
  insertMessage.run(leslie, diana, "Haha that's hilarious", 1, now - 3 * 60 * 60 * 1000);
  insertMessage.run(maren, diana, "Can you review my draft?", 1, now - 24 * 60 * 60 * 1000);

  const insertNotif = db.prepare(
    `INSERT INTO notifications (user_id, actor_id, type, post_id, text, read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  insertNotif.run(diana, jenny, "like", postIds[0], "Jenny Wilson liked your post", 0, now - 5 * 60 * 1000);
  insertNotif.run(diana, cody, "comment", postIds[0], 'Cody Fisher commented: "Amazing shot!"', 0, now - 20 * 60 * 1000);
  insertNotif.run(diana, leslie, "follow", null, "Leslie Alexander started following you", 0, now - 60 * 60 * 1000);
  insertNotif.run(diana, maren, "mention", postIds[0], "Maren mentioned you in a comment", 1, now - 4 * 60 * 60 * 1000);

  console.log("Seeded database with demo users (password for all: 'password123'):");
  users.forEach((u) => console.log(`  ${u.email}`));
}

module.exports = db;
