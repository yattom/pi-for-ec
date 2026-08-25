# Windows / WSL で動かす

**結論: どちらでも動きます。特別な事情がなければ WSL2 (Ubuntu) を勧めます。**
ネイティブ Windows 11 でも動くようにしてありますが、細かな作法が Linux/macOS と違います。

## どちらを選ぶか

| | ネイティブ Windows 11 | WSL2 (Ubuntu) |
|---|---|---|
| pi 本体 | 対応（bash ツールは Git Bash を使う） | そのまま動く |
| この拡張 | 動く | 動く（開発・検証はこちら） |
| `!command` 形式の秘密値解決 | cmd.exe で実行される | sh で実行される（例がそのまま使える） |
| ドキュメントの例 | 一部読み替えが必要 | そのまま使える |
| LAN の llama.cpp への接続 | そのまま | ホストPC上の llama.cpp に繋ぐときだけ一手間（下記） |

WSL を勧める理由は、このリポジトリの例・スクリプト・テストがすべて POSIX 前提で書かれているからです。
逆に「Windows 上のファイルを直接扱いたい」「WSL を入れたくない」なら、ネイティブでも問題ありません。

## ネイティブ Windows 11 での注意点

### インストール

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi install git:github.com/yattom/pi-for-ec
```

pi は bash ツールに Git Bash を使うので、[Git for Windows](https://git-scm.com/download/win) を入れておくと確実です。
ただしランチャー（`ec-concierge`）は既定で `--no-builtin-tools` を渡すため、買い物用途では bash 自体をほぼ使いません。

### 設定ファイルの場所

- 個人設定: `%USERPROFILE%\.pi\agent\ec-concierge.json`
- プロジェクト設定: `<プロジェクト>\.pi\ec-concierge.json`

JSON 内でパスを書く場合、バックスラッシュは `"C:\\path\\to\\file"` のようにエスケープするか `/` を使ってください。

### 環境変数

```powershell
# その場限り
$env:BRAVE_SEARCH_API_KEY = "..."
# 永続化
[Environment]::SetEnvironmentVariable("BRAVE_SEARCH_API_KEY", "...", "User")
```

### `!command` でのキー取得

設定値の `"!コマンド"` 記法は **cmd.exe** で実行されます。macOS/Linux 向けの例は使えません。

```jsonc
// macOS の例（Windows では動かない）
"apiKey": "!security find-generic-password -ws 'brave'"

// Windows の例
"apiKey": "!powershell -NoProfile -Command \"(Get-Secret BraveKey -AsPlainText)\""
```

単純に環境変数を使う（`"$BRAVE_SEARCH_API_KEY"`）のが一番手軽です。

### ランチャーの起動方法

`npm` が置く `pi` は `pi.cmd` というシムで、Node からは shell 経由でしか起動できません。
その経路だと cmd.exe が複数行の引数（システムプロンプト）を扱えないため、ランチャーは
**pi の JS エントリを探して `node <entry>` として起動**します（`bin/ec-concierge.mjs`）。

自動で見つからない場合は `pi` コマンドにフォールバックし、その旨を表示したうえで
システムプロンプトは拡張側の追記（`persona`）で補います。動作に支障はありませんが、
明示したい場合は JS エントリを直接指定してください。

```powershell
$env:PI_BIN = "$(npm root -g)\@earendil-works\pi-coding-agent\dist\bundle\cli.js"
npx ec-concierge "空気清浄機がほしい"
```

### ターミナル

Windows Terminal（PowerShell または Git Bash）を推奨します。日本語の表示幅・絵文字の扱いが安定します。
古い `conhost` ベースのコンソールだと TUI の表示が崩れることがあります。

## WSL2 (Ubuntu) での注意点

基本は Linux と同じです。追加で気にするのは次の2点だけです。

### 1. Windows ホスト上の llama.cpp に繋ぐ場合

LAN の別マシンで llama.cpp を動かすなら何も問題ありません。
**同じPCの Windows 側**で `llama-server` を動かして WSL から使う場合だけ、アドレスに注意します。

- `llama-server` は `--host 0.0.0.0` で待ち受ける（既定の `127.0.0.1` では WSL から見えません）。
- Windows Defender ファイアウォールで、そのポートの受信を許可する。
- WSL2 の既定（NAT モード）では `localhost` はホストを指しません。ホストのIPを使います。

```bash
# WSL 側からホストのIPを調べる
ip route show default | awk '{print $3}'
# → 172.x.x.1 など。これを baseUrl に使う
```

```json
{ "providers": { "win-llama": { "baseUrl": "http://172.29.128.1:8080/v1", "api": "openai-completions" } } }
```

Windows 11 のミラーモード（`%USERPROFILE%\.wslconfig` に `[wsl2]` / `networkingMode=mirrored`）を使っている場合は
`http://localhost:8080/v1` がそのまま使えます。

> Web検索とページ取得は WSL 側（pi の実行マシン）から出ます。LLM をホスト側に置いても、
> 検索の経路は変わりません。

### 2. ファイルの置き場所

作業ディレクトリは WSL 側（`/home/<user>/...`）にしてください。`/mnt/c/...` 配下はファイルI/Oが遅く、
`recommend` が書き出す Markdown の生成やセッションの保存が重くなります。
Windows から中身を見たいときは、エクスプローラーで `\\wsl$\Ubuntu\home\<user>\...` を開けます。

購入リンクを Windows のブラウザで開きたい場合は `wslu` の `wslview`、または `explorer.exe <URL>` が使えます。

## どちらでも共通

- Node.js は 20 以上（開発は 22 で確認）。
- 出力ファイル名は Windows で使えない文字（`\ / : * ? " < > |`）を落とすようになっています。
- テストはネットワークに出ないので、`npm test` はどちらの環境でも通ります。
