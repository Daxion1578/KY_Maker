// Cloudflare Worker (src/worker.js, src/prompts.js) のユニットテスト。
// node:test / node:assert/strict のみを使用。外部パッケージなし。
// 実行: node --test test/

import test from 'node:test';
import assert from 'node:assert/strict';

import worker, { jstDate, parseJson, buildKyUserText, API_URL } from '../src/worker.js';
import {
  VISION_SYSTEM, KY_SYSTEM_VISION, KY_SYSTEM_TEXT
} from '../src/prompts.js';

/* ---------- テスト用の道具 ---------- */

/* KV の簡易モック（Map ベース） */
function makeKV() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value /*, opts */) {
      store.set(key, String(value));
    },
    _store: store
  };
}

function makeEnv(overrides = {}) {
  const env = {
    ANTHROPIC_API_KEY: 'test-api-key',
    ACCESS_PASSWORD: 'kai-gen-mai',
    SESSION_SECRET: 'unit-test-session-secret',
    CLAUDE_MODEL: 'claude-test-model',
    DAILY_LIMIT: '60',
    DAILY_LIMIT_PER_IP: '12',
    SESSION_TTL_SEC: '43200',
    ANTHROPIC_API_URL: 'https://mock.example/v1/messages',
    RATE_KV: makeKV()
  };
  Object.assign(env, overrides);
  return env;
}

function makeRequest(path, opts = {}) {
  const {
    method = 'GET',
    body,
    headers = {},
    origin,
    cookie,
    ip = '203.0.113.10',
    https = true
  } = opts;
  const url = (https ? 'https://demo.example' : 'http://demo.example') + path;
  const h = new Headers(headers);
  if (ip !== null) h.set('cf-connecting-ip', ip);
  if (origin !== undefined) h.set('origin', origin);
  if (cookie !== undefined) h.set('cookie', cookie);
  const init = { method, headers: h };
  if (body !== undefined) {
    h.set('content-type', 'application/json');
    init.body = JSON.stringify(body);
  }
  return new Request(url, init);
}

function cookieValueFromSetCookie(setCookieHeader) {
  assert.ok(setCookieHeader, 'set-cookie header が無い');
  return setCookieHeader.split(';')[0]; // "ky_sess=xxxx"
}

async function login(env, opts = {}) {
  const res = await worker.fetch(
    makeRequest('/api/login', { method: 'POST', body: { password: env.ACCESS_PASSWORD }, ...opts }),
    env, {}
  );
  const cookie = res.ok ? cookieValueFromSetCookie(res.headers.get('set-cookie')) : null;
  return { res, cookie };
}

/* fetch のモックを差し替える。呼び出し後は必ず元に戻す。 */
function installFetchMock(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return async (fn) => {
    try {
      return await fn();
    } finally {
      globalThis.fetch = orig;
    }
  };
}

function refusingFetch() {
  return async () => {
    throw new Error('この経路では fetch は呼ばれない想定だった');
  };
}

