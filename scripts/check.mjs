/* 静的検査: public/index.html の構文、内蔵事例の展開、旧ホスト由来の識別子の残存。
   実行: node scripts/check.mjs */
import fs from 'node:fs';
import zlib from 'node:zlib';
import vm from 'node:vm';

let ng = 0;
const ok = (c, m) => { console.log((c ? 'OK: ' : 'NG: ') + m); if (!c) ng++; };

const h = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const scripts = [...h.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
ok(scripts.length === 1, 'インラインスクリプトは1本（' + scripts.length + '本）');
for (const [i, s] of scripts.entries()) {
  try { new vm.Script(s); ok(true, 'スクリプト' + i + ' 構文'); } catch (e) { ok(false, 'スクリプト' + i + ' 構文: ' + e.message); }
}
const m = h.match(/var NM_DATA = '([^']+)'/);
ok(!!m, '内蔵事例データあり');
if (m) {
  const txt = zlib.gunzipSync(Buffer.from(m[1], 'base64')).toString('utf8');
  const recs = txt.split('\x1e').filter(Boolean);
  ok(recs.length === 60, '内蔵事例 60件（' + recs.length + '件）');
  ok(recs.every(r => r.split('\x1f').length === 6), '6列形式');
  ok(recs.every(r => r.split('\x1f')[0] === ''), '発生日は空欄');
}
for (const bad of ['GleanBridge', 'callAgent', 'chunkBody', 'CHUNK_CHARS', 'data-glean-id', 'gleanId']) {
  ok(!h.includes(bad), '残存なし: ' + bad);
}
ok(/var APP_VERSION = 'v2\./.test(h), '版数 v2.x');
ok(!/sk-ant-|api[_-]?key\s*[:=]\s*['"][A-Za-z0-9]/i.test(h), 'APIキー様の文字列なし');
ok(!/https?:\/\/(?!www\.w3\.org)/.test(h), '外部URLなし');

for (const f of ['../src/worker.js', '../src/prompts.js']) {
  const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  ok(!/sk-ant-[A-Za-z0-9]/.test(src), f + ' にAPIキー様の文字列なし');
}
console.log(ng ? `\n${ng}件のNG` : '\nすべてOK');
process.exit(ng ? 1 : 0);
