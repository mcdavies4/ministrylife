// Ministry Life — votes, anonymous usage stats and admin stats
// Cloudflare Worker + D1.
//   Binding:  D1 database bound as  DB
//   Secret:   ADMIN_KEY  (any long password; needed for the admin dashboard)
//
// Public endpoints
//   GET  /results?day=d20371          -> { day, L, R }
//   POST /vote  { day, side, uid }    -> { day, L, R, dup? }
//   POST /e     { uid, ev:[...] }     -> { ok }       (anonymous game events, no names)
//   GET  /churches                    -> this week's Church Cup table { week, rows:[{k, pts, players}], last }
// Admin endpoint (header  Authorization: Bearer <ADMIN_KEY>)
//   GET  /admin/stats?days=30         -> dashboard data

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400'
};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const todayIndex = () => Math.floor((Date.now() + 3600e3) / 864e5); // West Africa Time (UTC+1)
const validDay = d => typeof d === 'string' && /^d\d{4,6}$/.test(d) && Math.abs(parseInt(d.slice(1), 10) - todayIndex()) <= 1;
const validUid = u => typeof u === 'string' && /^[a-z0-9]{8,40}$/i.test(u);
const str = (v, max) => (v === undefined || v === null) ? null : String(v).slice(0, max);
const int = v => Number.isFinite(+v) ? Math.round(+v) : null;
const EVENT_TYPES = new Set(['visit', 'start', 'end', 'badge', 'share', 'lesson', 'church', 'quiz']);
// keys must match CHURCHES in index.html
const CHURCHES = new Set(['rccg', 'winners', 'deeper', 'mfm', 'christembassy', 'cac', 'anglican', 'catholic', 'methodist', 'baptist', 'ecwa', 'aog', 'foursquare', 'cands', 'celestial', 'hotr', 'otherpent', 'other']);
const DAY_CAP = 80;   // most Church Cup points one player can earn in a day
const weekStart = dn => dn - ((dn + 3) % 7);   // Monday (day 0 was a Thursday)
const PATHS = new Set(['p', 'g', 'e']);

let ready = false;
async function setup(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS votes (day TEXT NOT NULL, uid TEXT NOT NULL, side TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (day, uid))'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, dn INTEGER NOT NULL, ts INTEGER NOT NULL, uid TEXT NOT NULL, type TEXT NOT NULL, path TEXT, lang TEXT, k TEXT, v TEXT, n INTEGER, x INTEGER, y INTEGER, country TEXT, mobile INTEGER)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS ev_day_type ON events (dn, type)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS ev_uid ON events (uid, type, dn)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS players (uid TEXT PRIMARY KEY, first_day INTEGER NOT NULL, last_day INTEGER NOT NULL, days INTEGER NOT NULL)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS pl_first ON players (first_day)')
  ]);
  try { await env.DB.prepare('ALTER TABLE players ADD COLUMN church TEXT').run(); } catch (e) { /* already added */ }
  ready = true;
}

// Church Cup: points per player per day (capped), summed by the player's chosen church
const CUP_SQL = `WITH pts AS (
    SELECT uid, dn, SUM(CASE WHEN type = 'end' THEN 10 + 5 * MAX(0, MIN(5, COALESCE(x, 0)))
                             WHEN type = 'lesson' AND n >= 2 THEN 15
                             WHEN type = 'quiz' THEN MAX(0, MIN(10, COALESCE(n, 0)))
                             ELSE 0 END) AS p
      FROM events WHERE dn >= ?1 AND dn < ?2 AND type IN ('end', 'lesson', 'quiz') GROUP BY uid, dn
    UNION ALL
    SELECT uid, CAST(substr(day, 2) AS INTEGER) AS dn, 5 AS p FROM votes
      WHERE CAST(substr(day, 2) AS INTEGER) >= ?1 AND CAST(substr(day, 2) AS INTEGER) < ?2
  ), daily AS (SELECT uid, dn, MIN(${DAY_CAP}, SUM(p)) AS p FROM pts GROUP BY uid, dn)
  SELECT pl.church AS k, SUM(d.p) AS pts, COUNT(DISTINCT d.uid) AS players
    FROM daily d JOIN players pl ON pl.uid = d.uid
   WHERE pl.church IS NOT NULL AND d.p > 0 GROUP BY pl.church ORDER BY pts DESC`;
let cupCache = null;
async function churchCup(env) {
  const now = Date.now();
  if (cupCache && now - cupCache.at < 60e3) return cupCache.body;
  const ws = weekStart(todayIndex());
  const [cur, prev] = await env.DB.batch([env.DB.prepare(CUP_SQL).bind(ws, ws + 7), env.DB.prepare(CUP_SQL).bind(ws - 7, ws)]);
  const rows = (cur.results || []).filter(r => CHURCHES.has(r.k));
  const last = (prev.results || []).filter(r => CHURCHES.has(r.k))[0] || null;
  const body = { week: ws, rows, last };
  cupCache = { at: now, body };
  return body;
}
async function counts(env, day) {
  const { results } = await env.DB.prepare('SELECT side, COUNT(*) AS n FROM votes WHERE day = ? GROUP BY side').bind(day).all();
  const out = { day, L: 0, R: 0 };
  for (const r of results || []) if (r.side === 'L' || r.side === 'R') out[r.side] = r.n;
  return out;
}

