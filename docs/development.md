# 開発

## セットアップ

```bash
npm install --legacy-peer-deps
```

`--legacy-peer-deps` が要るのは、pi のパッケージを `peerDependencies`（実行時は pi 本体が提供）と
`devDependencies`（型チェックとテスト用）の両方に載せているためです。npm 10 系はこの組み合わせで
`Cannot read properties of null (reading 'edgesOut')` を出すことがあります。

## テストと型チェック

```bash
npm test           # vitest（ネットワークアクセスなし。fetch はスタブ）
npm run typecheck  # tsc --noEmit
```

テストはネットワークとモデル呼び出しに触れない層に集中しています。

| テスト | 対象 |
|---|---|
| `test/util.test.ts` | 価格パース、HTML→テキスト、URL正規化 |
| `test/config.test.ts` | 設定のマージ、秘密値の解決、プロバイダ定義の補完 |
| `test/http.test.ts` | robots.txt の解析と判定、HTTPクライアント（fetch スタブ） |
| `test/search.test.ts` | 各検索バックエンドのレスポンス解析、フォールバック |
| `test/ec.test.ts` | 楽天/Yahoo! のURL組み立てとレスポンス解析、横断検索 |
| `test/state.test.ts` | 要件メモと候補リストの状態遷移 |
| `test/rank-recommend.test.ts` | 採点結果のJSON解析、提案Markdownの生成 |
| `test/reviews.test.ts` | レビュー検索クエリ、取得先の分散 |
| `test/roles.test.ts` | 用途別モデルの解決とフォールバック |
| `test/extension.test.ts` | ツール/コマンド登録、有効化ゲーティング（activation）、システムプロンプト追記、対話ツール |
| `test/web-tools.test.ts` | web_fetch の要約経路と robots.txt 拒否 |
| `test/searxng-pool.test.ts` | SearXNG 複数インスタンスのローテーションとクールダウン |
| `test/launcher.test.ts` | ランチャー（bin/ec-concierge.mjs）の pi 解決と引数組み立て |

## 手元で pi と一緒に動かす

```bash
# 拡張だけを読み込んで起動（インストール不要）
pi --no-extensions -e ./extensions/ec-concierge/index.ts

# ランチャー経由（システムプロンプト + スキル + ツール制限つき）
node bin/ec-concierge.mjs "テスト用の相談"

# 追加プロバイダが登録できているか確認
pi -e ./extensions/ec-concierge/index.ts --list-models | grep lan-llama
```

拡張は jiti 経由で読み込まれるのでビルド不要です。`/reload` で再読み込みできます。

## コードの約束

- ネットワークとモデル呼び出しは薄いラッパに閉じ込め、パース・整形・状態遷移は純粋関数にする
  （そこにテストを書く）。
- 相対 import は `.ts` 拡張子付きで書く（pi の jiti ローダーの流儀に合わせる）。
- ツールの `parameters` は TypeBox で書く。文字列の列挙は `StringEnum`（Google API 互換のため）。
- ツールが状態を変えたら、結果の `details` に状態スナップショットを入れる（分岐セッションの復元用）。
- 失敗は握りつぶさず、ユーザーが次に何をすればよいか分かるメッセージにする
  （例: 「楽天アプリID（applicationId）が未設定です」）。

## 追加のヒント

- **ツールを増やす**: `extensions/ec-concierge/tools/` にファイルを足し、`index.ts` で `registerTool` する。
  `promptSnippet` と `promptGuidelines` を書くとシステムプロンプトに1行で載る。
- **検索バックエンドを増やす**: `search/backends.ts` にパーサと実行関数を足し、`BACKEND_ORDER` に入れる。
- **ECサイトを増やす**: 設定の `ec.webSites` に足すだけ（公式APIなら `ec/` にアダプタを追加）。
