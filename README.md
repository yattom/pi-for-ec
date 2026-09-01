# pi-ec-concierge — ECショッピング・コンシェルジュ

[pi](https://pi.dev/)（Mario Zechner 作のミニマルなエージェント・ハーネス）の上に作った、
**日本のECサイトでの買い物を支援するコンシェルジュ・エージェント**です。

ユーザーは「ほしい商品名」「カテゴリー」「解決したい問題」のどれを入力してもよく、
エージェントは対話で要件を詰めながら、ECサイトと**独立したレビューサイト**を調べ、
最後に「おすすめの理由・価格・購入できるページのリンク」つきのリストを提示します。

```
$ npx ec-concierge "花粉症がひどいので、寝室用に空気清浄機がほしい"

? 何を最優先にしますか？
  › 花粉・ハウスダストの除去性能
    静音性（寝室で使う）
    電気代・メンテ費用
    その他（自由に入力する）
...
## おすすめ
### 1. シャープ KI-XXXX
**寝室の静音運転を最優先するならこれ**
- おすすめの理由: 就寝時モードの実測25dBという記事があり、必須条件の「静音」を満たす
- 価格: 実売39,800円前後（2026-08-24 時点、価格.com 最安）
- 良い点: …
- 注意点: 交換フィルターが年1回・約6,000円かかる
- 購入できるページ:
  - [ヨドバシ.com](https://…) — 41,800円（ポイント10%）
  - [楽天市場 ○○ストア](https://…) — 39,800円（送料込み）
- 根拠: https://kakaku.com/…, https://the360.life/…
```

## 特徴

- **用途ごとにモデルを分けられる。** 対話は Anthropic API、ページ抽出やレビュー要約は
  LAN 内の llama.cpp、といった振り分けを設定ファイルで指定できます（[docs/models.md](docs/models.md)）。
- **Web検索は pi の実行マシンから発行。** LLM プロバイダ内蔵の検索ツールは使いません。
  ローカルLLMを使っていても、検索・ページ取得は手元のネットワークから行われます。
- **ECサイトは公式APIを優先。** 楽天市場・Yahoo!ショッピングは公式API、
  Amazon・価格.com・ヨドバシなどはサイト指定のWeb検索経由で辿ります。
- **ECの外を必ず見る。** 価格.comクチコミ、専門メディア、海外レビューサイトを読み、
  良い点だけでなく欠点も拾います。
- **相手サイトに配慮。** ホストごとのレート制限と robots.txt の尊重が既定で有効です。

## セットアップ

### 1. pi をインストール

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

### 2. このパッケージを入れる

```bash
# GitHub から直接
pi install git:github.com/yattom/pi-for-ec

# または開発用にクローンして
git clone https://github.com/yattom/pi-for-ec
cd pi-for-ec
npm install --legacy-peer-deps    # peerDependencies を自分で持つ構成のため
pi install .
```

### 3. APIキーを用意する

**検索APIキーは実質必須です。** キー無しでも Tavily のキーレスモードで動きますが、
レート制限が厳しく、調査の途中で止まります（EC横断検索もレビュー調査もWeb検索に乗っているため）。

| 用途 | 環境変数 | 取得先 | 無い場合 |
|---|---|---|---|
| 会話モデル | `ANTHROPIC_API_KEY` など | 各LLMプロバイダ | pi の `/login` でも可 |
| **Web検索（推奨）** | `TAVILY_API_KEY` | [Tavily](https://tavily.com/)（無料枠あり・カード不要） | キーレスモードで動くが厳しいレート制限つき |
| Web検索（代替） | `SERPER_API_KEY` | [Serper](https://serper.dev/)（無料枠あり） | — |
| Web検索（代替） | `BRAVE_SEARCH_API_KEY` | [Brave Search API](https://brave.com/search/api/)（カード登録必須） | — |
| Web検索（自前） | `SEARXNG_BASE_URL` | 自前の SearXNG（複数登録してローテーションも可。[詳細](docs/data-sources.md)） | — |
| 楽天市場 | `RAKUTEN_APPLICATION_ID` | [Rakuten Developers](https://webservice.rakuten.co.jp/) （無料） | 楽天は Web検索経由になる |
| Yahoo!ショッピング | `YAHOO_APP_ID` | [Yahoo!デベロッパーネットワーク](https://developer.yahoo.co.jp/) （無料） | Yahoo!は Web検索経由になる |

> Google Programmable Search（Custom Search JSON API）は2025年に新規受付を終了し、2027年1月1日に廃止されます。
> 既存キーは `GOOGLE_CSE_API_KEY` / `GOOGLE_CSE_CX` で引き続き使えますが、新規の選択肢にはなりません。
> 詳細と移行先は [docs/data-sources.md](docs/data-sources.md) を参照してください。

### 4. 設定ファイルを置く

```bash
cp config/ec-concierge.example.json ~/.pi/agent/ec-concierge.json
$EDITOR ~/.pi/agent/ec-concierge.json
```

設定の全項目は [docs/configuration.md](docs/configuration.md) を参照してください。

## 使い方

`pi install` すると、この拡張は**全プロジェクトの `pi` 起動時に読み込まれます**（pi パッケージの仕様）。
ただし既定では非活性（`activation: "manual"`）で、明示的に有効化するまでツールもシステムプロンプトも
一切有効になりません。そのため、素の `pi` は今までどおり普通のコーディングエージェントとして動きます。

```bash
# ランチャー経由（コンシェルジュ用のシステムプロンプトとツール制限つきで pi を起動。自動的に有効化される）
npx ec-concierge "在宅勤務用の椅子がほしい。腰が痛い"

# すでに pi install 済みなら、普通に pi を起動して
pi
> /kaimono 3万円以内で静かな空気清浄機   # これを実行するとその場で有効化される
> /hikaku SHARP KI-RX50 パナソニック F-VXV70

# コーディング作業中の pi で、ツールも persona も一切出したくない場合
# → 何もしなくてよい。/kaimono も /ec-on も呼ばなければ既定のまま非活性
```

有効化の方法は3つ:

1. `/kaimono` または `/hikaku` を実行する（買い物相談を始めると同時に有効化される）
2. `/ec-on` を実行する（会話はせず、ツールと persona だけ先に有効化する）
3. ランチャー（`ec-concierge` コマンド、または `PI_EC_ACTIVATE=1` を設定して `pi` を起動）

常に有効にしたい場合（この拡張専用の環境で pi を動かす場合など）は、設定の
`activation: "always"` を使ってください（[docs/configuration.md](docs/configuration.md)）。

### コマンド

| コマンド | 説明 |
|---|---|
| `/kaimono <ほしいもの>` | 買い物相談を始める（未有効化なら同時に有効化） |
| `/hikaku <商品A> <商品B>` | 特定の商品どうしを比較する（未有効化なら同時に有効化） |
| `/ec-on` | コンシェルジュを有効化する（ツール・システムプロンプトが有効になる） |
| `/ec-off` | コンシェルジュを無効化し、素の `pi` に戻す |
| `/ec-models` | 用途別のモデル割り当てを表示・変更する |
| `/ec-config` | 有効化の状態、検索バックエンドやEC APIの設定状況を表示する |
| `/ec-search-test [クエリ]` | 検索バックエンドを実際に試して、どれが使えるか確認する |
| `/ec-status` | 現在の要件メモと候補リストを表示する |
| `/ec-reload` | 設定ファイルを読み直す |

`/ec-on` `/ec-off` `/ec-models` `/ec-config` などの管理コマンドは、有効化されていなくても常に使えます。

### エージェントが使うツール

| ツール | 役目 |
|---|---|
| `ask_user` | 選択肢つきでユーザーに1問だけ質問する |
| `requirements` | 聞き取った要件を記録・参照する |
| `web_search` | 実行マシンからWeb検索する |
| `web_fetch` | ページを取得する（長ければ抽出用モデルで要約） |
| `ec_search` | 楽天・Yahoo!・Amazon・価格.com などを横断検索する |
| `review_research` | EC外の独立レビューを検索・読解・要約する |
| `candidates` | 候補の登録と絞り込み状況を管理する |
| `rank_candidates` | 要件との適合度を採点して並べ替える |
| `recommend` | 最終おすすめリストを提示し Markdown に保存する |

最終提案は `output/` に Markdown で保存されます（`outputDir` で変更可）。

## ドキュメント

- [docs/architecture.md](docs/architecture.md) — 全体構成と処理の流れ
- [docs/models.md](docs/models.md) — 用途別モデルの設定（Anthropic API / ローカルLLM）
- [docs/configuration.md](docs/configuration.md) — 設定ファイルの全項目
- [docs/data-sources.md](docs/data-sources.md) — 対応ECサイト・レビューサイトと増やし方
- [docs/windows.md](docs/windows.md) — Windows 11 / WSL2 での動かし方
- [docs/development.md](docs/development.md) — 開発とテスト

## 動作環境

Node.js 20 以上。Linux / macOS / WSL2 (Ubuntu) / ネイティブ Windows 11 で動きます。
Windows での作法（設定ファイルの場所、`!command` の書き方、WSL からホストの llama.cpp に繋ぐ方法）は
[docs/windows.md](docs/windows.md) を参照してください。

## 開発

```bash
npm install --legacy-peer-deps
npm test          # vitest
npm run typecheck # tsc --noEmit
```

## 注意

- 価格・在庫は常に変動します。エージェントの提示は調査時点のもので、購入前に必ず販売ページで確認してください。
- 各サイトの利用規約を尊重してください。この拡張は公式APIとWeb検索を優先し、
  ページ取得時は robots.txt とレート制限に従いますが、**利用者側の責任で使ってください**。
- アフィリエイトIDを設定した場合、生成されるリンクにそれが含まれます。第三者に共有する際は明示してください。

## ライセンス

MIT
