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

| バックエンド | 必要なもの | 備考 |
|---|---|---|
| Brave Search API | APIキー | 無料枠あり。日本語・地域指定が効く。既定の第一候補 |
| Google Programmable Search | APIキー + 検索エンジンID | 1日100クエリまで無料 |
| SearXNG | 自前インスタンスのURL | JSON API を有効にしておく。社内・自宅ネットワーク向け |
| DuckDuckGo (HTML) | 不要 | キー無しで動くフォールバック。HTML構造の変更に弱い |

`backend: "auto"` なら上から順に「使えるもの」を試し、失敗すれば次へ回します。
どれが使えるかは `/ec-config` で確認できます。

## アクセスのマナー

- ホストごとにリクエストを直列化し、既定 1.2 秒の間隔を空けます（`http.minIntervalMsPerHost`）。
- `web_fetch` とレビュー取得は robots.txt を確認し、拒否されているパスは取得しません
  （`http.respectRobotsTxt: false` で無効化できますが、推奨しません）。
- 1ページあたりの読み込みは既定 2MB で打ち切ります。
- 公式APIがあるサイトはAPIを優先します。ログインが必要な情報は取得しません。