function claudeOkResponse(dataObj, opts = {}) {
  const body = {
    model: opts.model || 'claude-test-model',
    stop_reason: opts.stop_reason || 'end_turn',
    stop_details: opts.stop_details,
    content: [{ type: 'text', text: JSON.stringify(dataObj) }],
    usage: { input_tokens: 12, output_tokens: 34 }
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function smallBase64() {
  return Buffer.from('hello-ky-maker').toString('base64');
}

/* ================= 1. GET /api/session, Cookie なし ================= */

test('GET /api/session: Cookieなしは401でok:false', async () => {
  const env = makeEnv();
  const res = await worker.fetch(makeRequest('/api/session'), env, {});
  assert.equal(res.status, 401);
  const j = await res.json();
  assert.equal(j.ok, false);
});

/* ================= 2. ログイン失敗とロックアウト ================= */

test('POST /api/login: 誤った合言葉は401、10回失敗で429', async () => {
  const env = makeEnv();
  const ip = '198.51.100.5';
  for (let i = 0; i < 10; i++) {
    const res = await worker.fetch(
      makeRequest('/api/login', { method: 'POST', body: { password: 'wrong-password' }, ip }),
      env, {}
    );
    assert.equal(res.status, 401, `${i + 1}回目は401のはず`);
    const j = await res.json();
    assert.equal(j.ok, false);
  }
  const res11 = await worker.fetch(
    makeRequest('/api/login', { method: 'POST', body: { password: 'wrong-password' }, ip }),
    env, {}
  );
  assert.equal(res11.status, 429);
  const j11 = await res11.json();
  assert.equal(j11.ok, false);

  // 正しい合言葉でも、ロックアウト中は429のまま
  const res12 = await worker.fetch(
    makeRequest('/api/login', { method: 'POST', body: { password: env.ACCESS_PASSWORD }, ip }),
    env, {}
  );
  assert.equal(res12.status, 429);
});

/* ================= 3. 正しい合言葉でのログインとCookie ================= */

test('POST /api/login: 正しい合言葉は200、set-cookieにHttpOnly/SameSite=Strict', async () => {
  const env = makeEnv();
  const { res, cookie } = await login(env, { ip: '203.0.113.20' });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);

  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /ky_sess=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.ok(cookie.startsWith('ky_sess='));
});

test('POST /api/login: httpsではSecure付与、httpでは付与されない', async () => {
  const env = makeEnv();

  const resHttps = await worker.fetch(
    makeRequest('/api/login', { method: 'POST', body: { password: env.ACCESS_PASSWORD }, https: true, ip: '203.0.113.21' }),
    env, {}
  );
  assert.match(resHttps.headers.get('set-cookie'), /Secure/);

  const resHttp = await worker.fetch(
    makeRequest('/api/login', { method: 'POST', body: { password: env.ACCESS_PASSWORD }, https: false, ip: '203.0.113.22' }),
    env, {}
  );
  assert.doesNotMatch(resHttp.headers.get('set-cookie'), /Secure/);
});

/* ================= 4. Cookieでのセッション確認と残数 ================= */

test('GET /api/session: 正しいCookieで200、remainingが上限値と一致', async () => {
  const env = makeEnv({ DAILY_LIMIT: '60', DAILY_LIMIT_PER_IP: '12' });
  const ip = '203.0.113.30';
  const { cookie } = await login(env, { ip });

  const res = await worker.fetch(makeRequest('/api/session', { cookie, ip }), env, {});
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.remaining.day, 60);
  assert.equal(j.remaining.ip, 12);
});

/* ================= 5. /api/vision, Cookieなし ================= */

test('POST /api/vision: Cookieなしは401', async () => {
  const env = makeEnv();
  const res = await worker.fetch(
    makeRequest('/api/vision', {
      method: 'POST',
      body: { image: { media_type: 'image/jpeg', data: smallBase64() }, mode: 'std' }
    }),
    env, {}
  );
  assert.equal(res.status, 401);
});

/* ================= 6. /api/vision 正常系 ================= */

