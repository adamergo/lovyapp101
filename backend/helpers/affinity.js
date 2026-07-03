const db = require("../db");

function computeAffinity(viewerId, otherId) {
  if (viewerId === otherId) return 1;
  const following = db
    .prepare("SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?")
    .get(viewerId, otherId);
  const interactionCount = db
    .prepare(
      `SELECT COUNT(*) as c FROM likes l JOIN posts p ON p.id = l.post_id WHERE l.user_id = ? AND p.author_id = ?`
    )
    .get(viewerId, otherId).c;
  let base = following ? 0.7 : 0.2;
  base += Math.min(0.3, interactionCount * 0.05);
  return Math.min(1, base);
}

module.exports = { computeAffinity };
