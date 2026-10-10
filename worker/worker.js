// Ministry Life — Daily Card votes
// Cloudflare Worker + D1. Bind a D1 database to this worker with the variable name DB.
// Endpoints:
//   GET  /results?day=d20371        -> { day, L, R }
//   POST /vote  { day, side, uid }  -> { day, L, R, dup? }

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const todayIndex = () => Math.floor((Date.now() + 3600e3) / 864e5); // West Africa Time (UTC+1)
const validDay = d => typeof d === 'string' && /^d\d{4,6}$/.test(d) && Math.abs(parseInt(d.slice(1), 10) - todayIndex()) <= 1;

let ready = false;
async function setup(env) {
  if (ready) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS votes (day TEXT NOT NULL, uid TEXT NOT NULL, side TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (day, uid))').run();
  ready = true;
}
async function counts(env, day) {
  const { results } = await env.DB.prepare('SELECT side, COUNT(*) AS n FROM votes WHERE day = ? GROUP BY side').bind(day).all();
  const out = { day, L: 0, R: 0 };
  for (const r of results || []) if (r.side === 'L' || r.side === 'R') out[r.side] = r.n;
  return out;
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
        if (!validDay(day) || !['L', 'R'].includes(side) || typeof uid !== 'string' || !/^[a-z0-9]{8,40}$/i.test(uid)) return json({ error: 'bad vote' }, 400);
        const res = await env.DB.prepare('INSERT OR IGNORE INTO votes (day, uid, side, at) VALUES (?, ?, ?, ?)').bind(day, uid, side, Date.now()).run();
        const out = await counts(env, day);
        if (!res.meta || !res.meta.changes) out.dup = true;
        return json(out);
      }
      return json({ ok: true, service: 'ministrylife-votes', today: 'd' + todayIndex() });
    } catch (e) {
      return json({ error: 'server error' }, 500);
    }
  }
};