test('POST /api/vision: Cookieありで200、Claudeへ渡るbodyの形とeffort、remaining.ip減少', async () => {
  const env = makeEnv({ DAILY_LIMIT: '60', DAILY_LIMIT_PER_IP: '12' });
  const ip = '203.0.113.40';
  const { cookie } = await login(env, { ip });

  const obsData = { '作業状況の要約': 'テスト要約', '写真読み取り所見': { '読み取れた要素': ['a'], '判別できなかった要素': ['b'], '画質評価': '良好' } };
  const calls = [];
  const restore = installFetchMock(async (url, init) => {
    calls.push({ url, init });
    return claudeOkResponse(obsData);
  });

  await restore(async () => {
    const b64 = smallBase64();
    const res = await worker.fetch(
      makeRequest('/api/vision', {
        method: 'POST',
        cookie, ip,
        body: { image: { media_type: 'image/jpeg', data: b64 }, mode: 'std' }
      }),
      env, {}
    );
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.deepEqual(j.data, obsData);
    assert.equal(j.remaining.ip, 11); // 12 - 1

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, env.ANTHROPIC_API_URL);
    const h = calls[0].init.headers;
    assert.equal(h['x-api-key'], env.ANTHROPIC_API_KEY);
    assert.equal(h['anthropic-version'], '2023-06-01');
    assert.equal(h['anthropic-beta'], 'server-side-fallback-2026-07-01');

    const sentBody = JSON.parse(calls[0].init.body);
    assert.equal(sentBody.model, env.CLAUDE_MODEL);
    assert.equal(sentBody.system, VISION_SYSTEM);
    assert.equal(sentBody.output_config.format.type, 'json_schema');
    assert.equal(sentBody.output_config.effort, 'medium');
    assert.equal(sentBody.fallbacks, 'default');

    const content = sentBody.messages[0].content;
    assert.ok(Array.isArray(content));
    const imageBlock = content.find(c => c.type === 'image');
    const textBlock = content.find(c => c.type === 'text');
    assert.ok(imageBlock, '画像ブロックが無い');
    assert.equal(imageBlock.source.type, 'base64');
    assert.equal(imageBlock.source.media_type, 'image/jpeg');
    assert.equal(imageBlock.source.data, b64);
    assert.ok(textBlock, 'textブロックが無い');
  });
});

/* ================= 7. 利用上限 ================= */

test('POST /api/vision: DAILY_LIMIT_PER_IP到達で2回目は429', async () => {
  const env = makeEnv({ DAILY_LIMIT: '60', DAILY_LIMIT_PER_IP: '1' });
  const ip = '203.0.113.50';
  const { cookie } = await login(env, { ip });

  const restore = installFetchMock(async () => claudeOkResponse({ ok: true }));
  await restore(async () => {
    const mkReq = () => makeRequest('/api/vision', {
      method: 'POST', cookie, ip,
      body: { image: { media_type: 'image/jpeg', data: smallBase64() }, mode: 'std' }
    });
    const res1 = await worker.fetch(mkReq(), env, {});
    assert.equal(res1.status, 200);

    const res2 = await worker.fetch(mkReq(), env, {});
    assert.equal(res2.status, 429);
    const j2 = await res2.json();
    assert.equal(j2.ok, false);
  });
});

test('POST /api/vision: DAILY_LIMIT到達（全体）は別IPでも429', async () => {
  const env = makeEnv({ DAILY_LIMIT: '1', DAILY_LIMIT_PER_IP: '60' });
  const ipA = '203.0.113.60';
  const ipB = '203.0.113.61';
  const { cookie: cookieA } = await login(env, { ip: ipA });
  const { cookie: cookieB } = await login(env, { ip: ipB });

  const restore = installFetchMock(async () => claudeOkResponse({ ok: true }));
  await restore(async () => {
    const mkReq = (cookie, ip) => makeRequest('/api/vision', {
      method: 'POST', cookie, ip,
      body: { image: { media_type: 'image/jpeg', data: smallBase64() }, mode: 'std' }
    });
    const res1 = await worker.fetch(mkReq(cookieA, ipA), env, {});
    assert.equal(res1.status, 200);

    // 全体の上限に達しているので、別IP・別セッションでも429になる
    const res2 = await worker.fetch(mkReq(cookieB, ipB), env, {});
    assert.equal(res2.status, 429);
  });
});

/* ================= 8. 画像バリデーション ================= */

