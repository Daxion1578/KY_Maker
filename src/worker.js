/* 現場写真AI-KY支援アプリ（公開デモ）— Cloudflare Worker
   役割:
     (1) public/ の静的ファイル配信（wrangler.toml の assets 設定。/api/* 以外は Worker を通らない）
     (2) 合言葉によるログインと、署名付きCookieのセッション管理
     (3) 1日あたりの利用回数制限（全体／IP別。KVで数える）
     (4) Claude API への中継。APIキーはサーバー側の秘密情報として保持し、画面には渡さない
   Claude API は SDK を使わず fetch で直接呼ぶ（依存パッケージなしで配置できるようにするため）。
   API仕様: POST https://api.anthropic.com/v1/messages, header anthropic-version: 2023-06-01 */

import {
  VISION_SYSTEM, VISION_USER, OBS_JSON_SCHEMA,
  KY_SYSTEM_VISION, KY_SYSTEM_TEXT, KY_JSON_SCHEMA
} from './prompts.js';

export const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
/* 安全上の理由で応答が停止（refusal）した場合に、サーバー側で別モデルへ再実行させる（beta） */
const BETA_FALLBACK = 'server-side-fallback-2026-07-01';

const COOKIE_NAME = 'ky_sess';
const MAX_BODY_BYTES = 8 * 1024 * 1024;       /* リクエスト本文の上限 */
const MAX_IMAGE_B64 = 6 * 1000 * 1000;        /* 画像base64の上限（約4.5MB。APIの5MB制限内） */
const MAX_TEXT_FIELD = 80 * 1000;             /* 候補事例テキストなど、自由文フィールドの上限 */
const LOGIN_FAIL_LIMIT = 10;                  /* 15分あたりのログイン失敗回数の上限（IP別） */
const LOGIN_FAIL_TTL = 15 * 60;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/* ---------- 小道具 ---------- */
const enc = new TextEncoder();

function json(body, status, extraHeaders) {
  const h = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) h.set(k, v);
  return new Response(JSON.stringify(body), { status: status || 200, headers: h });
}
function fail(status, message, extra) {
  return json(Object.assign({ ok: false, error: message }, extra || {}), status);
}

function hex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function sha256Hex(s) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}
/* 長さに依らず全桁を比較する（比較途中で打ち切らない） */
function timingEqual(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.get('cookie') || '';
  raw.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function clientIp(req) {
  return req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'unknown';
}
/* 日本時間の日付。回数制限の区切りに使う */
export function jstDate(now) {
  return new Date((now || Date.now()) + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function intVar(env, name, dflt) {
  const v = parseInt(env[name], 10);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}
async function readJson(req) {
  const len = parseInt(req.headers.get('content-length') || '0', 10);
  if (len > MAX_BODY_BYTES) throw new HttpError(413, '送信データが大きすぎます。');
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, '送信データが大きすぎます。');
  try { return JSON.parse(text || '{}'); }
  catch (e) { throw new HttpError(400, 'リクエストの形式が不正です。'); }
}
class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

/* ---------- セッション ---------- */
async function sessionSecret(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  /* 未設定なら合言葉から導出する。合言葉を変えると既存セッションは無効になる */
  return sha256Hex('ky-session-secret|' + env.ACCESS_PASSWORD);
}
async function makeToken(env, ttlSec) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = await hmacHex(await sessionSecret(env), 'ky-session|' + exp);
  return exp + '.' + sig;
}
async function verifyToken(env, token) {
  if (!token || typeof token !== 'string') return false;
  const i = token.indexOf('.');
  if (i < 0) return false;
  const exp = parseInt(token.slice(0, i), 10);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const want = await hmacHex(await sessionSecret(env), 'ky-session|' + exp);
  return timingEqual(want, token.slice(i + 1));
}
function cookieHeader(url, value, maxAge) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return COOKIE_NAME + '=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + secure;
}
async function isLoggedIn(env, req) {
  return verifyToken(env, parseCookies(req)[COOKIE_NAME]);
}

