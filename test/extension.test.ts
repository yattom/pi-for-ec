import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import ecConcierge, {
	CONCIERGE_TOOL_NAMES,
	isActivationForced,
	loadPersonaPrompt,
	wasActivatedInBranch,
} from "../extensions/ec-concierge/index.ts";
import { createAskUserTool } from "../extensions/ec-concierge/tools/ask-user.ts";
import { createCandidatesTool, createRequirementsTool } from "../extensions/ec-concierge/tools/state-tools.ts";
import { Services } from "../extensions/ec-concierge/services.ts";

const BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write"];

/**
 * registerTool / registerCommand / on を記録するだけの ExtensionAPI スタブ。
 * getActiveTools/setActiveTools は、実際の pi と同じく「registerTool した瞬間にアクティブになる」
 * 挙動を模す（新規ツールは即座に呼び出し可能になるという pi の仕様に合わせる）。
 */
function makeApi() {
	const tools: Array<{ name: string; description: string; parameters: unknown }> = [];
	const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const providers: Array<{ name: string; config: unknown }> = [];
	const appendedEntries: Array<{ customType: string; data?: unknown }> = [];
	const sentMessages: string[] = [];
	let activeTools = [...BUILTIN_TOOL_NAMES];

	const api = {
		registerTool: (tool: { name: string; description: string; parameters: unknown }) => {
			tools.push(tool);
			activeTools = [...activeTools, tool.name];
		},
		registerCommand: (name: string, options: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) =>
			commands.set(name, options),
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => events.set(event, handler),
		registerProvider: (name: string, config: unknown) => providers.push({ name, config }),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
		appendEntry: (customType: string, data?: unknown) => appendedEntries.push({ customType, data }),
		sendUserMessage: async (content: string) => {
			sentMessages.push(content);
		},
	} as unknown as ExtensionAPI;
	return { api, tools, commands, events, providers, appendedEntries, sentMessages, getActiveTools: () => activeTools };
}

function makeCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		cwd: process.cwd(),
		hasUI: true,
		mode: "tui",
		isProjectTrusted: () => false,
		sessionManager: { getBranch: () => [] },
		signal: undefined,
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

		expect(tools.map((tool) => tool.name).sort()).toEqual([...CONCIERGE_TOOL_NAMES].sort());
		expect([...commands.keys()].sort()).toEqual(
			[
				"kaimono",
				"hikaku",
				"ec-on",
				"ec-off",
				"ec-config",
				"ec-models",
				"ec-reload",
				"ec-search-test",
				"ec-status",
			].sort(),
		);
		expect([...events.keys()]).toContain("session_start");
		expect([...events.keys()]).toContain("before_agent_start");
	});
});