test('POST /api/vision: 未対応のmedia_type(image/heic)は400', async () => {
  const env = makeEnv();
  const ip = '203.0.113.70';
  const { cookie } = await login(env, { ip });
  const restore = installFetchMock(refusingFetch());
  await restore(async () => {
    const res = await worker.fetch(
      makeRequest('/api/vision', {
        method: 'POST', cookie, ip,
        body: { image: { media_type: 'image/heic', data: smallBase64() }, mode: 'std' }
      }),
      env, {}
    );
    assert.equal(res.status, 400);
  });
});

test('POST /api/vision: base64が6,000,000文字を超えると413', async () => {
  const env = makeEnv();
  const ip = '203.0.113.71';
  const { cookie } = await login(env, { ip });
  const restore = installFetchMock(refusingFetch());
  await restore(async () => {
    const bigData = 'A'.repeat(6_000_001); // 文字集合としては有効、長さ超過
    const res = await worker.fetch(
      makeRequest('/api/vision', {
        method: 'POST', cookie, ip,
        body: { image: { media_type: 'image/jpeg', data: bigData }, mode: 'std' }
      }),
      env, {}
    );
    assert.equal(res.status, 413);
  });
});

test('POST /api/vision: base64に不正な文字が含まれると400', async () => {
  const env = makeEnv();
  const ip = '203.0.113.72';
  const { cookie } = await login(env, { ip });
  const restore = installFetchMock(refusingFetch());
  await restore(async () => {
    const res = await worker.fetch(
      makeRequest('/api/vision', {
        method: 'POST', cookie, ip,
        body: { image: { media_type: 'image/jpeg', data: 'not_base64!!!' }, mode: 'std' }
      }),
      env, {}
    );
    assert.equal(res.status, 400);
  });
});

/* ================= 9. /api/ky stage:text ================= */

test('POST /api/ky: stage=text は200、本文と system, effortを確認', async () => {
  const env = makeEnv();
  const ip = '203.0.113.80';
  const { cookie } = await login(env, { ip });

  const kyData = {
    '選定した事例': [], '危険度': '中', '危険箇所': [],
    'KY4ラウンド': { '第1R_現状把握': '', '第2R_本質追究': '', '第3R_対策樹立': '', '第4R_目標設定': '' },
    '対策案': { '設備対策': [], '管理対策': [], '行動対策': [] },
    '現地確認が必要な事項': [], '過去事例からの示唆': [], '一言行動目標': ''
  };
  const calls = [];
  const restore = installFetchMock(async (url, init) => {
    calls.push({ url, init });
    return claudeOkResponse(kyData);
  });
  await restore(async () => {
    const res = await worker.fetch(
      makeRequest('/api/ky', {
        method: 'POST', cookie, ip,
        body: { stage: 'text', inputs: { '作業行為': ['高所作業'] }, hasChecks: false, nearmiss: '' }
      }),
      env, {}
    );
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.deepEqual(j.data, kyData);

    assert.equal(calls.length, 1);
    const sentBody = JSON.parse(calls[0].init.body);
    assert.equal(sentBody.output_config.effort, 'high');
    assert.equal(sentBody.system, KY_SYSTEM_TEXT);
    assert.match(sentBody.system, /現場写真は提供されていない/);

    const userText = sentBody.messages[0].content;
    assert.equal(typeof userText, 'string');
    assert.match(userText, /入力情報:/);
    assert.match(userText, /申告も写真もありません/);
  });
});

/* ================= 10. /api/ky stage:vision ================= */

test('POST /api/ky: stage=vision でobservationsが無いと400', async () => {
  const env = makeEnv();
  const ip = '203.0.113.90';
  const { cookie } = await login(env, { ip });
  const restore = installFetchMock(refusingFetch());
  await restore(async () => {
    const res = await worker.fetch(
      makeRequest('/api/ky', {
        method: 'POST', cookie, ip,
        body: { stage: 'vision', inputs: {}, hasChecks: false, nearmiss: '' }
      }),
      env, {}
    );
    assert.equal(res.status, 400);
  });
});

