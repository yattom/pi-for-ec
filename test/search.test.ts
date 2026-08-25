import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../extensions/ec-concierge/config.ts";
import { HttpClient } from "../extensions/ec-concierge/http.ts";
import {
	backendCandidates,
	buildTavilyRequest,
	hasConfiguredBackend,
	parseSerperResponse,
	parseTavilyResponse,
	parseBraveResponse,
	parseDuckDuckGoHtml,
	parseGoogleCseResponse,
	parseSearxngResponse,
	unwrapDuckDuckGoRedirect,
} from "../extensions/ec-concierge/search/backends.ts";
import { WebSearch, formatSearchResults } from "../extensions/ec-concierge/search/index.ts";
import { buildQueryString } from "../extensions/ec-concierge/search/types.ts";

describe("buildQueryString", () => {
	it("サイト指定なしならクエリそのまま", () => {
		expect(buildQueryString({ query: "空気清浄機 おすすめ" })).toBe("空気清浄機 おすすめ");
	});

	it("1サイトなら site: を付ける", () => {
		expect(buildQueryString({ query: "KI-RX50", sites: ["kakaku.com"] })).toBe("KI-RX50 site:kakaku.com");
	});

	it("複数サイトは OR でまとめる", () => {
		expect(buildQueryString({ query: "KI-RX50 レビュー", sites: ["kakaku.com", "my-best.com"] })).toBe(
			"KI-RX50 レビュー (site:kakaku.com OR site:my-best.com)",
		);
	});
});

describe("バックエンドのレスポンス解析", () => {
	it("Brave", () => {
		const results = parseBraveResponse({
			web: {
				results: [
					{ title: "商品 &amp; レビュー", url: "https://example.com/a?utm_source=brave", description: "<b>安い</b>" },
					{ title: "URLなし" },
				],
			},
		});
		expect(results).toEqual([
			{
				title: "商品 & レビュー",
				url: "https://example.com/a",
				snippet: "安い",
				backend: "brave",
				published: undefined,
			},
		]);
	});

	it("Google Programmable Search", () => {
		const results = parseGoogleCseResponse({
			items: [{ title: "タイトル", link: "https://example.com/b", snippet: "説明" }],
		});
		expect(results[0]).toMatchObject({ url: "https://example.com/b", backend: "google-cse" });
	});

	it("SearXNG", () => {
		const results = parseSearxngResponse({
			results: [{ title: "T", url: "https://example.com/c", content: "内容", publishedDate: "2026-01-01" }],
		});
		expect(results[0]).toMatchObject({ backend: "searxng", published: "2026-01-01" });
	});

	it("Tavily", () => {
		const results = parseTavilyResponse({
			results: [
				{
					title: "空気清浄機のおすすめ",
					url: "https://my-best.com/1?utm_source=x",
					content: "検証しました\n改行あり",
					published_date: "2026-03-01",
				},
				{ title: "URLなし" },
			],
		});
		expect(results).toEqual([
			{
				title: "空気清浄機のおすすめ",
				url: "https://my-best.com/1",
				snippet: "検証しました 改行あり",
				backend: "tavily",
				published: "2026-03-01",
			},
		]);
	});

	it("Serper", () => {
		const results = parseSerperResponse({
			organic: [{ title: "T", link: "https://kakaku.com/item/1", snippet: "最安 39,800円", date: "2026-01-01" }],
		});
		expect(results[0]).toMatchObject({ url: "https://kakaku.com/item/1", backend: "serper", published: "2026-01-01" });
	});

	it("想定外の形でも落ちない", () => {
		expect(parseBraveResponse(null)).toEqual([]);
		expect(parseGoogleCseResponse({})).toEqual([]);
		expect(parseSearxngResponse({ results: "bad" })).toEqual([]);
		expect(parseTavilyResponse({ results: null })).toEqual([]);
		expect(parseSerperResponse({ error: "invalid key" })).toEqual([]);
	});
});

