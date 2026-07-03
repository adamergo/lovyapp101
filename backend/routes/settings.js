const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { publicUser } = require("../helpers/user");

const router = express.Router();

const ALLOWED_THEMES = new Set([
  "light",
  "dark",
  "sunset",
  "ocean",
  "forest",
  "dark-pink",
  "dark-purple",
  "dark-green",
  "dark-red",
]);

router.post("/theme", requireAuth, (req, res) => {
  const { theme } = req.body || {};
  if (!ALLOWED_THEMES.has(theme)) {
    return res.status(400).json({ error: `Theme must be one of: ${[...ALLOWED_THEMES].join(", ")}` });
  }
  db.prepare("UPDATE users SET theme = ? WHERE id = ?").run(theme, req.userId);
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
  res.json({ user: publicUser(user) });
});

router.post("/password", requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Current and new password are required" });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters" });
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.userId);
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: "Current password is incorrect" });
  }

  const passwordHash = bcrypt.hashSync(newPassword, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, req.userId);
  res.json({ ok: true });
});

module.exports = router;
