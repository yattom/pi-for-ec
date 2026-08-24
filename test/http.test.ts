import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../extensions/ec-concierge/config.ts";
import { HttpClient, isPathAllowed, parseRobots } from "../extensions/ec-concierge/http.ts";

describe("parseRobots", () => {
	const robots = `
User-agent: *
Disallow: /private/
Allow: /private/public-page

User-agent: pi-ec-concierge
Disallow: /nope/
`;

	it("自分の User-agent 向けグループを優先する", () => {
		const rules = parseRobots(robots, "pi-ec-concierge");
		expect(rules).toEqual([{ type: "disallow", path: "/nope/" }]);
	});

	it("該当がなければ * グループを使う", () => {
		const rules = parseRobots(robots, "other-bot");
		expect(rules).toEqual([
			{ type: "disallow", path: "/private/" },
			{ type: "allow", path: "/private/public-page" },
		]);
	});

	it("コメントと空行を無視する", () => {
		const rules = parseRobots("# comment\nUser-agent: *\n\nDisallow: /a # trailing", "any");
		expect(rules).toEqual([{ type: "disallow", path: "/a" }]);
	});

	it("連続する User-agent 行を同じグループとして扱う", () => {
		const rules = parseRobots("User-agent: a\nUser-agent: b\nDisallow: /x", "b");
		expect(rules).toEqual([{ type: "disallow", path: "/x" }]);
	});
});

describe("isPathAllowed", () => {
	it("ルールがなければ許可", () => {
		expect(isPathAllowed([], "/anything")).toBe(true);
	});

	it("最長一致が勝つ", () => {
		const rules = parseRobots("User-agent: *\nDisallow: /private/\nAllow: /private/public-page", "x");
		expect(isPathAllowed(rules, "/private/secret")).toBe(false);
		expect(isPathAllowed(rules, "/private/public-page")).toBe(true);
		expect(isPathAllowed(rules, "/open")).toBe(true);
	});

	it("ワイルドカードと行末アンカーを扱う", () => {
		const rules = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /a/*/b", "x");
		expect(isPathAllowed(rules, "/docs/manual.pdf")).toBe(false);
		expect(isPathAllowed(rules, "/docs/manual.pdf?x=1")).toBe(true);
		expect(isPathAllowed(rules, "/a/xx/b")).toBe(false);
	});

	it("空の Disallow は「すべて許可」の意味", () => {
		const rules = parseRobots("User-agent: *\nDisallow:", "x");
		expect(isPathAllowed(rules, "/anything")).toBe(true);
	});
});

describe("HttpClient", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const config = { ...DEFAULT_CONFIG.http, minIntervalMsPerHost: 0 };

	function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init));
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	it("robots.txt で禁止されたページは取得しない", async () => {
		stubFetch((url) => {
			if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /secret", { status: 200 });
			return new Response("<html><body>秘密</body></html>", {
				status: 200,
				headers: { "content-type": "text/html" },
			});
		});
		const client = new HttpClient(config);
		await expect(client.fetchText("https://example.com/secret/page")).rejects.toThrow(/robots\.txt/);
	});

	it("HTML を本文テキストにして返す", async () => {
		stubFetch((url) => {
			if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
			return new Response("<html><body><h1>椅子</h1><p>39,800円</p></body></html>", {
				status: 200,
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		});
		const client = new HttpClient(config);
		const result = await client.fetchText("https://example.com/item");
		expect(result.text).toContain("椅子");
		expect(result.text).toContain("39,800円");
		expect(result.text).not.toContain("<h1>");
		expect(result.status).toBe(200);
	});

	it("User-Agent を付けて送る", async () => {
		const fetchMock = stubFetch(() => new Response("{}", { status: 200 }));
		const client = new HttpClient(config);
		await client.fetchJson("https://api.example.com/search");
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect((init.headers as Record<string, string>)["user-agent"]).toBe(config.userAgent);
	});

	it("エラー応答は HttpError にする", async () => {
		stubFetch(() => new Response("rate limited", { status: 429 }));
		const client = new HttpClient(config);
		await expect(client.fetchJson("https://api.example.com/search")).rejects.toThrow(/429/);
	});

	it("JSON でない応答を明示的に失敗させる", async () => {
		stubFetch(() => new Response("<html>error page</html>", { status: 200 }));
		const client = new HttpClient(config);
		await expect(client.fetchJson("https://api.example.com/search")).rejects.toThrow(/JSON として解釈できない/);
	});

	it("robots.txt を尊重しない設定なら取得できる", async () => {
		stubFetch((url) => {
			if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /", { status: 200 });
			return new Response("<p>ok</p>", { status: 200, headers: { "content-type": "text/html" } });
		});
		const client = new HttpClient({ ...config, respectRobotsTxt: false });
		await expect(client.fetchText("https://example.com/any")).resolves.toMatchObject({ status: 200 });
	});

	it("同一ホストの robots.txt は1回しか取得しない", async () => {
		const fetchMock = stubFetch((url) => {
			if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /x", { status: 200 });
			return new Response("<p>ok</p>", { status: 200, headers: { "content-type": "text/html" } });
		});
		const client = new HttpClient(config);
		await client.fetchText("https://example.com/a");
		await client.fetchText("https://example.com/b");
		const robotsCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/robots.txt"));
		expect(robotsCalls).toHaveLength(1);
	});
});
