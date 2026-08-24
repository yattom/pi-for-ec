import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Services } from "../extensions/ec-concierge/services.ts";
import { buildExtractPrompt, createWebFetchTool, createWebSearchTool } from "../extensions/ec-concierge/tools/web.ts";

function makeCtx(): ExtensionContext {
	return {
		cwd: process.cwd(),
		hasUI: false,
		mode: "print",
		signal: undefined,
		ui: { notify: vi.fn(), setStatus: vi.fn() },
	} as unknown as ExtensionContext;
}

function stubFetch(handler: (url: string) => Response) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) => handler(String(input))),
	);
}

describe("buildExtractPrompt", () => {
	it("知りたいことと本文を含め、推測を禁じる", () => {
		const prompt = buildExtractPrompt({
			url: "https://example.com/item",
			title: "商品ページ",
			purpose: "保証期間",
			text: "本文",
			});
		expect(prompt).toContain("保証期間");
		expect(prompt).toContain("本文");
		expect(prompt).toContain("推測は禁止");
	});
});

describe("web_fetch ツール", () => {
	afterEach(() => vi.unstubAllGlobals());

	const longBody = `<html><body><h1>空気清浄機</h1><p>${"仕様の説明。".repeat(2000)}</p><p>39,800円</p></body></html>`;

	it("長いページは extract ロールのモデルで要約する", async () => {
		stubFetch((url) =>
			url.endsWith("/robots.txt")
				? new Response("", { status: 404 })
				: new Response(longBody, { status: 200, headers: { "content-type": "text/html" } }),
		);
		const services = new Services();
		const tryRun = vi.fn(async () => ({
			text: "- 商品名: 空気清浄機\n- 価格: 39,800円",
			modelLabel: "lan-llama/qwen3",
			fallbackUsed: false,
			usage: undefined,
		}));
		services.roles.tryRun = tryRun as never;

		const tool = createWebFetchTool(services);
		const result = await tool.execute(
			"1",
			{ url: "https://example.com/item", purpose: "価格" },
			undefined,
			undefined,
			makeCtx(),
		);
		expect(tryRun).toHaveBeenCalledOnce();
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("要約モデル: lan-llama/qwen3");
		expect(text).toContain("39,800円");
		expect(result.details).toMatchObject({ summarized: true, modelLabel: "lan-llama/qwen3" });
	});

	it("要約モデルが使えなければ本文を切り詰めて返す", async () => {
		stubFetch((url) =>
			url.endsWith("/robots.txt")
				? new Response("", { status: 404 })
				: new Response(longBody, { status: 200, headers: { "content-type": "text/html" } }),
		);
		const services = new Services();
		services.roles.tryRun = (async () => undefined) as never;

		const tool = createWebFetchTool(services);
		const result = await tool.execute("1", { url: "https://example.com/item" }, undefined, undefined, makeCtx());
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("空気清浄機");
		expect(text).toContain("文字を省略しました");
		expect(result.details).toMatchObject({ summarized: false });
	});

	it("summarize: never なら短いページと同じくそのまま返す", async () => {
		stubFetch((url) =>
			url.endsWith("/robots.txt")
				? new Response("", { status: 404 })
				: new Response("<p>短い本文</p>", { status: 200, headers: { "content-type": "text/html" } }),
		);
		const services = new Services();
		const tryRun = vi.fn();
		services.roles.tryRun = tryRun as never;

		const tool = createWebFetchTool(services);
		const result = await tool.execute(
			"1",
			{ url: "https://example.com/item", summarize: "never" },
			undefined,
			undefined,
			makeCtx(),
		);
		expect(tryRun).not.toHaveBeenCalled();
		expect((result.content[0] as { text: string }).text).toContain("短い本文");
	});

	it("robots.txt で拒否されたらエラーにする", async () => {
		stubFetch((url) =>
			url.endsWith("/robots.txt")
				? new Response("User-agent: *\nDisallow: /", { status: 200 })
				: new Response("<p>x</p>", { status: 200, headers: { "content-type": "text/html" } }),
		);
		const services = new Services();
		const tool = createWebFetchTool(services);
		await expect(
			tool.execute("1", { url: "https://example.com/item" }, undefined, undefined, makeCtx()),
		).rejects.toThrow(/robots\.txt/);
	});
});

describe("web_search ツール", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("使ったバックエンドと結果を返す", async () => {
		stubFetch((url) => {
			if (url.includes("html.duckduckgo.com")) {
				return new Response(
					'<a class="result__a" href="https://kakaku.com/item/1">価格.com</a><a class="result__snippet">最安 39,800円</a>',
					{ status: 200 },
				);
			}
			return new Response("{}", { status: 200 });
		});
		const services = new Services();
		// 実行環境に検索APIキーがあってもテストがぶれないよう、バックエンドを固定する
		services.getConfig().search.backend = "duckduckgo";
		const tool = createWebSearchTool(services);
		const result = await tool.execute("1", { query: "空気清浄機 おすすめ" }, undefined, undefined, makeCtx());
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain("バックエンド: duckduckgo");
		expect(text).toContain("https://kakaku.com/item/1");
		expect(result.details).toMatchObject({ backend: "duckduckgo", count: 1 });
	});
});
