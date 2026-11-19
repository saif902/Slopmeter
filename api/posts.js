const BASE = "https://api.getxapi.com";
const MAX_PAGES = Number(process.env.MAX_PAGES || 5);
const DAILY_CAP = Number(process.env.DAILY_CAP || 300);
let day = "", used = 0;

module.exports = async (req, res) => {
  const key = process.env.GETXAPI_KEY;
  if (!key) return res.status(500).json({ error: "Server is missing GETXAPI_KEY." });

  const u = String(req.query.u || "").replace(/^@/, "").trim();
  if (!/^[A-Za-z0-9_]{1,15}$/.test(u)) return res.status(400).json({ error: "Invalid username." });

  const today = new Date().toISOString().slice(0, 10);
  if (day !== today) { day = today; used = 0; }
  if (used >= DAILY_CAP) return res.status(429).json({ error: "Daily limit reached. Try again tomorrow." });
  used++;

  const posts = [];
  const seen = new Set();
  let cursor = "";
  try {
    for (let i = 0; i < MAX_PAGES && posts.length < 100; i++) {
      const url = new URL(BASE + "/twitter/user/tweets");
      url.searchParams.set("userName", u);
      if (cursor) url.searchParams.set("cursor", cursor);
      const r = await fetch(url, { headers: { Authorization: "Bearer " + key } });
      if (!r.ok) {
        if (i === 0) return res.status(r.status === 404 ? 404 : 502).json({ error: "Could not load posts for @" + u + "." });
        break;
      }
      const j = await r.json();
      const list = j.tweets || (j.data && j.data.tweets) || (Array.isArray(j.data) ? j.data : []);
      for (const t of list) {
        const text = String(t.text || t.full_text || "").trim();
        if (!text || /^RT @/.test(text)) continue;
        if (t.isReply || t.in_reply_to_status_id || t.inReplyToId) continue;
        if (seen.has(text)) continue;
        seen.add(text);
        posts.push(text);
      }
      cursor = j.next_cursor || (j.data && j.data.next_cursor) || "";
      if (!cursor || j.has_next_page === false) break;
    }
  } catch (e) {
    return res.status(502).json({ error: "Post service is not responding. Try again later." });
  }

  if (!posts.length) return res.status(404).json({ error: "No public posts found for @" + u + "." });
  res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=3600");
  return res.status(200).json({ username: u, posts: posts.slice(0, 100) });
};
