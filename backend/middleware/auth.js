const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "lovyapp-dev-secret-change-me";
const COOKIE_NAME = "token";

function signToken(userId) {
  return jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: "30d" });
}

function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.uid;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
}

function optionalAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return next();
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.uid;
  } catch (err) {
    // ignore invalid token, continue unauthenticated
  }
  next();
}

function verifySocketToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return payload.uid;
  } catch (err) {
    return null;
  }
}

module.exports = { signToken, requireAuth, optionalAuth, verifySocketToken, COOKIE_NAME, JWT_SECRET };