/* ---------- 回数制限（KV） ---------- */
async function kvCount(env, key) {
  const v = await env.RATE_KV.get(key);
  const n = parseInt(v || '0', 10);
  return Number.isFinite(n) ? n : 0;
}
async function kvBump(env, key, ttl) {
  const n = (await kvCount(env, key)) + 1;
  await env.RATE_KV.put(key, String(n), { expirationTtl: ttl });
  return n;
}
function limits(env) {
  return { day: intVar(env, 'DAILY_LIMIT', 60), ip: intVar(env, 'DAILY_LIMIT_PER_IP', 12) };
}
/* 残り回数を返す。KVが未設定なら null（呼び出し側で拒否する） */
async function remaining(env, ip) {
  if (!env.RATE_KV) return null;
  const d = jstDate(), L = limits(env);
  const [day, byIp] = await Promise.all([
    kvCount(env, 'day:' + d), kvCount(env, 'ip:' + d + ':' + ip)
  ]);
  return { day: Math.max(0, L.day - day), ip: Math.max(0, L.ip - byIp), limits: L, date: d };
}
/* 1回分を消費する。読み取り→書き込みのため厳密には同時アクセスで数件超過し得るが、
   デモの費用上限としては十分とする（厳密な原子性が必要なら Durable Objects へ） */
async function consume(env, ip) {
  const d = jstDate();
  await Promise.all([
    kvBump(env, 'day:' + d, 2 * 86400), kvBump(env, 'ip:' + d + ':' + ip, 2 * 86400)
  ]);
}

/* ---------- Claude API ---------- */
/* messages API を1回呼び、構造化出力（JSON）を返す。
   thinking は既定（adaptive）に任せ、effort で深さを調整する。 */