async function recordEvents(req, env) {
  let b;
  try { b = JSON.parse(await req.text()); } catch (e) { return json({ error: 'bad json' }, 400); }
  if (!b || !validUid(b.uid) || !Array.isArray(b.ev)) return json({ error: 'bad events' }, 400);
  const dn = todayIndex(), ts = Date.now();
  const country = str(req.cf && req.cf.country, 4) || null;
  const mobile = /Mobi|Android|iPhone|iPad/i.test(req.headers.get('User-Agent') || '') ? 1 : 0;
  const stmts = [];
  let visited = false;
  for (const e of b.ev.slice(0, 25)) {
    if (!e || !EVENT_TYPES.has(e.type)) continue;
    if (e.type === 'visit') { if (visited) continue; visited = true; }
    if (e.type === 'church') {
      if (!CHURCHES.has(e.k)) continue;
      stmts.push(env.DB.prepare('INSERT INTO players (uid, first_day, last_day, days, church) VALUES (?, ?, ?, 1, ?) ON CONFLICT(uid) DO UPDATE SET church = excluded.church')
        .bind(b.uid, dn, dn, e.k));
    }
    stmts.push(env.DB.prepare('INSERT INTO events (dn, ts, uid, type, path, lang, k, v, n, x, y, country, mobile) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(dn, ts, b.uid, e.type, PATHS.has(e.path) ? e.path : null, e.lang === 'pg' ? 'pg' : (e.lang ? 'en' : null),
            str(e.k, 40), str(e.v, 6000), int(e.n), int(e.x), int(e.y), country, mobile));
  }
  if (visited) {
    stmts.push(env.DB.prepare('INSERT INTO players (uid, first_day, last_day, days) VALUES (?, ?, ?, 1) ON CONFLICT(uid) DO UPDATE SET days = days + (CASE WHEN last_day < excluded.last_day THEN 1 ELSE 0 END), last_day = MAX(last_day, excluded.last_day)')
      .bind(b.uid, dn, dn));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, n: stmts.length });
}

