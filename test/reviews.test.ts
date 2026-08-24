import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../extensions/ec-concierge/config.ts";
import {
	buildPageSummaryPrompt,
	buildReviewQueries,
	matchReviewSite,
	pickDiverseResults,
} from "../extensions/ec-concierge/reviews.ts";
import type { SearchResult } from "../extensions/ec-concierge/search/index.ts";

const sites = DEFAULT_CONFIG.reviewSites;

describe("buildReviewQueries", () => {
	it("日本語サイト向けに肯定・否定の2クエリを作る", () => {
		const queries = buildReviewQueries({ subject: "KI-RX50", aspects: ["静音性"] }, sites);
		expect(queries).toHaveLength(2);
		expect(queries[0]?.query).toContain("KI-RX50");
		expect(queries[0]?.query).toContain("静音性");
		expect(queries[1]?.query).toContain("欠点");
		expect(queries[0]?.sites).toContain("kakaku.com");
		expect(queries[0]?.sites).not.toContain("rtings.com");
	});

	it("include_international で海外サイト向けクエリを足す", () => {
		const queries = buildReviewQueries({ subject: "Sony WH-1000XM6", includeInternational: true }, sites);
		expect(queries).toHaveLength(3);
		expect(queries[2]?.lang).toBe("any");
		expect(queries[2]?.sites).toContain("rtings.com");
	});

	it("既定では海外サイトを参照しない", () => {
		const queries = buildReviewQueries({ subject: "X" }, sites);
		expect(queries.every((query) => query.lang === "ja")).toBe(true);
	});
});

describe("matchReviewSite", () => {
	it("サブドメインでも一致する", () => {
		expect(matchReviewSite("https://review.kakaku.com/review/K1/", sites)?.id).toBe("kakaku-review");
		expect(matchReviewSite("https://example.com/x", sites)).toBeUndefined();
	});
});

describe("pickDiverseResults", () => {
	const results: SearchResult[] = [
		{ title: "A1", url: "https://kakaku.com/1", snippet: "", backend: "brave" },
		{ title: "A2", url: "https://kakaku.com/2", snippet: "", backend: "brave" },
		{ title: "A3", url: "https://kakaku.com/3", snippet: "", backend: "brave" },
		{ title: "B1", url: "https://my-best.com/1", snippet: "", backend: "brave" },
		{ title: "C1", url: "https://note.com/1", snippet: "", backend: "brave" },
	];

	it("同じドメインに偏らないよう1件ずつ拾う", () => {
		const picked = pickDiverseResults(results, sites, 3);
		const hosts = picked.map((result) => new URL(result.url).hostname);
		expect(new Set(hosts).size).toBe(3);
	});

	it("件数が足りなければ同じドメインの2周目を使う", () => {
		const picked = pickDiverseResults(results, sites, 5);
		expect(picked).toHaveLength(5);
	});

	it("上限より結果が少なくても落ちない", () => {
		expect(pickDiverseResults(results.slice(0, 1), sites, 4)).toHaveLength(1);
		expect(pickDiverseResults([], sites, 4)).toEqual([]);
	});
});

describe("buildPageSummaryPrompt", () => {
	it("観点と本文を含め、推測を禁じる", () => {
		const prompt = buildPageSummaryPrompt({
			subject: "KI-RX50",
			aspects: ["静音性"],
			title: "レビュー記事",
			url: "https://kakaku.com/review/1",
			text: "本文テキスト",
			translate: false,
		});
		expect(prompt).toContain("KI-RX50");
		expect(prompt).toContain("静音性");
		expect(prompt).toContain("本文テキスト");
		expect(prompt).toContain("記載なし");
		expect(prompt).not.toContain("日本語以外で書かれています");
	});

	it("海外記事には翻訳指示を入れる", () => {
		const prompt = buildPageSummaryPrompt({
			subject: "X",
			title: "T",
			url: "https://rtings.com/1",
			text: "body",
			translate: true,
		});
		expect(prompt).toContain("日本語に要約");
	});
});
