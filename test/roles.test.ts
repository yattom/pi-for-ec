import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type EcConciergeConfig } from "../extensions/ec-concierge/config.ts";
import { RoleRouter, sumUsage } from "../extensions/ec-concierge/roles.ts";

type FakeModel = { provider: string; id: string };

/**
 * ExtensionContext のうち RoleRouter が使う部分だけを持つスタブ。
 * available に無いモデルは find() が undefined を返し、authed に無いものは未認証扱いになる。
 */
function makeCtx(options: {
	available: FakeModel[];
	authed?: string[];
	sessionModel?: FakeModel;
	complete?: (model: FakeModel, context: unknown, opts: unknown) => unknown;
}): ExtensionContext {
	const authed = options.authed ?? options.available.map((model) => `${model.provider}/${model.id}`);
	return {
		model: options.sessionModel,
		modelRegistry: {
			find: (provider: string, id: string) =>
				options.available.find((model) => model.provider === provider && model.id === id),
			hasConfiguredAuth: (model: FakeModel) => authed.includes(`${model.provider}/${model.id}`),
			complete: async (model: FakeModel, context: unknown, opts: unknown) =>
				options.complete?.(model, context, opts) ?? {
					content: [{ type: "text", text: "ok" }],
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
		},
	} as unknown as ExtensionContext;
}

function configWith(models: EcConciergeConfig["models"]): EcConciergeConfig {
	return { ...DEFAULT_CONFIG, models };
}

describe("RoleRouter.resolve", () => {
	it("設定どおりのモデルを使う", () => {
		const router = new RoleRouter(() => configWith({ extract: { provider: "lan", model: "qwen" } }));
		const ctx = makeCtx({ available: [{ provider: "lan", id: "qwen" }] });
		expect(router.resolve(ctx, "extract")).toMatchObject({ source: "configured", model: { id: "qwen" } });
	});

	it("未認証ならフォールバック候補へ進む", () => {
		const router = new RoleRouter(() =>
			configWith({
				extract: {
					provider: "lan",
					model: "qwen",
					fallback: [{ provider: "anthropic", model: "claude-haiku-4-5" }],
				},
			}),
		);
		const ctx = makeCtx({
			available: [
				{ provider: "lan", id: "qwen" },
				{ provider: "anthropic", id: "claude-haiku-4-5" },
			],
			authed: ["anthropic/claude-haiku-4-5"],
		});
		expect(router.resolve(ctx, "extract")).toMatchObject({ source: "fallback", model: { id: "claude-haiku-4-5" } });
	});

	it("候補が尽きたらセッションモデルに落ちる", () => {
		const router = new RoleRouter(() => configWith({ extract: { provider: "lan", model: "missing" } }));
		const ctx = makeCtx({ available: [], sessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" } });
		expect(router.resolve(ctx, "extract")).toMatchObject({ source: "session" });
	});

	it("fallbackToSessionModel:false ならセッションモデルへ落ちない", () => {
		const router = new RoleRouter(() =>
			configWith({ extract: { provider: "lan", model: "missing", fallbackToSessionModel: false } }),
		);
		const ctx = makeCtx({ available: [], sessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" } });
		expect(router.resolve(ctx, "extract")).toEqual({ source: "none" });
	});

	it("未設定のロールはセッションモデルを使う", () => {
		const router = new RoleRouter(() => configWith({}));
		const ctx = makeCtx({ available: [], sessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" } });
		expect(router.resolve(ctx, "review")).toMatchObject({ source: "session" });
	});
});

describe("RoleRouter.describe", () => {
	it("全ロールの設定値・実際の割り当て・注意書きを返す", () => {
		const router = new RoleRouter(() => configWith({ extract: { provider: "lan", model: "missing" } }));
		const ctx = makeCtx({ available: [], sessionModel: { provider: "anthropic", id: "claude-sonnet-4-5" } });
		const described = router.describe(ctx);
		expect(described).toHaveLength(5);
		const extract = described.find((entry) => entry.role === "extract");
		expect(extract).toMatchObject({
			configured: "lan/missing",
			effective: "anthropic/claude-sonnet-4-5",
			source: "session",
		});
		expect(extract?.note).toContain("未認証");
	});
});

describe("RoleRouter.run", () => {
	it("system と prompt を渡し、テキストと使用量を返す", async () => {
		const complete = vi.fn(() => ({
			content: [
				{ type: "thinking", text: "考え中" },
				{ type: "text", text: "要約結果" },
			],
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
			},
		}));
		const router = new RoleRouter(() => configWith({ extract: { provider: "lan", model: "qwen", maxTokens: 800 } }));
		const ctx = makeCtx({ available: [{ provider: "lan", id: "qwen" }], complete });

		const result = await router.run(ctx, "extract", { system: "SYS", prompt: "PROMPT" });
		expect(result.text).toBe("要約結果");
		expect(result.modelLabel).toBe("lan/qwen");
		expect(result.fallbackUsed).toBe(false);
		expect(result.usage?.totalTokens).toBe(120);

		const [, context, options] = complete.mock.calls[0] as unknown as [unknown, { systemPrompt?: string; messages: unknown[] }, { maxTokens?: number }];
		expect(context.systemPrompt).toBe("SYS");
		expect(context.messages).toHaveLength(1);
		expect(options.maxTokens).toBe(800);
	});

	it("使えるモデルが無ければ分かるエラーにする", async () => {
		const router = new RoleRouter(() =>
			configWith({ extract: { provider: "lan", model: "missing", fallbackToSessionModel: false } }),
		);
		const ctx = makeCtx({ available: [] });
		await expect(router.run(ctx, "extract", { prompt: "x" })).rejects.toThrow(/ec-models/);
	});

	it("tryRun は失敗を undefined にする", async () => {
		const router = new RoleRouter(() =>
			configWith({ extract: { provider: "lan", model: "missing", fallbackToSessionModel: false } }),
		);
		const ctx = makeCtx({ available: [] });
		await expect(router.tryRun(ctx, "extract", { prompt: "x" })).resolves.toBeUndefined();
	});

	it("tryRun は空応答も undefined にする", async () => {
		const router = new RoleRouter(() => configWith({ extract: { provider: "lan", model: "qwen" } }));
		const ctx = makeCtx({
			available: [{ provider: "lan", id: "qwen" }],
			complete: () => ({ content: [], usage: undefined }),
		});
		await expect(router.tryRun(ctx, "extract", { prompt: "x" })).resolves.toBeUndefined();
	});
});

describe("sumUsage", () => {
	const usage = {
		input: 10,
		output: 5,
		cacheRead: 1,
		cacheWrite: 2,
		totalTokens: 18,
		cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
	};

	it("複数の使用量を合算する", () => {
		const total = sumUsage([usage, usage, undefined]);
		expect(total).toMatchObject({ input: 20, output: 10, totalTokens: 36 });
		expect(total?.cost.total).toBeCloseTo(0.6);
	});

	it("何もなければ undefined", () => {
		expect(sumUsage([undefined])).toBeUndefined();
	});
});