describe("有効化ゲーティング（activation: manual が既定）", () => {
	it("session_start 直後はコンシェルジュのツールが無効になっている（素の pi と同じ状態）", async () => {
		const { api, events, getActiveTools } = makeApi();
		ecConcierge(api);
		await events.get("session_start")!({}, makeCtx());

		const active = getActiveTools();
		for (const name of CONCIERGE_TOOL_NAMES) expect(active).not.toContain(name);
		for (const name of BUILTIN_TOOL_NAMES) expect(active).toContain(name);
	});

	it("有効化前は before_agent_start が何もしない（システムプロンプトに触れない）", async () => {
		const { api, events } = makeApi();
		ecConcierge(api);
		await events.get("session_start")!({}, makeCtx());

		const result = await events.get("before_agent_start")!({ systemPrompt: "元のプロンプト", systemPromptOptions: {} }, makeCtx());
		expect(result).toBeUndefined();
	});

	it("/ec-on で有効化すると、以後はツールと persona の両方が有効になる", async () => {
		const { api, events, commands, getActiveTools } = makeApi();
		ecConcierge(api);
		const ctx = makeCtx();
		await events.get("session_start")!({}, ctx);

		await commands.get("ec-on")!.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("有効化しました"), "info");
		for (const name of CONCIERGE_TOOL_NAMES) expect(getActiveTools()).toContain(name);

		const result = (await events.get("before_agent_start")!(
			{ systemPrompt: "元のプロンプト", systemPromptOptions: {} },
			ctx,
		)) as { systemPrompt?: string } | undefined;
		expect(result?.systemPrompt).toContain("元のプロンプト");
		expect(result?.systemPrompt).toContain("ショッピング・コンシェルジュ");
	});

	it("すでに有効化されているときの /ec-on はその旨を伝えるだけ", async () => {
		const { api, events, commands } = makeApi();
		ecConcierge(api);
		const ctx = makeCtx();
		await events.get("session_start")!({}, ctx);
		await commands.get("ec-on")!.handler("", ctx);
		(ctx.ui.notify as ReturnType<typeof vi.fn>).mockClear();

		await commands.get("ec-on")!.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("すでに有効化"), "info");
	});

	it("/ec-off で無効化すると、ツールと persona がまた無効になる", async () => {
		const { api, events, commands, getActiveTools } = makeApi();
		ecConcierge(api);
		const ctx = makeCtx();
		await events.get("session_start")!({}, ctx);
		await commands.get("ec-on")!.handler("", ctx);

		await commands.get("ec-off")!.handler("", ctx);
		for (const name of CONCIERGE_TOOL_NAMES) expect(getActiveTools()).not.toContain(name);
		const result = await events.get("before_agent_start")!({ systemPrompt: "元のプロンプト", systemPromptOptions: {} }, ctx);
		expect(result).toBeUndefined();
	});

	it("有効化されていないときの /ec-off はその旨を伝えるだけ", async () => {
		const { api, events, commands } = makeApi();
		ecConcierge(api);
		const ctx = makeCtx();
		await events.get("session_start")!({}, ctx);

		await commands.get("ec-off")!.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("有効化されていません"), "info");
	});

	it("/kaimono は通知なしで有効化し、要望を通常のユーザーメッセージとして送る", async () => {
		const { api, events, commands, getActiveTools, sentMessages } = makeApi();
		ecConcierge(api);
		const ctx = makeCtx();
		await events.get("session_start")!({}, ctx);

		await commands.get("kaimono")!.handler("空気清浄機がほしい", ctx);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
		expect(sentMessages[0]).toContain("空気清浄機がほしい");
		expect(sentMessages[0]).toContain("requirements(update)");
		for (const name of CONCIERGE_TOOL_NAMES) expect(getActiveTools()).toContain(name);
	});

	it("/hikaku も同様に有効化し、比較の進め方を送る", async () => {
		const { api, events, commands, sentMessages } = makeApi();
		ecConcierge(api);
		const ctx = makeCtx();
		await events.get("session_start")!({}, ctx);

		await commands.get("hikaku")!.handler("商品A 商品B", ctx);
		expect(sentMessages[0]).toContain("商品A 商品B");
		expect(sentMessages[0]).toContain("比較");
	});

	it("引数なしの /kaimono / /hikaku でも案内文になる", async () => {
		const { api, events, commands, sentMessages } = makeApi();
		ecConcierge(api);
		const ctx = makeCtx();
		await events.get("session_start")!({}, ctx);

		await commands.get("kaimono")!.handler("", ctx);
		expect(sentMessages[0]).toContain("まず何を聞けばいいか提案してください");
	});

	it("独自システムプロンプトが指定されていれば追記しない（有効化後も）", async () => {
		const { api, events, commands } = makeApi();
		ecConcierge(api);
		const ctx = makeCtx();
		await events.get("session_start")!({}, ctx);
		await commands.get("ec-on")!.handler("", ctx);

		const result = await events.get("before_agent_start")!(
			{ systemPrompt: "custom", systemPromptOptions: { customPrompt: "custom" } },
			ctx,
		);
		expect(result).toBeUndefined();
	});

	it("すでにコンシェルジュ指示が入っていれば二重に足さない", async () => {
		const { api, events, commands } = makeApi();
		ecConcierge(api);
		const ctx = makeCtx();
		await events.get("session_start")!({}, ctx);
		await commands.get("ec-on")!.handler("", ctx);

		const persona = loadPersonaPrompt();
		const result = await events.get("before_agent_start")!({ systemPrompt: persona, systemPromptOptions: {} }, ctx);
		expect(result).toBeUndefined();
	});
});

describe("isActivationForced", () => {
	it("activation: always なら常に強制する", () => {
		expect(isActivationForced({ activation: "always" }, {})).toBe(true);
	});

	it("PI_EC_ACTIVATE=1 が設定されていれば manual でも強制する（ランチャー経由の起動）", () => {
		expect(isActivationForced({ activation: "manual" }, { PI_EC_ACTIVATE: "1" })).toBe(true);
	});

	it("どちらもなければ強制しない", () => {
		expect(isActivationForced({ activation: "manual" }, {})).toBe(false);
		expect(isActivationForced({ activation: "manual" }, { PI_EC_ACTIVATE: "0" })).toBe(false);
	});
});

describe("wasActivatedInBranch", () => {
	it("有効化イベントがあれば true", () => {
		expect(wasActivatedInBranch([{ type: "custom", customType: "ec-concierge-activated" }])).toBe(true);
	});

	it("無効化イベントの方が後ならば false（直近の状態が勝つ）", () => {
		expect(
			wasActivatedInBranch([
				{ type: "custom", customType: "ec-concierge-activated" },
				{ type: "custom", customType: "ec-concierge-deactivated" },
			]),
		).toBe(false);
	});

	it("その後また有効化されれば true に戻る", () => {
		expect(
			wasActivatedInBranch([
				{ type: "custom", customType: "ec-concierge-activated" },
				{ type: "custom", customType: "ec-concierge-deactivated" },
				{ type: "custom", customType: "ec-concierge-activated" },
			]),
		).toBe(true);
	});

	it("無関係なエントリは無視する", () => {
		expect(wasActivatedInBranch([{ type: "message" }, { type: "custom", customType: "other-extension" }])).toBe(false);
	});

	it("空なら false", () => {
		expect(wasActivatedInBranch([])).toBe(false);
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