describe("buildTavilyRequest", () => {
	it("サイト制限は site: ではなく include_domains で渡す", () => {
		const body = buildTavilyRequest(
			{ query: "KI-RX50 レビュー", sites: ["kakaku.com", "my-best.com"], count: 5 },
			DEFAULT_CONFIG.search,
		);
		expect(body).toMatchObject({
			query: "KI-RX50 レビュー",
			max_results: 5,
			include_domains: ["kakaku.com", "my-best.com"],
			topic: "general",
		});
		expect(JSON.stringify(body)).not.toContain("site:");
	});

	it("country は設定されているときだけ送る", () => {
		expect(buildTavilyRequest({ query: "x" }, DEFAULT_CONFIG.search)).not.toHaveProperty("country");
		expect(
			buildTavilyRequest({ query: "x" }, { ...DEFAULT_CONFIG.search, tavily: { ...DEFAULT_CONFIG.search.tavily, country: "japan" } }),
		).toMatchObject({ country: "japan" });
	});
});

describe("DuckDuckGo HTML の解析", () => {
	const html = `
		<div class="result">
			<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fkakaku.com%2Fitem%2F1&amp;rut=x">価格.com の商品</a>
			<a class="result__snippet">最安値 <b>39,800円</b></a>
		</div>
		<div class="result">
			<a class="result__a" href="https://my-best.com/1234">おすすめ10選</a>
			<a class="result__snippet">比較検証しました</a>
		</div>`;

	it("リダイレクトURLを実URLへ戻す", () => {
		expect(unwrapDuckDuckGoRedirect("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx")).toBe(
			"https://example.com/x",
		);
		expect(unwrapDuckDuckGoRedirect("https://example.com/y")).toBe("https://example.com/y");
		expect(unwrapDuckDuckGoRedirect("")).toBeUndefined();
	});

	it("結果とスニペットを取り出す", () => {
		const results = parseDuckDuckGoHtml(html);
		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({
			title: "価格.com の商品",
			url: "https://kakaku.com/item/1",
			backend: "duckduckgo",
		});
		expect(results[0]?.snippet).toContain("39,800円");
		expect(results[1]?.url).toBe("https://my-best.com/1234");
	});
});

describe("backendCandidates / hasConfiguredBackend", () => {
	const availability = {
		brave: false,
		tavily: true,
		serper: false,
		searxng: true,
		"google-cse": true,
		duckduckgo: true,
	};

	it("auto なら使えるものを優先順に並べる", () => {
		expect(backendCandidates("auto", availability)).toEqual(["tavily", "searxng", "google-cse", "duckduckgo"]);
	});

	it("明示指定はそのまま使う（資格情報がなくても試す）", () => {
		expect(backendCandidates("brave", availability)).toEqual(["brave"]);
	});

	it("キーが要るバックエンドが1つも無い状態を見分ける", () => {
		const keyless = { brave: false, tavily: true, serper: false, searxng: false, "google-cse": false, duckduckgo: true };
		expect(hasConfiguredBackend(keyless)).toBe(false);
		expect(hasConfiguredBackend(availability)).toBe(true);
	});
});

