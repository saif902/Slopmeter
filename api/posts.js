// Slopmeter v2: /api/posts?u=<username>
// Fetches a user's recent posts AND replies (retweets skipped) from GetXAPI.
// Env vars: GETXAPI_KEY (required), MAX_PAGES (default 6), DAILY_CAP (default 300).

const BASE = "https://api.getxapi.com";
const MAX_PAGES = Math.max(1, Math.min(10, Number(process.env.MAX_PAGES || 6)));
const DAILY_CAP = Number(process.env.DAILY_CAP || 300);
const MAX_ITEMS = 100;
const TIME_BUDGET_MS = 8500;
const CACHE_TTL_MS = 24 * 3600 * 1000;

let day = "", used = 0;
const memCache = new Map();

const send = (res, code, body, cache) => {
  if (cache === "ok") {
    const v = "public, s-maxage=86400, stale-while-revalidate=86400";
    res.setHeader("Cache-Control", v);
    res.setHeader("CDN-Cache-Control", v);
    res.setHeader("Vercel-CDN-Cache-Control", v);
  } else if (cache === "short") {
    const v = "public, s-maxage=60";
    res.setHeader("Cache-Control", v);
    res.setHeader("CDN-Cache-Control", v);
    res.setHeader("Vercel-CDN-Cache-Control", v);
  } else {
    res.setHeader("Cache-Control", "no-store");
  }
  return res.status(code).json(body);
};

async function gx(path, params, key) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { Authorization: "Bearer " + key, Accept: "application/json" } });
  let j = null;
  try { j = await r.json(); } catch (_) {}
  return { ok: r.ok, status: r.status, json: j };
}

const errText = (j) => String((j && (j.error || j.message || j.msg)) || "");

function upstreamError(r, u) {
  const msg = errText(r.json).toLowerCase();
  if (r.status === 404 || /could not find user|not found|does not exist/.test(msg))
    return [404, "Could not find @" + u + ". Check the spelling."];
  if (r.status === 402 || /credit|balance|insufficient|quota|payment/.test(msg))
    return [503, "Slopmeter has run out of data credits for now. You can still paste posts below."];
  if (r.status === 401 || r.status === 403)
    return [503, "Slopmeter's data service rejected its key. Please tell the site owner."];
  if (r.status === 429)
    return [429, "The data service is busy. Wait a few seconds and try again."];
  return [502, "The data service failed (HTTP " + r.status + "). Try again in a minute."];
}

const asList = (j) => {
  if (!j) return [];
  if (Array.isArray(j.tweets)) return j.tweets;
  if (j.data && Array.isArray(j.data.tweets)) return j.data.tweets;
  if (Array.isArray(j.data)) return j.data;
  return [];
};

const isRetweet = (t, text) =>
  /^RT @\w+/.test(text) || t.type === "retweet" || t.isRetweet === true ||
  !!(t.retweeted_tweet || t.retweetedTweet || t.retweeted_status);

const toIso = (s) => {
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString();
};

const bigAvatar = (url) =>
  typeof url === "string" && /^https:\/\//.test(url) ? url.replace(/_normal(\.\w+)$/, "_400x400$1") : "";

module.exports = async (req, res) => {
  const key = process.env.GETXAPI_KEY;
  if (!key) return send(res, 500, { error: "Server is missing GETXAPI_KEY." });

  const raw = String((req.query && req.query.u) || "").trim().replace(/^@/, "").toLowerCase();
  if (!/^[A-Za-z0-9_]{1,15}$/.test(raw)) return send(res, 400, { error: "That does not look like a valid X username." });
  const u = raw;
  const ul = u.toLowerCase();

  const hit = memCache.get(ul);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return send(res, 200, Object.assign({}, hit.body, { cached: true }), "ok");

  const today = new Date().toISOString().slice(0, 10);
  if (day !== today) { day = today; used = 0; }
  if (used >= DAILY_CAP) return send(res, 429, { error: "Daily limit reached. Try again tomorrow, or paste posts below." });
  used++;

  const started = Date.now();
  const items = [];
  const seen = new Set();
  let profile = null;
  let cursor = "";
  let partial = false;

  try {
    for (let page = 0; page < MAX_PAGES && items.length < MAX_ITEMS; page++) {
      if (page > 0 && Date.now() - started > TIME_BUDGET_MS) { partial = true; break; }
      const r = await gx("/twitter/user/tweets_and_replies", { userName: u, cursor }, key);
      if (!r.ok) {
        if (page === 0) {
          used--;
          const [code, msg] = upstreamError(r, u);
          return send(res, code, { error: msg }, code === 404 ? "short" : false);
        }
        partial = true;
        break;
      }
      const j = r.json || {};
      for (const t of asList(j)) {
        if (!t || typeof t !== "object") continue;
        const text = String(t.text || t.full_text || "").trim();
        if (!text) continue;
        const au = t.author && typeof t.author === "object" ? t.author : null;
        const auName = au && au.userName ? String(au.userName).toLowerCase() : "";
        if (isRetweet(t, text)) continue;
        if (auName && auName !== ul) continue;
        const id = t.id != null ? String(t.id) : "";
        const dedupe = id || text;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        if (!profile && au && auName === ul) profile = au;
        items.push({
          id,
          text: text.slice(0, 1500),
          isReply: !!(t.isReply || t.inReplyToId || t.in_reply_to_status_id),
          createdAt: toIso(t.createdAt || t.created_at),
        });
        if (items.length >= MAX_ITEMS) break;
      }
      cursor = j.next_cursor || (j.data && j.data.next_cursor) || "";
      if (!cursor || j.has_more === false) break;
    }
  } catch (e) {
    if (!items.length) {
      used--;
      return send(res, 502, { error: "The data service is not responding. Try again in a minute." });
    }
    partial = true;
  }

  if (!items.length) {
    try {
      const r = await gx("/twitter/user/info", { userName: u }, key);
      const d = r.json && (r.json.data || r.json);
      if (!r.ok) {
        const [code, msg] = upstreamError(r, u);
        return send(res, code, { error: msg }, code === 404 ? "short" : false);
      }
      if (d && d.protected) return send(res, 403, { error: "@" + u + " is a protected account, so its posts are private." });
    } catch (_) {}
    return send(res, 404, { error: "No public posts found for @" + u + "." }, "short");
  }

  const pr = { username: (profile && profile.userName) || u };
  if (profile) {
    if (profile.name) pr.name = String(profile.name);
    const av = bigAvatar(profile.profilePicture);
    if (av) pr.avatar = av;
    if (profile.isVerified === true || profile.isBlueVerified === true) pr.verified = true;
    if (typeof profile.description === "string" && profile.description.trim()) pr.bio = profile.description.trim().slice(0, 400);
    if (Number.isFinite(profile.followers)) pr.followers = profile.followers;
    if (Number.isFinite(profile.following)) pr.following = profile.following;
  }
  const body = {
    fetchedAt: new Date().toISOString(),
    username: pr.username,
    name: pr.name || "",
    avatar: pr.avatar || "",
    profile: pr,
    items,
  };

  if (partial) return send(res, 200, Object.assign({ partial: true }, body), false);
  memCache.set(ul, { at: Date.now(), body });
  if (memCache.size > 300) memCache.delete(memCache.keys().next().value);
  return send(res, 200, body, "ok");
};