test('POST /api/ky: stage=vision, observationsあり・hasChecks:true・nearmissありの本文確認', async () => {
  const env = makeEnv();
  const ip = '203.0.113.91';
  const { cookie } = await login(env, { ip });

  const kyData = {
    '選定した事例': [], '危険度': '低', '危険箇所': [],
    'KY4ラウンド': { '第1R_現状把握': '', '第2R_本質追究': '', '第3R_対策樹立': '', '第4R_目標設定': '' },
    '対策案': { '設備対策': [], '管理対策': [], '行動対策': [] },
    '現地確認が必要な事項': [], '過去事例からの示唆': [], '一言行動目標': ''
  };
  const calls = [];
  const restore = installFetchMock(async (url, init) => {
    calls.push({ url, init });
    return claudeOkResponse(kyData);
  });
  await restore(async () => {
    const res = await worker.fetch(
      makeRequest('/api/ky', {
        method: 'POST', cookie, ip,
        body: {
          stage: 'vision',
          inputs: {},
          observations: { '作業状況の要約': '要約', '写真読み取り所見': { '読み取れた要素': ['x'], '判別できなかった要素': [], '画質評価': '良' } },
          checks: { '作業行為': ['重機作業'] },
          hasChecks: true,
          nearmiss: '■ 候補'
        }
      }),
      env, {}
    );
    assert.equal(res.status, 200);

    const sentBody = JSON.parse(calls[0].init.body);
    assert.equal(sentBody.system, KY_SYSTEM_VISION);
    const userText = sentBody.messages[0].content;
    assert.match(userText, /写真の読み取り所見/);
    assert.match(userText, /申告された作業/);
    assert.match(userText, /■ 候補/);
    assert.doesNotMatch(userText, /申告なし/);
  });
});

/* ================= 11. Claude APIのエラー系 ================= */

test('Claude APIがstop_reason:refusalを返すと502で「安全上の理由」を含む', async () => {
  const env = makeEnv();
  const ip = '203.0.113.100';
  const { cookie } = await login(env, { ip });
  const restore = installFetchMock(async () => claudeOkResponse({}, { stop_reason: 'refusal', stop_details: { category: 'test' } }));
  await restore(async () => {
    const res = await worker.fetch(
      makeRequest('/api/vision', {
        method: 'POST', cookie, ip,
        body: { image: { media_type: 'image/jpeg', data: smallBase64() }, mode: 'std' }
      }),
      env, {}
    );
    assert.equal(res.status, 502);
    const j = await res.json();
    assert.match(j.error, /安全上の理由/);
  });
});

test('Claude APIがstop_reason:max_tokensを返すと502', async () => {
  const env = makeEnv();
  const ip = '203.0.113.101';
  const { cookie } = await login(env, { ip });
  const restore = installFetchMock(async () => claudeOkResponse({}, { stop_reason: 'max_tokens' }));
  await restore(async () => {
    const res = await worker.fetch(
      makeRequest('/api/vision', {
        method: 'POST', cookie, ip,
        body: { image: { media_type: 'image/jpeg', data: smallBase64() }, mode: 'std' }
      }),
      env, {}
    );
    assert.equal(res.status, 502);
  });
});

test('Claude APIがHTTP 429を返すと502で「利用制限」を含む', async () => {
  const env = makeEnv();
  const ip = '203.0.113.102';
  const { cookie } = await login(env, { ip });
  const restore = installFetchMock(async () => new Response(
    JSON.stringify({ error: { message: 'rate limited upstream' } }),
    { status: 429, headers: { 'content-type': 'application/json' } }
  ));
  await restore(async () => {
    const res = await worker.fetch(
      makeRequest('/api/vision', {
        method: 'POST', cookie, ip,
        body: { image: { media_type: 'image/jpeg', data: smallBase64() }, mode: 'std' }
      }),
      env, {}
    );
    assert.equal(res.status, 502);
    const j = await res.json();
    assert.match(j.error, /利用制限/);
  });
});

