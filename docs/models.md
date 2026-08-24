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
