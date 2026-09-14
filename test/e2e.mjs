// KY_Maker 通し試験（ブラウザE2E）
// 実行: node test/e2e.mjs
// 外部パッケージなし。Playwright はグローバル導入済みのものを createRequire で読み込む。
//
// 構成:
//   1. モック Claude API サーバー（Node http） — /v1/messages を受けて第1段/第2段の応答を返す
//   2. アプリサーバー（Node http） — /api/* は src/worker.js の fetch にそのまま中継、
//      それ以外は public/index.html を返す
//   3. Playwright（Chromium, headless）でSTEP1〜5を実際に操作し、期待どおりに動くか検証する
//
// 各チェックは try/catch で独立させ、失敗しても後続を続行し、最後にOK/NG一覧と終了コードを出す。

import http from 'node:http';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCRATCH = '/tmp/claude-0/-home-user-KY-Maker/9b7ba4c7-e36f-5bef-93e9-c5ec145c7ed1/scratchpad';

process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

import workerModule from '../src/worker.js';

/* ============================================================
   結果集計
   ============================================================ */
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? 'OK' : 'NG';
  console.log(tag + ': ' + name + (detail ? '  — ' + detail : ''));
}
async function check(name, fn) {
  try {
    await fn();
    record(name, true);
  } catch (e) {
    record(name, false, (e && e.message) || String(e));
  }
}
function assertTrue(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertIncludes(hay, needle, msg) {
  if (String(hay).indexOf(needle) < 0) {
    throw new Error((msg || 'expected text to include') + ' [' + needle + ']  実際: ' + String(hay).slice(0, 300));
  }
}

/* ============================================================
   テスト用PNG画像の自作（zlibのみ使用）
   640x480、単色地に数本の線を引いた簡易画像。
   ============================================================ */
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function makeTestPng(w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(w, 0);
  ihdrData.writeUInt32BE(h, 4);
  ihdrData[8] = 8;   // bit depth
  ihdrData[9] = 2;   // color type: RGB
  ihdrData[10] = 0;  // compression
  ihdrData[11] = 0;  // filter
  ihdrData[12] = 0;  // interlace
  const ihdr = chunk('IHDR', ihdrData);

  // 模擬現場写真: 背景を淡いグレーにし、コーンらしき縦線、足場らしき横線、
  // 開口部らしき黒い矩形を描く。単色より情報量を持たせる。
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0; // filter type: none
    for (let x = 0; x < w; x++) {
      let r = 200, g = 200, b = 205; // 背景（コンクリート風）
      // 上部の帯（空）
      if (y < h * 0.25) { r = 180; g = 200; b = 220; }
      // 中央の「開口部」を模した黒い矩形
      if (x > w * 0.40 && x < w * 0.60 && y > h * 0.45 && y < h * 0.85) { r = 20; g = 20; b = 20; }
      // 左手前の「コーン」風の縦縞
      if (x > w * 0.08 && x < w * 0.14 && y > h * 0.6 && y < h * 0.92) { r = 230; g = 120; b = 40; }
      // 右手前の「積み上げ資材」風の横縞
      if (x > w * 0.72 && x < w * 0.94 && y > h * 0.55 && y < h * 0.9) {
        r = ((y >> 3) % 2 === 0) ? 150 : 170; g = r; b = r - 10;
      }
      // 中央奥の「足場」風の横線
      if (y > h * 0.32 && y < h * 0.36) { r = 90; g = 90; b = 95; }
      raw[p++] = r; raw[p++] = g; raw[p++] = b;
    }
  }
  const idatData = zlib.deflateSync(raw, { level: 6 });
  const idat = chunk('IDAT', idatData);
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

/* ============================================================
   モック Claude API サーバー
   ============================================================ */
const VISION_JSON = {
  '作業状況の要約': '模擬現場。資材が積まれ開口部がある。',
  '写真読み取り所見': {
    '読み取れた要素': [
      '左手前 コーン4本 連結なし',
      '中央奥 単管足場 2段 手すりあり',
      '右手前 コンクリート製品 3段積み 固縛なし',
      '中央 開口部 囲い一部途切れ',
      '左奥 仮設フェンス 網目あり',
      '右奥 ケーブルラック 2段',
      '中央手前 砂利敷き 段差あり',
      '左中 脚立 1台 開いた状態'
    ],
    '判別できなかった要素': [
      '開口部の深さと内部の配管状況',
      '積上げ製品の固縛の有無',
      '充電部の有無と離隔',
      '脚立の固定状態'
    ],
    '画質評価': '全体は判別可。小物金具は判読不能'
  }
};
const KY_JSON = {
  '選定した事例': [],
  '危険度': '高',
  '危険箇所': [
    { '箇所': '中央の開口部', '想定災害': '墜落・転落', '根拠': '囲いが途切れており申告の搬入作業で近づく', '参考事例': '' },
    { '箇所': '右手前の積上げ製品', '想定災害': '飛来・落下', '根拠': '3段積みで固縛が見えない', '参考事例': '' }
  ],
  'KY4ラウンド': {
    '第1R_現状把握': '開口部の囲いが途切れている',
    '第2R_本質追究': '搬入時に足元を見ずに近づく',
    '第3R_対策樹立': '囲いを復旧し立入区画を明示する',
    '第4R_目標設定': '開口部に近づく前に囲いを確認'
  },
  '対策案': {
    '設備対策': ['開口部の囲いを復旧せよ', '積上げ製品を固縛せよ'],
    '管理対策': ['搬入経路を事前に指定せよ', '作業前に開口部を点検せよ'],
    '行動対策': ['足元を確認して歩け', '荷の下に入るな']
  },
  '現地確認が必要な事項': ['開口部の深さ', '製品の固縛状態'],
  '過去事例からの示唆': [],
  '一言行動目標': '開口部の囲いを確認してから作業'
};

const mockCalls = []; // { headers, body(parsed) }

function startMockClaudeServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/messages') {
        res.writeHead(404).end('not found');
        return;
      }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(raw); } catch (e) { body = null; }
        const headers = Object.assign({}, req.headers);
        mockCalls.push({ headers, body });

        const msgs = (body && body.messages) || [];
        const content0 = msgs[0] && msgs[0].content;
        const hasImage = Array.isArray(content0) && content0.some((b) => b && b.type === 'image');
        const dataObj = hasImage ? VISION_JSON : KY_JSON;

        const respBody = {
          id: 'msg_x',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(dataObj) }],
          usage: { input_tokens: 1500, output_tokens: 400 }
        };
        const out = Buffer.from(JSON.stringify(respBody), 'utf8');
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': out.length });
        res.end(out);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/* ============================================================
   アプリサーバー（Worker を中継）
   ============================================================ */
