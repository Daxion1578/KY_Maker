# 現場写真AI-KY支援アプリ（公開デモ）v2.0.0

現場写真をスマホで撮影すると、AI（Claude）が写真を読み取った所見と、利用者が申告した作業条件を掛け合わせてKY（危険予知）案を作る試作アプリです。内蔵の事例60件はすべて架空データで、実際に発生した事故・ヒヤリハットではありません。

このアプリは Cloudflare Workers という無料枠のあるサーバーサービスの上で動きます。以下の手順どおりに進めれば、ソフトウェア開発の経験がなくても自分のアカウントに配置できます。

## 1. できること・構成

- Cloudflare Workers（サーバー機能）が1つあり、次の2つを兼ねています。
  1. `public/index.html`（画面・事例検索・帳票をまとめた単一のHTML）の配信
  2. `/api/*`（合言葉によるログイン、利用回数の制限、Claude API への中継）
- Claude を呼び出すためのAPIキーは、Cloudflare の「Secret（秘密情報）」としてサーバー側だけに保存します。画面のHTML、Gitリポジトリ、ブラウザのどこにも書き込まれません。
- `legacy/ai_ky_demo_public.html` は v1.x（リファクタリング前）の参照用ファイルです。別のホスト環境のブリッジに依存し、画像をbase64テキストに変換して転記する仕組みでした。v2.0.0 では Claude API に画像を直接送るため、この転記の工程は不要になっています。legacy 単体では動作しません。

## 2. 始める前に用意するもの

- Node.js 20以上
- Cloudflare アカウント（無料プランで可）
- Anthropic の API キー（https://console.anthropic.com/ で発行。従量課金）

## 3. 配置手順

以下を順番に実行してください。コマンドはターミナル（Mac は「ターミナル」、Windows は「PowerShell」など）に入力します。

1. リポジトリを取得し、依存パッケージ（wrangler）をインストールします。

```
git clone <このリポジトリのURL>
cd KY_Maker
npm install
```

2. Cloudflare にログインします。ブラウザが開くので画面の指示に従って認証してください。

```
npx wrangler login
```

3. 利用回数を数えるためのデータベース（KV）を作成します。このリポジトリの `wrangler.toml` には作成済みのKV（title: RATE_KV）の id が入っています。別のアカウントで配置する場合だけ、次を実行して表示された `id` の値で `wrangler.toml` の `[[kv_namespaces]]` の `id` を置き換えてください。

```
npx wrangler kv namespace create RATE_KV
```

4. 秘密情報（APIキーと合言葉）を登録します。それぞれ実行すると値の入力を求められます。

```
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put ACCESS_PASSWORD
```

`SESSION_SECRET`（ログインCookieの署名に使う文字列）は任意です。設定しない場合は合言葉から自動的に作られます。必要なら次も実行してください。

```
npx wrangler secret put SESSION_SECRET
```

5. 必要に応じて `wrangler.toml` の `[vars]` を編集します。使用するAIモデルや1日あたりの利用回数上限をここで調整できます（詳しくは「5. 主な設定項目」を参照）。

6. 配置します。

```
npx wrangler deploy
```

成功すると `https://ky-maker.<あなたのアカウント名>.workers.dev` という形のURLが表示されます。これをブラウザで開き、手順4で設定した合言葉を入力すると使えます。

## 4. 手元での動作確認（任意）

配置前に自分のパソコンだけで動きを確認したい場合は、次の手順を行います。

1. `.dev.vars.example` を `.dev.vars` という名前でコピーし、中の値（APIキー・合言葉）を書き換えます。`.dev.vars` はGitに含まれません。
2. 次のコマンドで起動します。

```
npx wrangler dev
```

このローカル起動でも、Claude API へは実際に接続され課金が発生します。回数制限のKVはローカル環境の模擬データを使うため、本番の利用回数とは別に数えられます。

## 5. 主な設定項目（wrangler.toml の `[vars]`）

- `CLAUDE_MODEL`：使用するモデル。既定は `claude-opus-5`。費用を抑えたい場合は `claude-sonnet-5` に変更します。
  - Anthropic公表の目安単価（100万トークンあたり）：Opus 5 は入力$5／出力$25、Sonnet 5 は入力$2／出力$10。
  - 写真1枚（長辺1024px程度）の読み取りは約1,500トークン、KY案の生成は候補事例を含めて入力1〜2万トークン程度になる見込みですが、実測して確認してください。
- `DAILY_LIMIT`：1日（日本時間）あたりの全体のAI呼び出し上限。既定60。写真1枚のKY作成で2回（写真の目視＋KY案の作成）を消費します。
- `DAILY_LIMIT_PER_IP`：同一の接続元（IPアドレス）からの1日あたりの上限。既定12。
- `SESSION_TTL_SEC`：ログインの有効時間（秒）。既定43200秒（12時間）。

回数の数え方は「読み取ってから書き込む」方式のため、同時に複数人がアクセスすると上限を数回超えることがあります。厳密な上限ではなく、費用の目安として設計されています。

## 6. 更新・停止

コードを変更したときや、リポジトリの更新を取り込んだときは、次のコマンドで反映します。

```
git pull
npx wrangler deploy
```

アプリの提供をやめる場合は次のコマンドで削除します。

```
npx wrangler delete
```

## 7. テスト

Worker側のロジックを検証する自動テストがあります。Claude APIそのものは呼ばず、模擬（モック）で確認するものです。

```
npm test
```

画面側の静的検査（構文、内蔵事例60件、旧ホスト由来の識別子の残存）と、ブラウザによる通し試験（Claude APIは模擬）は次で実行できます。通し試験には Playwright と Chromium が必要です。

```
node scripts/check.mjs
node test/e2e.mjs
```

## 8. 認証とログインについて

合言葉は1つだけです（`ACCESS_PASSWORD`）。正しく入力するとHttpOnly・SameSite=Strict・署名付きのCookieが発行され、既定で12時間有効です。合言葉を15分間に10回間違えると、その接続元は一時的にロックされます。

## 9. 注意事項

- 公開する前に、必ず所属組織の承認を得てください。
- 実在する会社名・設備名や、機密性のある写真を入力しないでください。撮影した写真と入力した内容は、応答生成のためClaude API（Anthropic社）へ送信されます。Anthropic社の利用規約・データ保持方針に従って扱われます。
- 合言葉を知っている人は全員、同じ利用回数の上限を共有します。上限に達すると、翌日（日本時間の日付が変わるまで）は利用できません。
- 費用の上限は、このアプリの回数制限によって一定程度抑えられます。あわせて、Anthropic Console側でも月額の利用上限（Spend limit）を設定することを推奨します。
- AIによる判定はあくまで参考情報です。最終的な安全確認は、現場責任者が現地で行ってください。
- 未確認事項：実機（iPhoneなど）を使った一連の操作確認、実際のClaude API応答による内容の品質評価は、このリポジトリの作成時点では行っていません。

## 10. ファイル構成

- `public/index.html`：画面本体（事例検索・帳票を含む単一HTML）
- `src/worker.js`：サーバー側の処理（ログイン、回数制限、Claude API中継）
- `src/prompts.js`：AIへの指示文と出力の形式（JSON schema）
- `wrangler.toml`：Cloudflare Workersの設定
- `test/`：自動テスト
- `legacy/`：v1.x時代の参照用ファイル（単体では動作しません）
- `AI_KY_app_development_ledger_public.md`：開発の実績・機能台帳
- `PUBLIC_RELEASE_REVIEW.md`：公開前確認の記録
