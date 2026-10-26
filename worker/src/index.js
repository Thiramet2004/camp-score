/* Camp Score API: one Durable Object per camp holds the scoreboard and
   pushes every change to connected viewers over WebSocket.

   GET  /camps/:id/ws       viewers: live board (WebSocket)
   GET  /camps/:id          board as JSON
   POST /camps/:id/unlock   { pin } -> { token }   (rate limited per IP)
   GET  /camps/:id/verify   Bearer token -> 204 / 401
   POST /camps/:id/deltas   Bearer token, { deltas: { teamId: n } }
   POST /camps/:id/reset    Bearer token

   Secrets (wrangler secret put): ADMIN_PIN, TOKEN_SECRET */

import { DurableObject } from 'cloudflare:workers';

const TEAM_IDS = ['kaitong', 'kaijae', 'plabu', 'platu', 'nokkaew', 'nokngeuak'];
const CAMP_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_FAILS = 8;               // wrong PINs per IP per window
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const MAX_DELTA = 100000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...CORS },
});
const empty = (status) => new Response(null, { status, headers: CORS });
const zeroScores = () => Object.fromEntries(TEAM_IDS.map((id) => [id, 0]));

/* ---------- tokens: HMAC-SHA256 over "campId.expiry" ---------- */
const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function makeToken(env, campId) {
  const exp = Date.now() + TOKEN_TTL_MS;
  return `${exp}.${await hmac(env.TOKEN_SECRET, `${campId}.${exp}`)}`;
}
async function checkToken(env, campId, req) {
  const m = /^Bearer (\d+)\.([\w-]+)$/.exec(req.headers.get('Authorization') || '');
  if (!m || Number(m[1]) < Date.now()) return false;
  return safeEqual(m[2], await hmac(env.TOKEN_SECRET, `${campId}.${m[1]}`));
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return empty(204);
    const url = new URL(req.url);
    const m = /^\/camps\/([^/]+)(?:\/(ws|unlock|verify|deltas|reset))?\/?$/.exec(url.pathname);
    if (!m) return url.pathname === '/' ? json({ ok: true, service: 'camp-score' }) : json({ error: 'not-found' }, 404);
    const [, campId, action = 'board'] = m;
    if (!CAMP_RE.test(campId)) return json({ error: 'bad-camp' }, 400);
    if (!env.ADMIN_PIN || !env.TOKEN_SECRET) return json({ error: 'not-configured' }, 500);

    const board = env.BOARD.get(env.BOARD.idFromName(campId));

    if (action === 'ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected-websocket' }, 426);
      return board.fetch(req);
    }
    if (action === 'board' && req.method === 'GET') return json(await board.getBoard());

    if (action === 'unlock' && req.method === 'POST') {
      const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
      if (await board.isLockedOut(ip)) return json({ error: 'too-many-attempts' }, 429);
      const body = await req.json().catch(() => ({}));
      const pin = String(body?.pin ?? '');
      if (!pin || !safeEqual(pin, String(env.ADMIN_PIN))) {
        await board.recordFail(ip);
        return json({ error: 'wrong-pin' }, 403);
      }
      return json({ token: await makeToken(env, campId) });
    }

    if (!['verify', 'deltas', 'reset'].includes(action)) return json({ error: 'method-not-allowed' }, 405);
    if (!(await checkToken(env, campId, req))) return json({ error: 'permission-denied' }, 401);

    if (action === 'verify' && req.method === 'GET') return empty(204);
    if (action === 'deltas' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const deltas = {};
      for (const [id, d] of Object.entries(body?.deltas ?? {})) {
        if (!TEAM_IDS.includes(id) || !Number.isInteger(d) || Math.abs(d) > MAX_DELTA) {
          return json({ error: 'bad-deltas' }, 400);
        }
        if (d) deltas[id] = d;
      }
      return json(await board.applyDeltas(deltas));
    }
    if (action === 'reset' && req.method === 'POST') return json(await board.reset());
    return json({ error: 'method-not-allowed' }, 405);
  },
};

/* ---------- one instance per camp ---------- */
export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async load() {
    if (!this.board) {
      const saved = await this.ctx.storage.get('board');
      this.board = { scores: zeroScores(), updatedAt: null, resetId: null, ver: 0, ...saved };
      this.board.scores = { ...zeroScores(), ...this.board.scores };
    }
    return this.board;
  }

  async save(board) {
    board.ver += 1;
    board.updatedAt = Date.now();
    await this.ctx.storage.put('board', board);
    const msg = JSON.stringify({ type: 'board', ...board });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch { /* closed socket */ }
    }
    return board;
  }

  async getBoard() { return this.load(); }

  async applyDeltas(deltas) {
    const board = await this.load();
    for (const [id, d] of Object.entries(deltas)) board.scores[id] += d;
    return this.save(board);
  }

  async reset() {
    const board = await this.load();
    board.scores = zeroScores();
    board.resetId = crypto.randomUUID();
    return this.save(board);
  }

  async isLockedOut(ip) {
    const f = await this.ctx.storage.get(`fail:${ip}`);
    return !!f && f.n >= MAX_FAILS && Date.now() - f.since < FAIL_WINDOW_MS;
  }

  async recordFail(ip) {
    const key = `fail:${ip}`;
    let f = await this.ctx.storage.get(key);
    if (!f || Date.now() - f.since >= FAIL_WINDOW_MS) f = { n: 0, since: Date.now() };
    f.n += 1;
    await this.ctx.storage.put(key, f);
  }

  async fetch() {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: 'board', ...(await this.load()) }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage() { /* viewers only listen; "ping" is auto-answered */ }
  webSocketClose(ws, code) { try { ws.close(code, 'bye'); } catch { /* already closed */ } }
}