function authorised(req, env) {
  const key = env.ADMIN_KEY || '';
  const got = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!key || got.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

async function adminStats(req, env) {
  if (!env.ADMIN_KEY) return json({ error: 'ADMIN_KEY secret is not set on this worker' }, 503);
  if (!authorised(req, env)) return json({ error: 'wrong admin key' }, 401);
  const url = new URL(req.url);
  const days = Math.min(90, Math.max(7, parseInt(url.searchParams.get('days') || '30', 10) || 30));
  const today = todayIndex(), from = today - days + 1;
  const q = (sql, ...args) => env.DB.prepare(sql).bind(...args);
  const res = await env.DB.batch([
    q("SELECT dn, COUNT(DISTINCT uid) AS c FROM events WHERE type = 'visit' AND dn >= ? GROUP BY dn", from),                     // 0 active
    q('SELECT first_day AS dn, COUNT(*) AS c FROM players WHERE first_day >= ? GROUP BY first_day', from),                      // 1 new
    q("SELECT dn, path, COUNT(*) AS c FROM events WHERE type = 'start' AND dn >= ? GROUP BY dn, path", from),                   // 2 starts
    q("SELECT dn, COUNT(*) AS c FROM events WHERE type = 'end' AND dn >= ? GROUP BY dn", from),                                 // 3 ends
    q("SELECT k, COUNT(*) AS c FROM events WHERE type = 'end' AND dn >= ? GROUP BY k", from),                                   // 4 endings
    q("SELECT path, x AS stage, COUNT(*) AS c FROM events WHERE type = 'end' AND dn >= ? GROUP BY path, x", from),              // 5 stage reached
    q("SELECT path, AVG(n) AS turns, AVG(y) AS members, COUNT(*) AS c FROM events WHERE type = 'end' AND dn >= ? GROUP BY path", from), // 6 averages
    q("SELECT lang, COUNT(*) AS c FROM events WHERE type = 'start' AND dn >= ? GROUP BY lang", from),                           // 7 language
    q("SELECT mobile, COUNT(DISTINCT uid) AS c FROM events WHERE type = 'visit' AND dn >= ? GROUP BY mobile", from),            // 8 device
    q("SELECT country, COUNT(DISTINCT uid) AS c FROM events WHERE type = 'visit' AND dn >= ? GROUP BY country ORDER BY c DESC LIMIT 12", from), // 9 countries
    q("SELECT k, COUNT(*) AS c FROM events WHERE type = 'badge' AND dn >= ? GROUP BY k ORDER BY c DESC", from),                // 10 badges
    q("SELECT k, COUNT(*) AS c FROM events WHERE type = 'share' AND dn >= ? GROUP BY k ORDER BY c DESC", from),                // 11 shares
    q('SELECT day, side, COUNT(*) AS c FROM votes WHERE CAST(substr(day, 2) AS INTEGER) >= ? GROUP BY day, side', from),        // 12 daily votes
    q("SELECT v FROM events WHERE type = 'end' AND dn >= ? AND v IS NOT NULL ORDER BY id DESC LIMIT 3000", from),               // 13 choices
    q("SELECT ts, path, lang, k, n, x, y, country, mobile FROM events WHERE type = 'end' ORDER BY id DESC LIMIT 25"),            // 14 recent
    q('SELECT COUNT(*) AS c FROM players'),                                                                                      // 15 all players
    q("SELECT COUNT(*) AS c FROM events WHERE type = 'start'"),                                                                  // 16 all games
    q(`SELECT p.first_day AS dn, COUNT(*) AS newp,
        SUM(EXISTS (SELECT 1 FROM events e WHERE e.uid = p.uid AND e.type = 'visit' AND e.dn = p.first_day + 1)) AS r1,
        SUM(EXISTS (SELECT 1 FROM events e WHERE e.uid = p.uid AND e.type = 'visit' AND e.dn BETWEEN p.first_day + 7 AND p.first_day + 13)) AS r7
       FROM players p WHERE p.first_day >= ? GROUP BY p.first_day`, from),                                                     // 17 retention
    q("SELECT COUNT(DISTINCT uid) AS c FROM events WHERE type = 'visit' AND dn > ?", today - 7),                                // 18 weekly actives
    q("SELECT COUNT(DISTINCT uid) AS c FROM events WHERE type = 'visit' AND dn >= ?", from),                                    // 19 period actives
    q("SELECT k, SUM(n = -1) AS opened, SUM(n = -2) AS mentor, SUM(n >= 2) AS passed, COUNT(DISTINCT CASE WHEN n >= 2 THEN uid END) AS learners FROM events WHERE type = 'lesson' AND dn >= ? GROUP BY k", from), // 20 academy
    q('SELECT church AS k, COUNT(*) AS c FROM players WHERE church IS NOT NULL GROUP BY church ORDER BY c DESC'),               // 21 church members
    q("SELECT COUNT(*) AS played, AVG(n) AS avg, SUM(k = 'challenge') AS challenges FROM events WHERE type = 'quiz' AND dn >= ?", from) // 22 bible quiz
  ]);
  const rows = i => (res[i] && res[i].results) || [];
  const choice = {};
  for (const r of rows(13)) for (const pair of String(r.v).split(',')) {
    const [id, side] = pair.split(':');
    if (!id || (side !== 'L' && side !== 'R')) continue;
    (choice[id] = choice[id] || { L: 0, R: 0 })[side]++;
  }
  return json({
    today, from, days,
    active: rows(0), newPlayers: rows(1), starts: rows(2), ends: rows(3), endings: rows(4), stages: rows(5),
    averages: rows(6), lang: rows(7), device: rows(8), countries: rows(9), badges: rows(10), shares: rows(11),
    daily: rows(12), choices: choice, recent: rows(14),
    totals: { players: (rows(15)[0] || {}).c || 0, games: (rows(16)[0] || {}).c || 0, weekly: (rows(18)[0] || {}).c || 0, period: (rows(19)[0] || {}).c || 0 },
    retention: rows(17), academy: rows(20), members: rows(21), quiz: rows(22)[0] || {}, cup: await churchCup(env)
  });
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (!env.DB) return json({ error: 'D1 database not bound. Add a D1 binding named DB.' }, 500);
    const url = new URL(req.url);
    try {
      await setup(env);
      if (url.pathname === '/results' && req.method === 'GET') {
        const day = url.searchParams.get('day');
        if (!validDay(day)) return json({ error: 'bad day' }, 400);
        return json(await counts(env, day));
      }
      if (url.pathname === '/vote' && req.method === 'POST') {
        let b;
        try { b = await req.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
        const { day, side, uid } = b || {};
        if (!validDay(day) || !['L', 'R'].includes(side) || !validUid(uid)) return json({ error: 'bad vote' }, 400);
        const r = await env.DB.prepare('INSERT OR IGNORE INTO votes (day, uid, side, at) VALUES (?, ?, ?, ?)').bind(day, uid, side, Date.now()).run();
        const out = await counts(env, day);
        if (!r.meta || !r.meta.changes) out.dup = true;
        return json(out);
      }
      if (url.pathname === '/e' && req.method === 'POST') return await recordEvents(req, env);
      if (url.pathname === '/churches' && req.method === 'GET') return json(await churchCup(env));
      if (url.pathname === '/admin/stats' && req.method === 'GET') return await adminStats(req, env);
      return json({ ok: true, service: 'ministrylife-votes', today: 'd' + todayIndex() });
    } catch (e) {
      return json({ error: 'server error', detail: String(e && e.message || e).slice(0, 200) }, 500);
    }
  }
};
