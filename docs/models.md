# 用途別モデルの設定

「対話は Anthropic API、ページ抽出は LAN 内の llama.cpp」のように、
**用途（ロール）ごとに使うモデルを分けられます**。

## ロール一覧

| ロール | 使われる場面 | 求められる性能 | 向いているモデル |
|---|---|---|---|
| `concierge` | ユーザーとの対話全体、最終提案の文章 | 指示追従・日本語の質・ツール使用 | Anthropic / OpenAI などの上位モデル |
| `extract` | `web_fetch` が長いページを要約するとき | 長文入力に耐える・事実の書き写し | ローカル 20〜30B クラスで十分 |
| `review` | `review_research` がレビュー記事を整理するとき | 要約・構造化 | ローカル 20〜30B クラス |
| `translate` | 日本語以外のレビューを日本語要約するとき | 多言語 | Gemma / Qwen 系ローカル、または安価なAPI |
| `rerank` | `rank_candidates` が候補を採点するとき | JSON 出力の安定性 | 小さめのAPIモデル or ローカル |

`concierge` だけは pi 本体が持つ「セッションのモデル」です。
ランチャー（`ec-concierge`）は設定の `models.concierge` を `--model` として pi に渡します。
起動後は pi の `/model` でいつでも切り替えられます。

## 解決の順序

各ロールについて、次の順に「使えるモデル」を探します。

1. `models.<role>` のモデル（pi にそのプロバイダ/モデルが登録済み、かつ認証が設定済みであること）
2. `models.<role>.fallback` に並べたモデル（上から順）
3. 現在のセッションモデル（`fallbackToSessionModel: false` で無効化できる）

どれも使えなければ、そのロールを使うツールはエラーになります（`web_fetch` と
`review_research` は要約を諦めて生テキストで続行します）。

現在の割り当ては `/ec-models` で確認できます。

```
/ec-models
用途別モデル割り当て
- concierge 設定: anthropic/claude-sonnet-4-5
    実際: anthropic/claude-sonnet-4-5
- extract   設定: lan-llama/qwen3-30b-a3b-instruct
    実際: lan-llama/qwen3-30b-a3b-instruct
...
```

一時的に変えたいときは引数を付けます（このセッション限りで、設定ファイルは書き換えません）。

```
/ec-models extract anthropic/claude-haiku-4-5
```

環境変数でも上書きできます（起動時に反映）。

```bash
PI_EC_MODEL_EXTRACT=lan-llama/qwen3-30b-a3b-instruct ec-concierge
```

## LAN 内の llama.cpp を使う

### 1. LLM 側のマシンで llama-server をルーターモードで起動する

```bash
llama-server \
  --models-dir ~/models \
  --no-models-autoload \
  --jinja \
  --host 0.0.0.0 \
  --port 8080 \
  -ngl 999 \
  -c 32768 \
  --api-key "任意の共有シークレット"
```

`--host 0.0.0.0` で LAN に開ける場合は、必ず `--api-key` を設定し、
信頼できるネットワークに限定してください。

### 2. pi 側（実行マシン）で設定する

```json
{
  "providers": {
    "lan-llama": {
      "baseUrl": "http://192.168.1.50:8080/v1",
      "api": "openai-completions",
      "apiKey": "$LAN_LLAMA_API_KEY",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        { "id": "qwen3-30b-a3b-instruct", "name": "Qwen3 30B (LAN)", "contextWindow": 65536, "maxTokens": 8192 }
      ]
    }
  },
  "models": {
    "extract": { "provider": "lan-llama", "model": "qwen3-30b-a3b-instruct" },
    "review":  { "provider": "lan-llama", "model": "qwen3-30b-a3b-instruct" }
  }
}
```

`models` に書く項目は `id` だけでも動きます（表示名・コンテキスト長・コストなどは既定値で補完されます）。
登録されたモデルは pi の `/model` や `pi --list-models` にも現れるので、
対話モデルとしてローカルLLMを選ぶこともできます。

> **注意:** ここで登録するのは「LLMの実行先」だけです。Web検索とページ取得は常に
> pi の実行マシンから行われ、LLM 実行マシンは通信しません。

### 3. 確認する

```bash
pi --list-models | grep lan-llama
```

pi 本体の `/login llama.cpp` と `/llama` コマンドを使う方法もあります（`LLAMA_BASE_URL` / `LLAMA_API_KEY`）。
その場合はプロバイダIDが `llamacpp` になるので、`models.<role>.provider` もそれに合わせてください。

## KoboldCpp（LAN内の別マシン）

KoboldCpp も OpenAI 互換エンドポイント（`/v1/chat/completions`, `/v1/models`）を持つので、
そのまま下働きロールに使えます。

### 1. KoboldCpp 側

```bash
./koboldcpp --model Qwen3-30B-A3B-Q4_K_M.gguf \
  --host 0.0.0.0 --port 5001 \
  --contextsize 32768 \
  --multiuser 4 \
  --password "任意の共有シークレット" \
  --jinja
```

