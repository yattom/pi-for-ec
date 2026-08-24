# 全体構成

## pi の上でどう作られているか

pi は「read / write / edit / bash の4ツールと短いシステムプロンプト」だけを核に持ち、
それ以外は TypeScript の拡張（extension）、スキル、プロンプトテンプレートで足す設計です。
このリポジトリは pi パッケージとして、次の3種類の資源を提供します。

| 資源 | 場所 | 役割 |
|---|---|---|
| 拡張 | `extensions/ec-concierge/` | 買い物用のツール9個とコマンド4個を登録する |
| スキル | `skills/ec-shopping/` | コンシェルジュの進め方（手順書）。必要になったときだけ読み込まれる |
| プロンプトテンプレート | `prompts/` | `/kaimono` `/hikaku` の入口 |
| システムプロンプト | `assets/system-concierge.md` | ランチャーが `--system-prompt` で渡す。拡張からも追記できる |

`package.json` の `pi` フィールドでこれらを宣言しているので、`pi install` するだけで全部読み込まれます。

## 処理の流れ

```
ユーザー入力（商品名 / カテゴリー / 困りごと）
        │
        ▼
  [会話モデル = concierge ロール]  ← pi 本体が選ぶモデル（/model）
        │  ask_user / requirements で要件を固める
        ▼
  [調査ツール]  ── すべて pi 実行マシンから HTTP を発行
        ├─ web_search  … Brave / Google CSE / SearXNG / DuckDuckGo
        ├─ ec_search   … 楽天API・Yahoo!API・サイト指定Web検索
        ├─ web_fetch   … ページ取得 → robots.txt 確認 → テキスト化
        └─ review_research … レビューサイト検索 → 取得 → 要約
                │
                ▼
        [下働きモデル]  ← 用途別に別モデルへ振り分け（ローカルLLM可）
          extract   … 商品ページから仕様・価格を抽出
          review    … レビュー記事を良い点/悪い点に整理
          translate … 海外レビューを日本語に要約
          rerank    … 要件と候補を突き合わせて採点
                │
                ▼
  [候補の状態管理] candidates / rank_candidates
        │
        ▼
  [最終提案] recommend → 会話に提示 + output/*.md に保存
```

## なぜ検索を実行マシンから出すのか

LLM プロバイダには「サーバ側で Web 検索するツール」を持つものがありますが、この拡張では使いません。

- ローカルLLM（llama.cpp など）は外部検索を持たない。役割ごとにモデルを差し替えても
  検索の挙動が変わらないほうが、結果を比較・再現しやすい。
- 検索の発行元が手元になるので、地域（日本）・言語（日本語）の設定を自分で制御できる。
- 検索キーワードとアクセス先を手元でログ・制御できる（社内ネットワークや SearXNG 経由にもできる）。

そのため `web_search` / `web_fetch` / `ec_search` / `review_research` はすべて
`extensions/ec-concierge/http.ts` の `HttpClient` を通り、pi のプロセスから直接 HTTP を出します。

## 状態の持ち方

要件メモ（`requirements`）と候補リスト（`candidates`）は、pi 推奨のやり方に従って
**ツール結果の `details` にスナップショットとして保存**しています。
`session_start` で現在のブランチを走査して復元するため、`/fork` や `/tree` で会話を分岐しても
その枝の状態が正しく復元されます。

## モジュール構成

```
extensions/ec-concierge/
├── index.ts        拡張のエントリ。ツール/コマンド/イベントの登録
├── services.ts     設定と各サービスの束ね役（/ec-reload で作り直す）
├── config.ts       設定の型・既定値・読み込み・秘密値の解決
├── roles.ts        用途別モデルの解決と単発推論（RoleRouter）
├── http.ts         HTTPクライアント、robots.txt、レート制限
├── state.ts        要件メモと候補リスト（純粋関数）
├── reviews.ts      レビュー調査（検索→取得→要約）
├── search/         Web検索バックエンド（brave / google-cse / searxng / duckduckgo）
├── ec/             ECサイトアダプタ（rakuten / yahoo / web検索経由）
└── tools/          pi に登録するツールの定義
```

ネットワークとモデル呼び出しに触れない純粋関数（パーサ、プロンプト生成、状態遷移）を
各モジュールから export しており、テストはそこを中心に書いています。
