import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../extensions/ec-concierge/config.ts";
import { HttpClient } from "../extensions/ec-concierge/http.ts";
import {
	backendCandidates,
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

	it("想定外の形でも落ちない", () => {
		expect(parseBraveResponse(null)).toEqual([]);
		expect(parseGoogleCseResponse({})).toEqual([]);
		expect(parseSearxngResponse({ results: "bad" })).toEqual([]);
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

describe("backendCandidates", () => {
	const availability = { brave: false, "google-cse": true, searxng: true, duckduckgo: true };

	it("auto なら使えるものを優先順に並べる", () => {
		expect(backendCandidates("auto", availability)).toEqual(["google-cse", "searxng", "duckduckgo"]);
	});

	it("明示指定はそのまま使う（資格情報がなくても試す）", () => {
		expect(backendCandidates("brave", availability)).toEqual(["brave"]);
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
