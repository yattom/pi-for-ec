# データソース

## ECサイト

### 公式APIを使うもの

| ソースID | サイト | API | 必要なもの |
|---|---|---|---|
| `rakuten` | 楽天市場 | [IchibaItem/Search](https://webservice.rakuten.co.jp/documentation/ichiba-item-search) | アプリID（無料登録） |
| `yahoo` | Yahoo!ショッピング | [V3 itemSearch](https://developer.yahoo.co.jp/webapi/shopping/shopping/v3/itemsearch.html) | アプリケーションID（無料登録） |

公式APIからは商品名・価格・店舗・レビュー平均/件数・在庫・画像が取れます。
レスポンス形式の揺れ（楽天の `formatVersion` 1/2 など）はパーサ側で吸収しています。

### Web検索経由のもの

| ソースID | サイト |
|---|---|
| `amazon` | Amazon.co.jp |
| `kakaku` | 価格.com |
| `yodobashi` | ヨドバシ.com |
| `biccamera` | ビックカメラ |
| `rakuten-web` / `yahoo-web` | 楽天市場 / Yahoo!ショッピング（API未設定時のフォールバック） |
| `mercari` | メルカリ（中古可のときだけ） |
| `monotaro` / `askul` | モノタロウ / LOHACO |

`site:` 指定の Web検索で商品ページを見つけ、スニペットから価格を推定します。
推定できない場合も URL は返るので、`web_fetch` で実ページを確認できます
（価格らしき数字が無いときは「価格未確認」として扱われ、型番の数字を価格と誤認しません）。

Amazon の商品情報を API で取りたい場合は Product Advertising API（アソシエイト参加と売上要件あり）が必要です。
この拡張は導入のハードルを避けるため既定では使いません。

### ソースを追加する

`~/.pi/agent/ec-concierge.json` の `ec.webSites` に足すだけです。

```jsonc
"ec": {
  "webSites": [
    { "id": "sofmap", "name": "ソフマップ", "domain": "sofmap.com" },
    { "id": "kaudake", "name": "コジマ", "domain": "kojima.net", "queryHint": "通販" }
  ]
}
```

`queryHint` は検索クエリに足す語です（サイト内の商品ページに当てやすくする目的）。

公式APIを持つサイトを増やしたい場合は `extensions/ec-concierge/ec/` にアダプタを追加し、
`EcSearchService.search()` に分岐を足してください。アダプタは
「URL組み立て」と「レスポンス→`Product[]` 変換」の2関数に分けておくとテストが書けます。

## レビューサイト

`review_research` は次の3種類を混ぜて読みます（同じドメインに偏らないよう分散取得）。

- **利用者レビュー**: 価格.com クチコミ など
- **専門メディア**: Impress Watch、ITmedia、価格.comマガジン、mybest、the360.life（LDK）など
- **コミュニティ**: note、個人ブログ、Reddit など

`include_international: true` を指定すると、RTINGS / DPReview / Wirecutter / TechRadar なども対象になります。
海外記事は `translate` ロールのモデルが日本語に要約します。

読み方の指針（記事の信頼度の見分け方、日本仕様との差など）は
[skills/ec-shopping/references/sources.md](../skills/ec-shopping/references/sources.md) にまとめてあります。

## Web検索バックエンド

検索は pi の実行マシンから発行します。`backend: "auto"` なら上から順に「使えるもの」を試し、
失敗すれば次へ回します。どれが使えるかは `/ec-config`、実際に動くかは `/ec-search-test` で確認できます。

| 優先 | バックエンド | 必要なもの | 備考 |
|---|---|---|---|
| 1 | Brave Search API | APIキー（カード登録必須） | 品質は高い。2026年2月に無料枠が終了し、$5/月クレジット（約1,000クエリ）+従量課金 |
| 2 | **Tavily** | APIキー（無料枠あり・カード不要） | **最も手軽な推奨先。** キー無しでも「キーレスモード」で動く（レート制限あり） |
| 3 | Serper | APIキー（新規登録に無料枠） | Google の検索結果が返る |
| 4 | SearXNG | 自前インスタンスのURL | JSON API を有効に。無料で無制限だが自分で運用する |
| 5 | Google Programmable Search | APIキー + 検索エンジンID | **新規受付終了・2027年1月1日に廃止。** 既存ユーザーの互換目的でのみ残置 |
| 6 | DuckDuckGo (HTML) | 不要 | 最後の手段。スクレイピングなのでブロックされやすい |

### キーは「任意」ではなく「実質必須」

キーを1つも設定しなくても Tavily のキーレスモードで一応動きますが、レート制限が厳しく、
連続した調査（`review_research` は1回で複数ページを読む）ではすぐ頭打ちになります。
`ec_search` の Amazon / 価格.com / ヨドバシもWeb検索経由なので、検索が止まると調査全体が止まります。

**実用するなら Tavily のキー（無料枠・カード不要）を取るのが一番簡単です。**

```bash
export TAVILY_API_KEY="tvly-..."
```

### Google Programmable Search からの移行

Google は Custom Search JSON API を2025年に新規受付終了し、2027年1月1日に廃止すると告知しています。
新しくキーを作ることはできません。Google は Vertex AI Search を移行先として案内していますが、
これは「自社データを対象にしたエンタープライズ検索」の製品で、汎用Web検索APIの置き換えにはなりません。
また Gemini の Grounding with Google Search は **LLM側でWeb検索する** 仕組みで、
「検索は実行マシンから出す」というこの拡張の方針と相容れません。

そのため移行先としては Tavily / Serper / Brave / 自前 SearXNG を推奨します。

## アクセスのマナー

- ホストごとにリクエストを直列化し、既定 1.2 秒の間隔を空けます（`http.minIntervalMsPerHost`）。
- `web_fetch` とレビュー取得は robots.txt を確認し、拒否されているパスは取得しません
  （`http.respectRobotsTxt: false` で無効化できますが、推奨しません）。
- 1ページあたりの読み込みは既定 2MB で打ち切ります。
- 公式APIがあるサイトはAPIを優先します。ログインが必要な情報は取得しません。