describe("WebSearch", () => {
	function makeSearch(handler: (url: string) => Response) {
		const http = new HttpClient({ ...DEFAULT_CONFIG.http, minIntervalMsPerHost: 0 });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => handler(String(input))),
		);
		return { http };
	}

	it("失敗したバックエンドを飛ばして次を使う", async () => {
		const { http } = makeSearch((url) => {
			if (url.includes("api.search.brave.com")) return new Response("nope", { status: 401 });
			if (url.includes("googleapis.com")) {
				return new Response(JSON.stringify({ items: [{ title: "T", link: "https://example.com/x", snippet: "s" }] }), {
					status: 200,
				});
			}
			return new Response("{}", { status: 200 });
		});
		const search = new WebSearch(
			http,
			() => DEFAULT_CONFIG.search,
			async (value) =>
				value === "$BRAVE_SEARCH_API_KEY" ? "brave-key" : value === "$GOOGLE_CSE_API_KEY" ? "google-key" : value === "$GOOGLE_CSE_CX" ? "cx" : undefined,
		);
		const outcome = await search.search({ query: "テスト" });
		expect(outcome.backend).toBe("google-cse");
		expect(outcome.attempts[0]).toMatchObject({ backend: "brave" });
		expect(outcome.results).toHaveLength(1);
		vi.unstubAllGlobals();
	});

	it("キーが何も無いときは Tavily のキーレスモードを使う", async () => {
		const requests: Array<{ url: string; init?: RequestInit }> = [];
		const http = new HttpClient({ ...DEFAULT_CONFIG.http, minIntervalMsPerHost: 0 });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requests.push({ url: String(input), init });
				return new Response(
					JSON.stringify({ results: [{ title: "T", url: "https://my-best.com/1", content: "内容" }] }),
					{ status: 200 },
				);
			}),
		);
		const search = new WebSearch(
			http,
			() => DEFAULT_CONFIG.search,
			async () => undefined, // どのキーも解決できない
		);

		const outcome = await search.search({ query: "空気清浄機 おすすめ" });
		expect(outcome.backend).toBe("tavily");
		expect(outcome.results).toHaveLength(1);

		const headers = requests[0]?.init?.headers as Record<string, string>;
		expect(requests[0]?.url).toContain("api.tavily.com");
		expect(headers["x-tavily-access-mode"]).toBe("keyless");
		expect(headers.authorization).toBeUndefined();
		vi.unstubAllGlobals();
	});

	it("キーがあれば Bearer で送る", async () => {
		const requests: Array<{ init?: RequestInit }> = [];
		const http = new HttpClient({ ...DEFAULT_CONFIG.http, minIntervalMsPerHost: 0 });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				requests.push({ init });
				return new Response(JSON.stringify({ results: [{ title: "T", url: "https://x.test/1" }] }), { status: 200 });
			}),
		);
		const search = new WebSearch(
			http,
			() => ({ ...DEFAULT_CONFIG.search, backend: "tavily" as const }),
			async (value) => (value === "$TAVILY_API_KEY" ? "tvly-key" : undefined),
		);

		await search.search({ query: "テスト" });
		const headers = requests[0]?.init?.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer tvly-key");
		expect(headers["x-tavily-access-mode"]).toBeUndefined();
		vi.unstubAllGlobals();
	});

	it("全滅したときのエラーに設定方法の案内を含める", async () => {
		const http = new HttpClient({ ...DEFAULT_CONFIG.http, minIntervalMsPerHost: 0 });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("rate limited", { status: 429 })),
		);
		const search = new WebSearch(
			http,
			() => DEFAULT_CONFIG.search,
			async () => undefined,
		);
		await expect(search.search({ query: "テスト" })).rejects.toThrow(/TAVILY_API_KEY/);
		vi.unstubAllGlobals();
	});

	it("使えるバックエンドが1つもなければ分かるエラーにする", async () => {
		const http = new HttpClient(DEFAULT_CONFIG.http);
		const search = new WebSearch(
			http,
			() => ({ ...DEFAULT_CONFIG.search, duckduckgo: { ...DEFAULT_CONFIG.search.duckduckgo } }),
			async () => undefined,
		);
		// duckduckgo は常に利用可能なので、backend を searxng に固定して資格情報なしを再現する
		const searxOnly = new WebSearch(
			http,
			() => ({ ...DEFAULT_CONFIG.search, backend: "searxng" as const }),
			async () => undefined,
		);
		await expect(searxOnly.search({ query: "テスト" })).rejects.toThrow(/SearXNG/);
		expect(await search.availability()).toMatchObject({ duckduckgo: true, brave: false });
	});
});

describe("formatSearchResults", () => {
	it("番号付きでURL付きに整形する", () => {
		const text = formatSearchResults([
			{ title: "商品A", url: "https://kakaku.com/item/1", snippet: "説明", backend: "brave" },
		]);
		expect(text).toContain("1. 商品A");
		expect(text).toContain("https://kakaku.com/item/1");
		expect(text).toContain("kakaku.com");
	});

	it("空でも壊れない", () => {
		expect(formatSearchResults([])).toBe("(検索結果なし)");
	});
});
