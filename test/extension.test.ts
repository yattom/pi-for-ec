import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import ecConcierge, { loadPersonaPrompt } from "../extensions/ec-concierge/index.ts";
import { createAskUserTool } from "../extensions/ec-concierge/tools/ask-user.ts";
import { createCandidatesTool, createRequirementsTool } from "../extensions/ec-concierge/tools/state-tools.ts";
import { Services } from "../extensions/ec-concierge/services.ts";

/** registerTool / registerCommand / on を記録するだけの ExtensionAPI スタブ。 */
function makeApi() {
	const tools: Array<{ name: string; description: string; parameters: unknown }> = [];
	const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const providers: Array<{ name: string; config: unknown }> = [];
	const api = {
		registerTool: (tool: { name: string; description: string; parameters: unknown }) => tools.push(tool),
		registerCommand: (name: string, options: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, options),
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => events.set(event, handler),
		registerProvider: (name: string, config: unknown) => providers.push({ name, config }),
	} as unknown as ExtensionAPI;
	return { api, tools, commands, events, providers };
}

function makeCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		cwd: process.cwd(),
		hasUI: true,
		mode: "tui",
		isProjectTrusted: () => false,
		sessionManager: { getBranch: () => [] },
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			select: vi.fn(),
			input: vi.fn(),
			confirm: vi.fn(),
		},
		model: { provider: "anthropic", id: "claude-sonnet-4-5" },
		modelRegistry: {
			find: () => undefined,
			hasConfiguredAuth: () => false,
		},
		...overrides,
	} as unknown as ExtensionContext;
}

describe("拡張の登録内容", () => {
	it("コンシェルジュのツールとコマンドを登録する", () => {
		const { api, tools, commands, events } = makeApi();
		ecConcierge(api);

		expect(tools.map((tool) => tool.name).sort()).toEqual(
			[
				"ask_user",
				"candidates",
				"ec_search",
				"rank_candidates",
				"recommend",
				"requirements",
				"review_research",
				"web_fetch",
				"web_search",
			].sort(),
		);
		expect([...commands.keys()].sort()).toEqual([
			"ec-config",
			"ec-models",
			"ec-reload",
			"ec-search-test",
			"ec-status",
		]);
		expect([...events.keys()]).toContain("session_start");
		expect([...events.keys()]).toContain("before_agent_start");
	});

	it("システムプロンプトを追記する（persona: auto、独自プロンプトなし）", async () => {
		const { api, events } = makeApi();
		ecConcierge(api);
		const handler = events.get("before_agent_start")!;
		const result = (await handler({ systemPrompt: "元のプロンプト", systemPromptOptions: {} }, makeCtx())) as
			| { systemPrompt?: string }
			| undefined;
		expect(result?.systemPrompt).toContain("元のプロンプト");
		expect(result?.systemPrompt).toContain("ショッピング・コンシェルジュ");
	});

	it("独自システムプロンプトが指定されていれば追記しない", async () => {
		const { api, events } = makeApi();
		ecConcierge(api);
		const handler = events.get("before_agent_start")!;
		const result = await handler(
			{ systemPrompt: "custom", systemPromptOptions: { customPrompt: "custom" } },
			makeCtx(),
		);
		expect(result).toBeUndefined();
	});

	it("すでにコンシェルジュ指示が入っていれば二重に足さない", async () => {
		const { api, events } = makeApi();
		ecConcierge(api);
		const handler = events.get("before_agent_start")!;
		const persona = loadPersonaPrompt();
		const result = await handler({ systemPrompt: persona, systemPromptOptions: {} }, makeCtx());
		expect(result).toBeUndefined();
	});
});

describe("ask_user ツール", () => {
	it("TUI では選択肢を出し、選んだ内容を返す", async () => {
		const tool = createAskUserTool();
		const select = vi.fn(async () => "3万円まで");
		const ctx = makeCtx({ ui: { select, input: vi.fn(), notify: vi.fn() } as never });
		const result = await tool.execute("id", { question: "予算は？", options: ["1万円まで", "3万円まで"] }, undefined, undefined, ctx);
		expect(select).toHaveBeenCalledOnce();
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("3万円まで") });
		expect((result.details as { answers: string[] }).answers).toEqual(["3万円まで"]);
	});

	it("「その他」を選ぶと自由入力を求める", async () => {
		const tool = createAskUserTool();
		const select = vi.fn(async () => "その他（自由に入力する）");
		const input = vi.fn(async () => "5万円くらい");
		const ctx = makeCtx({ ui: { select, input, notify: vi.fn() } as never });
		const result = await tool.execute("id", { question: "予算は？", options: ["1万円まで"] }, undefined, undefined, ctx);
		expect(input).toHaveBeenCalledOnce();
		expect((result.details as { answers: string[] }).answers).toEqual(["5万円くらい"]);
	});

	it("キャンセルされたら cancelled を返す", async () => {
		const tool = createAskUserTool();
		const ctx = makeCtx({ ui: { select: vi.fn(async () => undefined), input: vi.fn(), notify: vi.fn() } as never });
		const result = await tool.execute("id", { question: "予算は？", options: ["A", "B"] }, undefined, undefined, ctx);
		expect((result.details as { cancelled: boolean }).cancelled).toBe(true);
	});

	it("UIが無いときは質問文を返してモデルに委ねる", async () => {
		const tool = createAskUserTool();
		const ctx = makeCtx({ hasUI: false, mode: "print" });
		const result = await tool.execute("id", { question: "予算は？", options: ["A"] }, undefined, undefined, ctx);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("本文でユーザーに投げかけて") });
	});
});

describe("requirements / candidates ツール", () => {
	it("聞き取りを記録し、候補の状態を管理する", async () => {
		const services = new Services();
		const requirements = createRequirementsTool(services);
		const candidates = createCandidatesTool(services);
		const ctx = makeCtx();

		await requirements.execute(
			"1",
			{ action: "update", goal: "花粉症対策", budget_max: 50000, must_have: ["静音"] },
			undefined,
			undefined,
			ctx,
		);
		const afterUpdate = await requirements.execute("2", { action: "get" }, undefined, undefined, ctx);
		expect(afterUpdate.content[0]).toMatchObject({ text: expect.stringContaining("花粉症対策") });

		await candidates.execute(
			"3",
			{
				action: "upsert",
				candidates: [{ url: "https://kakaku.com/item/K1/", title: "商品A", price: 39800 }],
			},
			undefined,
			undefined,
			ctx,
		);
		const state = services.getState();
		expect(state.candidates).toHaveLength(1);

		const id = state.candidates[0]!.id;
		await candidates.execute("4", { action: "status", id, status: "shortlisted" }, undefined, undefined, ctx);
		expect(services.getState().candidates[0]?.status).toBe("shortlisted");

		// details に状態スナップショットが入る（セッション復元に使う）
		const listed = await candidates.execute("5", { action: "list" }, undefined, undefined, ctx);
		expect((listed.details as { state: { candidates: unknown[] } }).state.candidates).toHaveLength(1);
	});

	it("存在しない候補の状態変更はエラーにする", async () => {
		const services = new Services();
		const candidates = createCandidatesTool(services);
		await expect(
			candidates.execute("1", { action: "status", id: "nope", status: "rejected" }, undefined, undefined, makeCtx()),
		).rejects.toThrow(/見つかりません/);
	});
});