function makeRateKv() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, String(value)); }
  };
}

async function startAppServer(mockPort) {
  const indexHtml = await readFile(path.join(ROOT, 'public', 'index.html'));
  const env = {
    ANTHROPIC_API_KEY: 'test-key',
    ACCESS_PASSWORD: 'demo-pass',
    ANTHROPIC_API_URL: 'http://127.0.0.1:' + mockPort + '/v1/messages',
    CLAUDE_MODEL: 'claude-opus-5',
    DAILY_LIMIT: '10',
    DAILY_LIMIT_PER_IP: '10',
    RATE_KV: makeRateKv()
  };

  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      (async () => {
        const url = req.url || '/';
        if (url.startsWith('/api/')) {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const bodyBuf = Buffer.concat(chunks);

          const hdrs = {};
          if (req.headers['content-type']) hdrs['content-type'] = req.headers['content-type'];
          if (req.headers['cookie']) hdrs['cookie'] = req.headers['cookie'];
          if (req.headers['origin']) hdrs['origin'] = req.headers['origin'];
          hdrs['cf-connecting-ip'] = '127.0.0.1';

          const fullUrl = 'http://127.0.0.1:' + server.address().port + url;
          const init = { method: req.method, headers: hdrs };
          if (bodyBuf.length) init.body = bodyBuf;
          const request = new Request(fullUrl, init);

          const response = await workerModule.fetch(request, env, {});
          const buf = Buffer.from(await response.arrayBuffer());

          response.headers.forEach((v, k) => {
            if (k.toLowerCase() === 'set-cookie') return; // 個別処理
            res.setHeader(k, v);
          });
          const setCookies = (typeof response.headers.getSetCookie === 'function')
            ? response.headers.getSetCookie()
            : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
          if (setCookies.length) res.setHeader('set-cookie', setCookies);

          res.writeHead(response.status);
          res.end(buf);
          return;
        }
        // 静的ファイル: 単一HTMLのみ配信すれば足りる
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(indexHtml);
      })().catch((e) => {
        try {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('internal error: ' + (e && e.stack || e));
        } catch (e2) { /* noop */ }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/* ============================================================
   メイン
   ============================================================ */
async function main() {
  const mockServer = await startMockClaudeServer();
  const mockPort = mockServer.address().port;
  const appServer = await startAppServer(mockPort);
  const appPort = appServer.address().port;
  const baseUrl = 'http://127.0.0.1:' + appPort;

  const pngPath = path.join(SCRATCH, 'ky-test-photo.png');
  await (await import('node:fs/promises')).writeFile(pngPath, makeTestPng(640, 480));

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err && err.stack || err)));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const t = msg.text();
    // 「合言葉が違います」「未ログイン」を試験するため401を意図的に発生させている。
    // これはブラウザがネットワークの失敗ステータスを自動でconsoleへ出す定型メッセージで、
    // アプリのJSが呼んだ console.error ではない（index.htmlにconsole.error呼び出しは無い）。
    // 実際のJSエラー（未定義参照など）はこのパターンに一致しないため、除外しても検出漏れにならない。
    if (/Failed to load resource: the server responded with a status of 401/.test(t)) return;
    consoleErrors.push(t);
  });

  try {
    await check('a. ページを開くと#loginPopが表示されている', async () => {
      await page.goto(baseUrl + '/', { waitUntil: 'load', timeout: 30000 });
      await page.waitForSelector('#loginPop:not([hidden])', { timeout: 15000 });
      const hidden = await page.$eval('#loginPop', (el) => el.hidden);
      assertTrue(hidden === false, '#loginPop が表示されていない');
    });

    await check('b. 誤った合言葉で#loginErrにエラー文言', async () => {
      await page.fill('#loginPw', 'wrong-password');
      await page.click('#loginBtn');
      await page.waitForFunction(
        () => (document.getElementById('loginErr').textContent || '').includes('合言葉が違います'),
        { timeout: 15000 }
      );
      const t = await page.$eval('#loginErr', (el) => el.textContent);
      assertIncludes(t, '合言葉が違います');
    });

    await check('c. 正しい合言葉でログインし#loginPopが閉じ#quotaBadgeに残り10回', async () => {
      await page.fill('#loginPw', 'demo-pass');
      await page.click('#loginBtn');
      await page.waitForFunction(() => document.getElementById('loginPop').hidden === true, { timeout: 15000 });
      await page.waitForFunction(
        () => (document.getElementById('quotaBadge').textContent || '').includes('本日の残り 10回'),
        { timeout: 15000 }
      );
    });

    await check('d. 写真登録で#imgMetaと#modeMetaに送信サイズが表示', async () => {
      await page.setInputFiles('#photoInput', pngPath);
      await page.waitForFunction(() => {
        const m = document.getElementById('imgMeta').textContent || '';
        return /\d+×\d+/.test(m);
      }, { timeout: 15000 });
      await page.waitForFunction(() => {
        const m = document.getElementById('modeMeta').textContent || '';
        return m.indexOf('×') >= 0 && m.indexOf('KB') >= 0;
      }, { timeout: 15000 });
    });

    await check('e. AIで写真を解析クリックでSTEP2(#view-check)へ、#chkBanner表示', async () => {
      await page.click('#visionBtn');
      await page.waitForFunction(() => document.getElementById('view-check').classList.contains('active'), { timeout: 15000 });
      await page.waitForSelector('#chkBanner:not([hidden])', { timeout: 15000 });
    });

    await check('f. 作業チェックを2件選択', async () => {
      await page.check('#grpAxA input[value="搬入・揚重"]');
      await page.check('#grpAxB input[value="基礎・地下"]');
      const n1 = await page.isChecked('#grpAxA input[value="搬入・揚重"]');
      const n2 = await page.isChecked('#grpAxB input[value="基礎・地下"]');
      assertTrue(n1 && n2, 'チェックが反映されていない');
    });

    await check('g. STEP3へ進み目視結果8件と性能パネルを確認', async () => {
      const btn = page.locator('#actionbar button', { hasText: /チェック完了・次へ進む|目視結果を確認する/ });
      await btn.first().waitFor({ state: 'visible', timeout: 30000 });
      await btn.first().click();
      await page.waitForFunction(() => document.getElementById('view-vision').classList.contains('active'), { timeout: 15000 });

      await page.waitForFunction(() => {
        const b = document.getElementById('visionBody');
        return b && getComputedStyle(b).display !== 'none';
      }, { timeout: 60000 });

      await page.waitForFunction(() => document.querySelectorAll('#vSeen li').length === 8, { timeout: 60000 });
      const vcSeen = await page.$eval('#vcSeen', (el) => el.textContent);
      assertIncludes(vcSeen, '8件');
      const vq = await page.$eval('#vQuality', (el) => el.textContent.trim());
      assertTrue(vq.length > 0, '#vQuality が空');

      await page.waitForSelector('#perfBox:not([hidden])', { timeout: 15000 });
      const perfMeta = await page.$eval('#perfMeta', (el) => el.textContent);
      assertIncludes(perfMeta, 'claude-opus-5');
      assertIncludes(perfMeta, '1500／400');
    });

    await check('h. モックが受けた第1段リクエストの検証', async () => {
      const call = mockCalls.find((c) => Array.isArray(c.body && c.body.messages && c.body.messages[0] && c.body.messages[0].content)
        && c.body.messages[0].content.some((b) => b.type === 'image'));
      assertTrue(!!call, '第1段（画像あり）リクエストが記録されていない');
      assertIncludes(call.headers['anthropic-beta'] || '', 'server-side-fallback-2026-07-01');
      assertTrue(call.headers['x-api-key'] === 'test-key', 'x-api-key が一致しない: ' + call.headers['x-api-key']);
      assertTrue(call.body.output_config && call.body.output_config.format && call.body.output_config.format.type === 'json_schema',
        'output_config.format.type が json_schema でない');
      const content = call.body.messages[0].content;
      assertTrue(content[0].type === 'image', 'content[0]がimageでない: ' + content[0].type);
      const mt = content[0].source && content[0].source.media_type;
      assertTrue(mt === 'image/webp' || mt === 'image/jpeg', 'media_typeが想定外: ' + mt);
      assertTrue(call.body.fallbacks === 'default', 'fallbacksがdefaultでない: ' + call.body.fallbacks);
    });

    await check('i. KY案作成クリックでSTEP4(#view-result)へ、内容が本文に含まれる', async () => {
      const btn = page.locator('#actionbar button', { hasText: 'この内容でKY案を作成' });
      await btn.waitFor({ state: 'visible', timeout: 15000 });
      await btn.click();
      await page.waitForFunction(() => document.getElementById('view-result').classList.contains('active'), { timeout: 15000 });
      await page.waitForFunction(() => {
        const b = document.getElementById('resultBody');
        return b && getComputedStyle(b).display !== 'none';
      }, { timeout: 60000 });
      const body = await page.$eval('#resultBody', (el) => el.textContent);
      assertIncludes(body, '中央の開口部');
      assertIncludes(body, '開口部の囲いを確認してから作業');
    });

    await check('j. モックが受けた第2段リクエストの検証', async () => {
      const call = mockCalls.find((c) => c.body && typeof c.body.messages[0].content === 'string');
      assertTrue(!!call, '第2段（テキストのみ）リクエストが記録されていない');
      assertIncludes(call.body.system || '', 'KY案の作成を依頼された');
      const userText = call.body.messages[0].content;
      assertIncludes(userText, '写真の読み取り所見');
      assertIncludes(userText, '申告された作業');
      assertIncludes(userText, '搬入・揚重');
    });

    await check('k. #quotaBadgeが本日の残り8回になっている', async () => {
      await page.waitForFunction(
        () => (document.getElementById('quotaBadge').textContent || '').includes('本日の残り 8回'),
        { timeout: 15000 }
      );
    });

    await check('l. 記録へ進むでSTEP5(#view-record)へ、collect()の内容確認', async () => {
      const btn = page.locator('#actionbar button', { hasText: '記録へ進む' });
      await btn.waitFor({ state: 'visible', timeout: 15000 });
      await btn.click();
      await page.waitForFunction(() => document.getElementById('view-record').classList.contains('active'), { timeout: 15000 });
      const data = await page.evaluate(() => collect());
      assertTrue(data['アプリ版数'] === 'v2.0.0', 'アプリ版数不一致: ' + data['アプリ版数']);
      assertTrue(data['危険度'] === '高', '危険度不一致: ' + data['危険度']);
      assertIncludes(data['解析モード'], '1024px');
    });

    await check('m. downloadCsvが関数であること', async () => {
      const isFn = await page.evaluate(() => typeof downloadCsv === 'function');
      assertTrue(isFn, 'downloadCsv が関数でない');
    });

    await check('n. 速度優先モードへ切替後#modeMetaに反映', async () => {
      // #modes はSTEP1（写真登録画面）にある。STEP5から一旦STEP1表示へ戻す。
      await page.click('#tab-input');
      await page.waitForFunction(() => document.getElementById('view-input').classList.contains('active'), { timeout: 15000 });
      await page.click('#modes button[data-mode="fast"]');
      await page.waitForFunction(() => {
        const t = document.getElementById('modeMeta').textContent || '';
        return t.indexOf('800') >= 0 || t.indexOf('速度優先') >= 0;
      }, { timeout: 15000 });
      const t = await page.$eval('#modeMeta', (el) => el.textContent);
      assertTrue(t.indexOf('800') >= 0 || t.indexOf('速度優先') >= 0, '#modeMeta に反映されていない: ' + t);
    });

    await check('o. pageerror/console.errorが0件であること', async () => {
      const detail = pageErrors.concat(consoleErrors).join(' | ');
      assertTrue(pageErrors.length === 0 && consoleErrors.length === 0,
        'pageerror=' + pageErrors.length + ' console.error=' + consoleErrors.length + (detail ? ' : ' + detail : ''));
    });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await new Promise((r) => appServer.close(r));
    await new Promise((r) => mockServer.close(r));
  }
}

main().then(() => {
  const fail = results.filter((r) => !r.ok);
  console.log('');
  console.log('=== 結果: ' + (results.length - fail.length) + '/' + results.length + ' OK ===');
  if (fail.length) {
    console.log('失敗した項目:');
    fail.forEach((r) => console.log('  - ' + r.name + ': ' + r.detail));
    process.exit(1);
  }
  process.exit(0);
}).catch((e) => {
  console.error('NG: 致命的エラーで試験を実行できませんでした');
  console.error(e && e.stack || e);
  process.exit(1);
});
