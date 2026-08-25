import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_CONFIG,
	applyEnvModelOverrides,
	configFileCandidates,
	deepMerge,
	loadConfig,
	maskSecret,
	normalizeProviderConfig,
	parseModelRef,
	resolveSecret,
} from "../extensions/ec-concierge/config.ts";

describe("deepMerge", () => {
	it("オブジェクトは再帰的に、配列は置き換えでマージする", () => {
		const base = { a: { b: 1, c: 2 }, list: [1, 2], keep: "yes" };
		const merged = deepMerge(base, { a: { c: 3 }, list: [9] });
		expect(merged).toEqual({ a: { b: 1, c: 3 }, list: [9], keep: "yes" });
	});

	it("undefined の上書きは無視する", () => {
		expect(deepMerge({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
	});
});

describe("parseModelRef", () => {
	it('"provider/model" を分解する', () => {
		expect(parseModelRef("anthropic/claude-sonnet-4-5")).toEqual({
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		});
	});

	it("スラッシュを含むモデルIDも扱う", () => {
		expect(parseModelRef("openrouter/anthropic/claude-3.5-sonnet")).toEqual({
			provider: "openrouter",
			model: "anthropic/claude-3.5-sonnet",
		});
	});

	it("不正な入力は undefined", () => {
		expect(parseModelRef("claude")).toBeUndefined();
		expect(parseModelRef("/model")).toBeUndefined();
		expect(parseModelRef("provider/")).toBeUndefined();
	});
});

describe("applyEnvModelOverrides", () => {
	it("PI_EC_MODEL_<ROLE> でロールのモデルを差し替える", () => {
		const config = applyEnvModelOverrides(DEFAULT_CONFIG, {
			PI_EC_MODEL_EXTRACT: "lan-llama/qwen3-30b",
			PI_EC_MODEL_RERANK: "anthropic/claude-haiku-4-5",
		} as NodeJS.ProcessEnv);
		expect(config.models.extract).toEqual({ provider: "lan-llama", model: "qwen3-30b" });
		expect(config.models.rerank).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
		expect(config.models.review).toBeUndefined();
	});

	it("形式が不正な値は無視する", () => {
		const config = applyEnvModelOverrides(DEFAULT_CONFIG, { PI_EC_MODEL_EXTRACT: "qwen3" } as NodeJS.ProcessEnv);
		expect(config.models.extract).toBeUndefined();
	});
});

describe("resolveSecret", () => {
	it("環境変数を展開する", async () => {
		await expect(resolveSecret("$MY_KEY", { MY_KEY: "abc" } as NodeJS.ProcessEnv)).resolves.toBe("abc");
		await expect(resolveSecret("${MY_KEY}", { MY_KEY: "abc" } as NodeJS.ProcessEnv)).resolves.toBe("abc");
	});

	it("未設定の環境変数は undefined になる", async () => {
		await expect(resolveSecret("$MISSING", {} as NodeJS.ProcessEnv)).resolves.toBeUndefined();
	});

	it("リテラル値はそのまま返す", async () => {
		await expect(resolveSecret("sk-literal", {} as NodeJS.ProcessEnv)).resolves.toBe("sk-literal");
	});

	it("エスケープを解く", async () => {
		await expect(resolveSecret("$$literal", {} as NodeJS.ProcessEnv)).resolves.toBe("$literal");
		await expect(resolveSecret("$!literal", {} as NodeJS.ProcessEnv)).resolves.toBe("!literal");
	});

	it("!command の標準出力を使う", async () => {
		await expect(resolveSecret("!echo from-command", {} as NodeJS.ProcessEnv)).resolves.toBe("from-command");
	});

	it("失敗したコマンドは undefined", async () => {
		await expect(resolveSecret("!exit 1", {} as NodeJS.ProcessEnv)).resolves.toBeUndefined();
	});
});

describe("maskSecret", () => {
	it("参照式はそのまま、実値は伏せる", () => {
		expect(maskSecret("$RAKUTEN_APPLICATION_ID")).toBe("$RAKUTEN_APPLICATION_ID");
		expect(maskSecret("1234567890abcdef")).toBe("1234…ef");
		expect(maskSecret(undefined)).toBe("(未設定)");
	});
});

describe("normalizeProviderConfig", () => {
	it("id だけのモデル定義に pi が要求する既定値を補う", () => {
		const normalized = normalizeProviderConfig({
			baseUrl: "http://192.168.1.50:8080/v1",
			api: "openai-completions",
			models: [{ id: "qwen3-30b" }],
		});
		expect(normalized.models?.[0]).toEqual({
			id: "qwen3-30b",
			name: "qwen3-30b",
			reasoning: false,
			input: ["text"],
			contextWindow: 128000,
			maxTokens: 16384,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});

	it("書かれている値は上書きしない", () => {
		const normalized = normalizeProviderConfig({
			baseUrl: "http://x/v1",
			models: [{ id: "m", name: "My Model", contextWindow: 65536, input: ["text", "image"] }],
		});
		expect(normalized.models?.[0]).toMatchObject({
			name: "My Model",
			contextWindow: 65536,
			input: ["text", "image"],
		});
	});

	it("プロバイダ階層の compat を各モデルへ配る（registerProvider はモデル単位しか見ないため）", () => {
		const normalized = normalizeProviderConfig({
			baseUrl: "http://192.168.1.50:5001/v1",
			api: "openai-completions",
			compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
			models: [{ id: "a" }, { id: "b", compat: { maxTokensField: "max_completion_tokens" } }],
		});
		expect(normalized.compat).toBeUndefined();
		expect(normalized.models?.[0]?.compat).toEqual({
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
		});
		// モデル側の指定が勝つ
		expect(normalized.models?.[1]?.compat).toEqual({
			supportsDeveloperRole: false,
			maxTokensField: "max_completion_tokens",
		});
	});

	it("compat を書いていなければ compat キーを足さない", () => {
		const normalized = normalizeProviderConfig({ baseUrl: "http://x/v1", models: [{ id: "a" }] });
		expect(normalized.models?.[0]).not.toHaveProperty("compat");
	});

	it("models を持たないプロバイダはそのまま返す", () => {
		const config = { baseUrl: "https://proxy.example.com" };
		expect(normalizeProviderConfig(config)).toBe(config);
	});
});

describe("configFileCandidates", () => {
	it("trust されていないプロジェクト設定は読まない", () => {
		const paths = configFileCandidates({ cwd: "/proj", projectTrusted: false, home: "/home/u" });
		expect(paths).toEqual(["/home/u/.pi/agent/ec-concierge.json"]);
	});

	it("trust 済みならプロジェクト設定も候補に入る", () => {
		const paths = configFileCandidates({ cwd: "/proj", projectTrusted: true, home: "/home/u" });
		expect(paths).toEqual(["/home/u/.pi/agent/ec-concierge.json", "/proj/.pi/ec-concierge.json"]);
	});
});

describe("loadConfig", () => {
	it("グローバル設定とプロジェクト設定を重ねて読む", () => {
		const home = mkdtempSync(join(tmpdir(), "ec-home-"));
		const project = mkdtempSync(join(tmpdir(), "ec-proj-"));
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(
			join(home, ".pi", "agent", "ec-concierge.json"),
			JSON.stringify({ models: { extract: { provider: "lan", model: "a" } }, outputDir: "global-out" }),
		);
		writeFileSync(join(project, ".pi", "ec-concierge.json"), JSON.stringify({ outputDir: "project-out" }));

		const { config, sources } = loadConfig({ cwd: project, projectTrusted: true, home });
		expect(config.outputDir).toBe("project-out");
		expect(config.models.extract).toEqual({ provider: "lan", model: "a" });
		// 既定値は残る
		expect(config.search.backend).toBe("auto");
		expect(sources.filter((source) => source.ok)).toHaveLength(2);
	});

	it("壊れた JSON はエラーとして記録し、既定値で動き続ける", () => {
		const home = mkdtempSync(join(tmpdir(), "ec-home-"));
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		writeFileSync(join(home, ".pi", "agent", "ec-concierge.json"), "{ broken");

		const { config, sources } = loadConfig({ cwd: "/nowhere", projectTrusted: false, home });
		expect(config.outputDir).toBe(DEFAULT_CONFIG.outputDir);
		expect(sources[0]?.ok).toBe(false);
	});
});