/* ================= 12. Originチェック ================= */

test('Originがhttps://evil.exampleのPOSTは403', async () => {
  const env = makeEnv();
  const res = await worker.fetch(
    makeRequest('/api/login', {
      method: 'POST',
      body: { password: env.ACCESS_PASSWORD },
      origin: 'https://evil.example'
    }),
    env, {}
  );
  assert.equal(res.status, 403);
});

/* ================= 13. サーバー設定不備 ================= */

test('RATE_KVが無い状態でCookieありの/api/visionは503', async () => {
  const envForLogin = makeEnv();
  const ip = '203.0.113.110';
  const { cookie } = await login(envForLogin, { ip });

  // 同じCookie(セッション)を、RATE_KVを外したenvに対して使う
  const envNoKv = makeEnv({ RATE_KV: undefined, SESSION_SECRET: envForLogin.SESSION_SECRET, ACCESS_PASSWORD: envForLogin.ACCESS_PASSWORD });
  const restore = installFetchMock(refusingFetch());
  await restore(async () => {
    const res = await worker.fetch(
      makeRequest('/api/vision', {
        method: 'POST', cookie, ip,
        body: { image: { media_type: 'image/jpeg', data: smallBase64() }, mode: 'std' }
      }),
      envNoKv, {}
    );
    assert.equal(res.status, 503);
  });
});

test('ANTHROPIC_API_KEY未設定なら503', async () => {
  const env = makeEnv({ ANTHROPIC_API_KEY: undefined });
  const ip = '203.0.113.111';
  const { cookie } = await login(env, { ip });
  const restore = installFetchMock(refusingFetch());
  await restore(async () => {
    const res = await worker.fetch(
      makeRequest('/api/vision', {
        method: 'POST', cookie, ip,
        body: { image: { media_type: 'image/jpeg', data: smallBase64() }, mode: 'std' }
      }),
      env, {}
    );
    assert.equal(res.status, 503);
  });
});

/* ================= 14. エクスポート関数の単体テスト ================= */

test('buildKyUserText: stage=text かつ hasChecks=false は「申告も写真もありません」を含む', () => {
  const text = buildKyUserText({ stage: 'text', inputs: { a: 1 }, hasChecks: false, nearmiss: '' });
  assert.match(text, /入力情報:/);
  assert.match(text, /申告も写真もありません/);
});

test('buildKyUserText: stage=vision, hasChecks=true は所見と申告作業を含み「申告なし」は含まない', () => {
  const text = buildKyUserText({
    stage: 'vision',
    inputs: {},
    observations: { foo: 'bar' },
    checks: { baz: 'qux' },
    hasChecks: true,
    nearmiss: '■ 事例X'
  });
  assert.match(text, /写真の読み取り所見/);
  assert.match(text, /申告された作業/);
  assert.match(text, /■ 事例X/);
  assert.doesNotMatch(text, /申告なし/);
});

test('buildKyUserText: stage=vision, hasChecks=false は「申告なし」を含む', () => {
  const text = buildKyUserText({
    stage: 'vision',
    inputs: {},
    observations: { foo: 'bar' },
    checks: {},
    hasChecks: false,
    nearmiss: ''
  });
  assert.match(text, /申告なし/);
});

test('parseJson: コードフェンス付き文字列からJSONを取り出せる', () => {
  const fenced = '```json\n{"a":1,"b":"ok"}\n```';
  assert.deepEqual(parseJson(fenced), { a: 1, b: 'ok' });
});

test('parseJson: 前後に説明文が付いていても中のJSONを取り出せる', () => {
  const withPrefix = '出力結果は以下です:\n{"x":true}\n以上になります。';
  assert.deepEqual(parseJson(withPrefix), { x: true });
});

test('parseJson: JSONとして解釈できない場合はnull', () => {
  assert.equal(parseJson('これはJSONではありません'), null);
  assert.equal(parseJson(''), null);
  assert.equal(parseJson(null), null);
});