export async function callClaude(env, opt) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, 'サーバーにAPIキーが設定されていません（ANTHROPIC_API_KEY）。');
  const model = env.CLAUDE_MODEL || 'claude-opus-5';
  const body = {
    model,
    max_tokens: opt.maxTokens || 16000,
    system: opt.system,
    messages: opt.messages,
    output_config: {
      effort: opt.effort || 'high',
      format: { type: 'json_schema', schema: opt.schema }
    },
    fallbacks: 'default'
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opt.timeoutMs || 170000);
  let res;
  const t0 = Date.now();
  try {
    res = await fetch(env.ANTHROPIC_API_URL || API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': API_VERSION,
        'anthropic-beta': BETA_FALLBACK
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') throw new HttpError(504, 'AIの応答が時間内に返りませんでした。もう一度お試しください。');
    throw new HttpError(502, 'AIへ接続できませんでした。');
  }
  clearTimeout(timer);
  const ms = Date.now() - t0;
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) ? String(data.error.message).slice(0, 300) : ('HTTP ' + res.status);
    const map = { 401: 'サーバーのAPIキーが無効です。', 429: 'AI側の利用制限に達しました。しばらく待ってからお試しください。',
                  529: 'AI側が混雑しています。しばらく待ってからお試しください。' };
    throw new HttpError(502, (map[res.status] || 'AIの呼び出しに失敗しました。') + '（' + msg + '）');
  }
  if (!data || !Array.isArray(data.content)) throw new HttpError(502, 'AIの応答を読み取れませんでした。');
  if (data.stop_reason === 'refusal') {
    const cat = data.stop_details && data.stop_details.category;
    throw new HttpError(502, 'AIが安全上の理由で応答を停止しました' + (cat ? '（区分: ' + cat + '）' : '') + '。写真や入力を見直してください。');
  }
  if (data.stop_reason === 'max_tokens') throw new HttpError(502, 'AIの応答が長すぎて途中で切れました。もう一度お試しください。');
  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const parsed = parseJson(text);
  if (!parsed) throw new HttpError(502, 'AIの応答がJSONとして読み取れませんでした。もう一度お試しください。');
  return {
    data: parsed,
    model: data.model || model,
    usage: data.usage ? { input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens } : null,
    ms
  };
}
/* 構造化出力を使うため通常はそのままJSONだが、念のため前後の文を落として読む */
export function parseJson(text) {
  if (!text) return null;
  const t = String(text).replace(/```json/gi, '```').split('```').join('').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch (err) { return null; }
}

/* ---------- 入力の検証 ---------- */
function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function sizeOf(v) { return JSON.stringify(v == null ? '' : v).length; }

function validateVision(b) {
  if (!isPlainObject(b) || !isPlainObject(b.image)) throw new HttpError(400, '写真データがありません。');
  const mt = String(b.image.media_type || '');
  if (IMAGE_TYPES.indexOf(mt) < 0) throw new HttpError(400, '対応していない画像形式です（JPEG／PNG／WebP）。');
  const d = String(b.image.data || '');
  if (!d) throw new HttpError(400, '写真データが空です。');
  if (d.length > MAX_IMAGE_B64) throw new HttpError(413, '写真データが大きすぎます。解析モードを下げるか、写真を撮り直してください。');
  if (!/^[A-Za-z0-9+/]+=*$/.test(d)) throw new HttpError(400, '写真データの形式が不正です。');
  return { media_type: mt, data: d, mode: String(b.mode || 'std').slice(0, 10) };
}
function validateKy(b) {
  if (!isPlainObject(b)) throw new HttpError(400, 'リクエストの形式が不正です。');
  const stage = b.stage === 'text' ? 'text' : 'vision';
  const inputs = isPlainObject(b.inputs) ? b.inputs : {};
  const observations = isPlainObject(b.observations) ? b.observations : null;
  const checks = isPlainObject(b.checks) ? b.checks : null;
  const nearmiss = typeof b.nearmiss === 'string' ? b.nearmiss : '';
  if (stage === 'vision' && !observations) throw new HttpError(400, '写真の読み取り所見がありません。');
  if (sizeOf(inputs) > 20000 || sizeOf(observations) > 20000 || sizeOf(checks) > 5000) throw new HttpError(413, '入力が長すぎます。');
  if (nearmiss.length > MAX_TEXT_FIELD) throw new HttpError(413, '事例データが長すぎます。');
  return { stage, inputs, observations, checks, hasChecks: !!b.hasChecks, nearmiss };
}

/* 第2段の本文。旧版（画面側で組み立てていた文面）と同じ構成にする */
export function buildKyUserText(p) {
  let out = '入力情報:\n' + JSON.stringify(p.inputs, null, 2);
  if (p.stage === 'vision') {
    out += '\n\n写真の読み取り所見（別工程で写真を目視し、現場責任者が内容を確認済みのもの。現場条件の根拠とする）:\n' +
      JSON.stringify(p.observations, null, 2) + '\n' +
      '\n申告された作業（写真には写っていない。現場責任者がチェックしたもの。これと上の所見を掛け合わせて危険を想定する）:\n' +
      JSON.stringify(p.checks || {}, null, 2) + '\n' +
      (p.hasChecks ? '' : '（申告なし。写真の所見だけで作成し、作業内容を推定しないこと）\n');
  } else {
    out += (p.hasChecks ? '' : '\n（申告も写真もありません。一般的な変電所作業として最小限のKY案を作成し、現地確認事項を重点的に挙げること）\n');
  }
  out += p.nearmiss || '';
  return out;
}

/* ---------- ルーティング ---------- */
function sameOrigin(req, url) {
  const o = req.headers.get('origin');
  if (!o) return true;                 /* 同一サイトのfetchでは付かないことがある */
  return o === url.origin;
}

async function handleApi(req, env, url) {
  const path = url.pathname;
  const ip = clientIp(req);

  if (req.method === 'GET' && path === '/api/session') {
    const ok = await isLoggedIn(env, req);
    const rem = ok ? await remaining(env, ip) : null;
    return json({ ok, configured: !!env.ACCESS_PASSWORD, model: env.CLAUDE_MODEL || 'claude-opus-5', remaining: rem }, ok ? 200 : 401);
  }
  if (req.method !== 'POST') return fail(405, 'Method Not Allowed');
  if (!sameOrigin(req, url)) return fail(403, '許可されていない送信元です。');

  if (path === '/api/login') {
    if (!env.ACCESS_PASSWORD) return fail(503, 'サーバーに合言葉が設定されていません（ACCESS_PASSWORD）。');
    const failKey = 'fail:' + ip;
    if (env.RATE_KV && (await kvCount(env, failKey)) >= LOGIN_FAIL_LIMIT) {
      return fail(429, '合言葉の誤りが続いたため、しばらく受け付けられません。15分ほど待ってからお試しください。');
    }
    const b = await readJson(req);
    const pw = String((b && b.password) || '').slice(0, 200);
    if (!pw || !timingEqual(pw, env.ACCESS_PASSWORD)) {
      if (env.RATE_KV) await kvBump(env, failKey, LOGIN_FAIL_TTL);
      return fail(401, '合言葉が違います。');
    }
    const ttl = intVar(env, 'SESSION_TTL_SEC', 43200);
    const token = await makeToken(env, ttl);
    const rem = await remaining(env, ip);
    return json({ ok: true, remaining: rem, model: env.CLAUDE_MODEL || 'claude-opus-5' }, 200,
      { 'set-cookie': cookieHeader(url, token, ttl) });
  }
  if (path === '/api/logout') {
    return json({ ok: true }, 200, { 'set-cookie': cookieHeader(url, 'x', 0) });
  }

  /* ここから先はログイン必須 */
  if (!(await isLoggedIn(env, req))) return fail(401, 'ログインが必要です。');
  if (path !== '/api/vision' && path !== '/api/ky') return fail(404, 'Not Found');

  if (!env.RATE_KV) return fail(503, 'サーバーに回数制限用のKVが設定されていません（RATE_KV）。');
  const rem = await remaining(env, ip);
  if (rem.day <= 0) return fail(429, '本日の利用上限（全体 ' + rem.limits.day + '回）に達しました。明日以降にお試しください。', { remaining: rem });
  if (rem.ip <= 0) return fail(429, '本日の利用上限（この接続元 ' + rem.limits.ip + '回）に達しました。', { remaining: rem });

  const body = await readJson(req);
  let result;
  if (path === '/api/vision') {
    const v = validateVision(body);
    await consume(env, ip);
    result = await callClaude(env, {
      system: VISION_SYSTEM,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: v.media_type, data: v.data } },
        { type: 'text', text: VISION_USER }
      ] }],
      schema: OBS_JSON_SCHEMA,
      effort: 'medium',
      maxTokens: 8000
    });
  } else {
    const p = validateKy(body);
    await consume(env, ip);
    result = await callClaude(env, {
      system: p.stage === 'vision' ? KY_SYSTEM_VISION : KY_SYSTEM_TEXT,
      messages: [{ role: 'user', content: buildKyUserText(p) }],
      schema: KY_JSON_SCHEMA,
      effort: 'high',
      maxTokens: 16000
    });
  }
  const after = await remaining(env, ip);
  return json({ ok: true, data: result.data, model: result.model, usage: result.usage, ms: result.ms, remaining: after });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        if (e instanceof HttpError) return fail(e.status, e.message, e.extra);
        console.error('unhandled', e && e.stack || e);
        return fail(500, 'サーバー内部でエラーが発生しました。');
      }
    }
    /* 静的ファイル。通常は assets 側で先に処理されるが、Worker に来た場合も配信する */
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not Found', { status: 404 });
  }
};
