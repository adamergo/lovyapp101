const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { signToken, requireAuth, COOKIE_NAME } = require("../middleware/auth");
const { publicUser } = require("../helpers/user");

const router = express.Router();

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

router.post("/register", (req, res) => {
  const { name, handle, email, password } = req.body || {};
  if (!name || !handle || !email || !password) {
    return res.status(400).json({ error: "name, handle, email, and password are required" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  const cleanHandle = String(handle).trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(cleanHandle)) {
    return res.status(400).json({ error: "Handle must be 3-20 characters: letters, numbers, underscore" });
  }

  const existing = db
    .prepare("SELECT id FROM users WHERE email = ? OR handle = ?")
    .get(String(email).toLowerCase().trim(), cleanHandle);
  if (existing) {
    return res.status(409).json({ error: "An account with that email or handle already exists" });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare(
      `INSERT INTO users (name, handle, email, password_hash, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(String(name).trim(), cleanHandle, String(email).toLowerCase().trim(), passwordHash, "/media/pfp.jpg", Date.now());

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
  const token = signToken(user.id);
  res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
  res.status(201).json({ user: publicUser(user) });
});

router.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password are required" });

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email).toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const token = signToken(user.id);
  res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
  res.json({ user: publicUser(user) });
});

router.post("/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

router.get("/me", requireAuth, (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  res.json({ user: publicUser(user) });
});

module.exports = router;