test('jstDate: UTC 2026-09-14T20:00:00Z は日本時間で2026-09-15', () => {
  const ms = Date.parse('2026-09-14T20:00:00Z');
  assert.equal(jstDate(ms), '2026-09-15');
});

test('jstDate: UTC 2026-09-14T00:00:00Z は日本時間で2026-09-14', () => {
  const ms = Date.parse('2026-09-14T00:00:00Z');
  assert.equal(jstDate(ms), '2026-09-14');
});

test('API_URL は既定のClaude APIエンドポイントを指す', () => {
  assert.equal(API_URL, 'https://api.anthropic.com/v1/messages');
});

/* ================= 15. 回数消費のタイミング ================= */

async function remainingIp(env, cookie, ip) {
  const res = await worker.fetch(makeRequest('/api/session', { cookie, ip }), env, {});
  return (await res.json()).remaining.ip;
}

test('上流がHTTP 429（AIに到達しない失敗）のときは回数を消費しない', async () => {
  const env = makeEnv();
  const ip = '203.0.113.150';
  const { cookie } = await login(env, { ip });
  const before = await remainingIp(env, cookie, ip);
  const restore = installFetchMock(async () => new Response(
    JSON.stringify({ error: { message: 'rate limited upstream' } }),
    { status: 429, headers: { 'content-type': 'application/json' } }
  ));
  await restore(async () => {
    const res = await worker.fetch(makeRequest('/api/vision', {
      method: 'POST', cookie, ip,
      body: { image: { media_type: 'image/jpeg', data: smallBase64() }, mode: 'std' }
    }), env, {});
    assert.equal(res.status, 502);
  });
  assert.equal(await remainingIp(env, cookie, ip), before);
});

test('refusal（AI側で処理が走った失敗）のときは回数を消費する', async () => {
  const env = makeEnv();
  const ip = '203.0.113.151';
  const { cookie } = await login(env, { ip });
  const before = await remainingIp(env, cookie, ip);
  const restore = installFetchMock(async () => claudeOkResponse({}, {
    stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'other' }
  }));
  await restore(async () => {
    const res = await worker.fetch(makeRequest('/api/vision', {
      method: 'POST', cookie, ip,
      body: { image: { media_type: 'image/jpeg', data: smallBase64() }, mode: 'std' }
    }), env, {});
    assert.equal(res.status, 502);
  });
  assert.equal(await remainingIp(env, cookie, ip), before - 1);
});

test('入力検証で弾かれた（400）ときは回数を消費しない', async () => {
  const env = makeEnv();
  const ip = '203.0.113.152';
  const { cookie } = await login(env, { ip });
  const before = await remainingIp(env, cookie, ip);
  const restore = installFetchMock(refusingFetch());
  await restore(async () => {
    const res = await worker.fetch(makeRequest('/api/vision', {
      method: 'POST', cookie, ip,
      body: { image: { media_type: 'image/heic', data: smallBase64() }, mode: 'std' }
    }), env, {});
    assert.equal(res.status, 400);
  });
  assert.equal(await remainingIp(env, cookie, ip), before);
});

test('本文サイズはバイト数で判定する（マルチバイト文字で8MB超は413）', async () => {
  const env = makeEnv();
  const ip = '203.0.113.153';
  const { cookie } = await login(env, { ip });
  /* 3バイト文字×3,000,000 = 9MB（文字数は300万で8,388,608未満） */
  const big = 'あ'.repeat(3000000);
  const restore = installFetchMock(refusingFetch());
  await restore(async () => {
    const res = await worker.fetch(makeRequest('/api/ky', {
      method: 'POST', cookie, ip,
      body: { stage: 'text', inputs: { 作業内容: big }, hasChecks: true, nearmiss: '' }
    }), env, {});
    assert.equal(res.status, 413);
  });
});