- `--host 0.0.0.0`（省略時も全インターフェースで待ち受けます）／`--port` の既定は 5001。
- `--password` を付けると、全テキストエンドポイントで `Authorization: Bearer <password>` が必要になります。
  LAN に開くなら必ず設定してください。
- `--multiuser 4` は同時リクエストをキューイング／並列化します。この拡張はレビュー調査などで
  モデルを連続して呼ぶので、付けておくと待ち時間が減ります。
- `--jinja` はチャットテンプレート経由のツール呼び出し解析を有効にします。
  下働きロール（extract/review/translate/rerank）はツールを使わないので不要ですが、
  **`concierge`（対話本体）に使うなら必須**です（後述）。

### 2. モデルIDを確認する

`/v1/models` が返す ID は `koboldcpp/<モデル名>` の形です。

```bash
curl http://192.168.1.50:5001/v1/models
# {"object":"list","data":[{"id":"koboldcpp/Qwen3-30B-A3B-Q4_K_M", ...}]}
```

単一モデルで動かしている場合、リクエストの `model` 値は実質無視されますが、
`/v1/models` の値に合わせておくのが確実です。

### 3. `ec-concierge.json`

```json
{
  "providers": {
    "kobold": {
      "baseUrl": "http://192.168.1.50:5001/v1",
      "api": "openai-completions",
      "apiKey": "$KOBOLD_API_KEY",
      "authHeader": true,
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "maxTokensField": "max_tokens"
      },
      "models": [
        {
          "id": "koboldcpp/Qwen3-30B-A3B-Q4_K_M",
          "name": "Qwen3 30B (KoboldCpp)",
          "contextWindow": 32768,
          "maxTokens": 4096
        }
      ]
    }
  },
  "models": {
    "extract":   { "provider": "kobold", "model": "koboldcpp/Qwen3-30B-A3B-Q4_K_M", "maxTokens": 1500 },
    "review":    { "provider": "kobold", "model": "koboldcpp/Qwen3-30B-A3B-Q4_K_M", "maxTokens": 1500 },
    "translate": { "provider": "kobold", "model": "koboldcpp/Qwen3-30B-A3B-Q4_K_M" },
    "rerank":    { "provider": "kobold", "model": "koboldcpp/Qwen3-30B-A3B-Q4_K_M", "temperature": 0 }
  }
}
```

`--password` を設定していないなら、`apiKey` はダミー文字列で構いません
（pi は「認証が設定されているモデル」しか使わないため、空にはできません）。

`contextsize` と `contextWindow` は揃えてください。ずれていると、長いページを渡したときに
pi 側が入らないことに気づけません。

補足:

- **プロバイダ階層の `compat` は各モデルへ自動で配られます。** pi の `registerProvider()` は
  モデル単位の `compat` しか見ないため、この拡張が展開しています（モデル側の指定が優先）。
- `supportsDeveloperRole: false` は必須です。KoboldCpp が解釈するロールは
  system / user / assistant / tool だけで、`developer` ロールを送るとシステムプロンプトの
  区切りが崩れます。
- `maxTokensField` は KoboldCpp が `max_tokens` / `max_completion_tokens` の両方を受けるため
  どちらでも動きます（明示しておくと安全）。
- トークン数・コスト表示は動きます（KoboldCpp は `stream_options.include_usage` に対応しています）。
- 動作確認は `/ec-models` で「実際に使われるモデル」を見るのが早いです。

### 対話本体（concierge）に使う場合

pi は対話モデルにツール呼び出しを要求します。KoboldCpp にもツール呼び出し対応はありますが、
モデルとチャットテンプレート依存です。使うなら:

- `--jinja` を付ける
- ツール呼び出しに対応したテンプレートを持つモデル（Qwen3、Llama 3.x 系など）を選ぶ
- それでも 9 個のツールを使い分ける精度はクラウドの上位モデルに劣ります

まずは `extract` / `review` / `translate` / `rerank` をローカルに寄せ、`concierge` はクラウドAPIに
残す構成を勧めます（これらのロールはツールを使わない単発生成なので、KoboldCpp の得意な使い方です）。

## Ollama / vLLM / LM Studio

いずれも OpenAI 互換APIなので、`providers` の書き方は llama.cpp と同じです。

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://192.168.1.51:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
      "models": [{ "id": "qwen3:30b" }]
    }
  }
}
```

## コストとプライバシーの目安

- 一番トークンを食うのは `extract` と `review`（Webページ本文をまるごと読む）です。
  ここをローカルに寄せると、API費用が大きく下がります。
- ローカルに寄せた場合でも、`concierge` がクラウドAPIなら、要約後のテキストと
  ユーザーの発言はクラウドへ送られます。全部を手元で閉じたいなら `concierge` もローカルにしてください
  （ツール呼び出しの安定性は落ちます）。
