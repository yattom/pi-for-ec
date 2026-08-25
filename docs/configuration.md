# 設定リファレンス

## 設定ファイルの場所

後に読まれたものが強く、深いマージが行われます（配列は置き換え）。

1. コード内の既定値（`extensions/ec-concierge/config.ts` の `DEFAULT_CONFIG`）
2. `~/.pi/agent/ec-concierge.json` — 個人設定。APIキーはここに
3. `<プロジェクト>/.pi/ec-concierge.json` — プロジェクト設定（pi でそのプロジェクトを trust したときだけ読まれる）
4. `$PI_EC_CONFIG` が指すファイル
5. 環境変数 `PI_EC_MODEL_<ROLE>`（ロール別モデルの上書き）

読み込み結果は `/ec-config` で確認できます。`/ec-reload` で読み直せます。

## 秘密情報の書き方

`apiKey` などの文字列は pi の `models.json` と同じ記法が使えます。

| 書き方 | 意味 |
|---|---|
| `"$MY_KEY"` / `"${MY_KEY}"` | 環境変数を展開する（未設定なら「未設定」扱い） |
| `"!command"` | コマンドを実行し、標準出力を値にする（例: `"!op read 'op://vault/item/credential'"`） |
| `"sk-..."` | リテラル |
| `"$$literal"` / `"$!literal"` | 先頭の `$` / `!` のエスケープ |

## 全項目

### `models`

ロール別モデル。詳細は [models.md](models.md)。

```jsonc
"models": {
  "extract": {
    "provider": "lan-llama",        // pi のプロバイダID
    "model": "qwen3-30b-a3b-instruct",
    "maxTokens": 1500,              // 省略可
    "temperature": 0.2,             // 省略可
    "fallback": [{ "provider": "anthropic", "model": "claude-haiku-4-5" }],
    "fallbackToSessionModel": true  // 既定 true
  }
}
```

### `providers`

pi に追加登録するプロバイダ。キーがプロバイダIDになります。

| 項目 | 説明 |
|---|---|
| `baseUrl` | エンドポイント（OpenAI互換なら `/v1` まで） |
| `api` | `openai-completions` / `openai-responses` / `anthropic-messages` / `google-generative-ai` |
| `apiKey` | 秘密情報の記法が使える |
| `headers` | 追加ヘッダ |
| `authHeader` | `true` で `Authorization: Bearer <apiKey>` を自動付与 |
| `compat` | OpenAI 互換サーバ向けの互換フラグ（pi の models.json と同じ）。プロバイダ階層に書くと各モデルへ配られる（モデル側の指定が優先） |
| `models` | モデル定義の配列。`id` 以外は省略可（既定値で補完される） |

### `search`

Web検索。**すべて pi の実行マシンから発行されます。**

| 項目 | 既定 | 説明 |
|---|---|---|
| `backend` | `"auto"` | `auto` / `brave` / `google-cse` / `searxng` / `duckduckgo` |
| `maxResults` | `8` | 1回の検索で返す最大件数 |
| `brave.apiKey` | `"$BRAVE_SEARCH_API_KEY"` | Brave Search API のトークン |
| `brave.country` / `searchLang` / `uiLang` | `JP` / `jp` / `ja-JP` | 日本語検索の既定 |
| `googleCse.apiKey` / `cx` | `"$GOOGLE_CSE_API_KEY"` / `"$GOOGLE_CSE_CX"` | Google Programmable Search |
| `searxng.baseUrl` | `"$SEARXNG_BASE_URL"` | 自前 SearXNG（JSON API を有効にしておく） |
| `duckduckgo.region` | `"jp-jp"` | キー不要のフォールバック。ベストエフォート |

`auto` のときは資格情報が揃っているものを `brave → google-cse → searxng → duckduckgo` の順に試し、
失敗したら次へフォールバックします。

### `ec`

| 項目 | 説明 |
|---|---|
| `rakuten.enabled` / `applicationId` / `affiliateId` | 楽天市場 商品検索API。アプリIDは無料で取得できる |
| `yahoo.enabled` / `appId` | Yahoo!ショッピング商品検索API（V3） |
| `webSites` | 公式APIを使わないサイトの一覧（`id` / `name` / `domain` / `queryHint`） |
| `defaultSites` | `ec_search` でソース未指定のときに使うID |

`webSites` に項目を足せば、`ec_search` の `sources` に新しいIDを指定できます。

```jsonc
"ec": {
  "webSites": [
    { "id": "sofmap", "name": "ソフマップ", "domain": "sofmap.com" }
  ],
  "defaultSites": ["rakuten", "yahoo", "amazon", "kakaku", "sofmap"]
}
```

### `reviewSites`

`review_research` が参照するレビューサイト。

```jsonc
"reviewSites": [
  { "id": "kakaku-review", "name": "価格.com クチコミ", "domain": "kakaku.com", "lang": "ja", "kind": "user-review" },
  { "id": "rtings", "name": "RTINGS.com", "domain": "rtings.com", "lang": "en", "kind": "editorial" }
]
```

- `lang`: `ja` 以外のサイトは `include_international: true` のときだけ検索対象になり、
  要約は `translate` ロールのモデルが日本語で行います。
- `kind`: `editorial`（専門メディア）/ `user-review`（利用者レビュー）/ `community`。
  表示で区別されるほか、同じ種類に偏らないよう分散して取得します。

配列は「置き換え」でマージされるため、既定のリストに追加したい場合は
既定分も含めて書いてください（既定の一覧は `config.ts` の `DEFAULT_CONFIG.reviewSites`）。

### `http`

| 項目 | 既定 | 説明 |
|---|---|---|
| `userAgent` | `pi-ec-concierge/0.1 …` | 送信する User-Agent |
| `timeoutMs` | `20000` | 1リクエストのタイムアウト |
| `maxBytes` | `2000000` | 1ページで読み込む上限バイト数 |
| `minIntervalMsPerHost` | `1200` | 同一ホストへの最小リクエスト間隔（直列化される） |
| `respectRobotsTxt` | `true` | `web_fetch` などで robots.txt を尊重する |
| `maxRedirects` | `5` | （予約）リダイレクト上限 |

公式APIエンドポイント（楽天・Yahoo!・検索API）へのリクエストには robots.txt チェックを行いません。

### その他

| 項目 | 既定 | 説明 |
|---|---|---|
| `outputDir` | `"output"` | `recommend` が Markdown を書き出す先（cwd からの相対可） |
| `persona` | `"auto"` | `auto`: 独自システムプロンプトが無ければコンシェルジュ指示を追記 / `always`: 常に追記 / `off`: 何もしない |
| `summarizeThresholdChars` | `6000` | ページ本文がこの文字数を超えたら `extract` ロールで要約する |

## 環境変数

| 変数 | 説明 |
|---|---|
| `PI_EC_CONFIG` | 追加で読む設定ファイルのパス |
| `PI_EC_MODEL_CONCIERGE` など | ロール別モデルの上書き（`provider/model` 形式） |
| `BRAVE_SEARCH_API_KEY` / `GOOGLE_CSE_API_KEY` / `GOOGLE_CSE_CX` / `SEARXNG_BASE_URL` | 検索バックエンド |
| `RAKUTEN_APPLICATION_ID` / `RAKUTEN_AFFILIATE_ID` / `YAHOO_APP_ID` | ECサイトAPI |
| `PI_BIN` | ランチャーが起動する pi 実行ファイルのパス |
