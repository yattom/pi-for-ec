/**
 * 独立系レビューサイト（ECサイト自身ではないメディア・口コミ）の調査。
 *
 * 手順:
 *   1. レビューサイトのドメインに絞って Web検索（pi 実行マシンから発行）
 *   2. 上位ページを取得してテキスト化
 *   3. review / translate ロールのモデルで「良い点・悪い点・要注意点」に整理
 * 出典URLを必ず残し、コンシェルジュが根拠を示せるようにする。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewSiteConfig } from "./config.ts";
import type { HttpClient } from "./http.ts";
import type { RoleRouter } from "./roles.ts";
import { sumUsage } from "./roles.ts";
import type { SearchQuery, SearchResult, WebSearch } from "./search/index.ts";
import { hostnameOf, matchesDomain, truncate } from "./util.ts";
import type { Usage } from "@earendil-works/pi-ai";

export interface ReviewResearchRequest {
	/** 商品名・型番、またはカテゴリ */
	subject: string;
	/** 特に知りたい観点（例: ["静音性", "手入れのしやすさ"]） */
	aspects?: string[];
	/** 日本語以外のサイトも参照するか */
	includeInternational?: boolean;
	/** 読み込むページ数の上限 */
	maxPages?: number;
	/** 対象を特定のサイトIDに絞る */
	siteIds?: string[];
}

export interface ReviewPageSummary {
	title: string;
	url: string;
	site: string;
	lang: ReviewSiteConfig["lang"];
	kind: ReviewSiteConfig["kind"];
	summary: string;
	/** 要約に使ったモデル。生テキストのまま返した場合は undefined */
	modelLabel?: string;
	error?: string;
}

export interface ReviewResearchResult {
	subject: string;
	pages: ReviewPageSummary[];
	searchErrors: string[];
	usage?: Usage;
}

/** レビュー検索用のクエリを組み立てる。 */
export function buildReviewQueries(request: ReviewResearchRequest, sites: readonly ReviewSiteConfig[]): SearchQuery[] {
	const japanese = sites.filter((site) => site.lang === "ja").map((site) => site.domain);
	const international = sites.filter((site) => site.lang !== "ja").map((site) => site.domain);
	const aspects = (request.aspects ?? []).join(" ");
	const queries: SearchQuery[] = [];

	if (japanese.length > 0) {
		queries.push({ query: `${request.subject} レビュー 評価 ${aspects}`.trim(), sites: japanese, lang: "ja", count: 8 });
		queries.push({ query: `${request.subject} 口コミ 欠点 デメリット`.trim(), sites: japanese, lang: "ja", count: 6 });
	}
	if (request.includeInternational && international.length > 0) {
		queries.push({ query: `${request.subject} review pros cons`, sites: international, lang: "any", count: 6 });
	}
	return queries;
}

/** URL からレビューサイト設定を引く。 */
export function matchReviewSite(url: string, sites: readonly ReviewSiteConfig[]): ReviewSiteConfig | undefined {
	return sites.find((site) => matchesDomain(url, site.domain));
}

/** 1ページ分の要約プロンプト。 */
export function buildPageSummaryPrompt(options: {
	subject: string;
	aspects?: string[];
	title: string;
	url: string;
	text: string;
	translate: boolean;
}): string {
	const aspects = options.aspects?.length ? `特に次の観点を重視してください: ${options.aspects.join(", ")}\n` : "";
	const translateNote = options.translate
		? "この記事は日本語以外で書かれています。内容を日本語に要約してください。\n"
		: "";
	return [
		`次のレビュー記事を読み、「${options.subject}」の購入判断に役立つ情報を抽出してください。`,
		translateNote + aspects,
		"出力形式（Markdown、全体で400字程度）:",
		"- 評価対象: (記事が扱っている具体的な製品名／型番)",
		"- 良い点: 箇条書き2〜4個",
		"- 悪い点・注意点: 箇条書き2〜4個",
		"- 向いている人 / 向かない人: 1行ずつ",
		"- 記事の性格: 実機レビュー / スペック紹介 / 広告色が強い のいずれかとその理由を一言",
		"",
		"記事に書かれていないことは推測せず「記載なし」と書いてください。",
		"",
		`タイトル: ${options.title}`,
		`URL: ${options.url}`,
		"---",
		options.text,
	].join("\n");
}

const SUMMARY_SYSTEM_PROMPT =
	"あなたは製品レビューを読み解くリサーチャーです。宣伝文句と実測・実体験を区別し、事実だけを簡潔にまとめます。";

export class ReviewResearcher {
	constructor(
		private readonly http: HttpClient,
		private readonly webSearch: WebSearch,
		private readonly roles: RoleRouter,
		private readonly getSites: () => ReviewSiteConfig[],
		private readonly getMaxChars: () => number,
	) {}

	async research(ctx: ExtensionContext, request: ReviewResearchRequest, signal?: AbortSignal): Promise<ReviewResearchResult> {
		const allSites = this.getSites();
		const sites = request.siteIds?.length ? allSites.filter((site) => request.siteIds!.includes(site.id)) : allSites;
		const queries = buildReviewQueries(request, sites);
		const { results, errors } = await this.webSearch.searchMany(queries, signal);

		const maxPages = Math.min(Math.max(request.maxPages ?? 4, 1), 8);
		const targets = pickDiverseResults(results, sites, maxPages);
		const pages: ReviewPageSummary[] = [];
		const usages: Array<Usage | undefined> = [];

		for (const target of targets) {
			const site = matchReviewSite(target.url, sites);
			const lang = site?.lang ?? "ja";
			const page: ReviewPageSummary = {
				title: target.title,
				url: target.url,
				site: site?.name ?? hostnameOf(target.url),
				lang,
				kind: site?.kind ?? "community",
				summary: "",
			};
			try {
				const fetched = await this.http.fetchText(target.url, { signal, maxChars: this.getMaxChars() });
				const role = lang === "ja" ? "review" : "translate";
				const summarized = await this.roles.tryRun(ctx, role, {
					system: SUMMARY_SYSTEM_PROMPT,
					prompt: buildPageSummaryPrompt({
						subject: request.subject,
						aspects: request.aspects,
						title: target.title,
						url: target.url,
						text: fetched.text,
						translate: lang !== "ja",
					}),
					signal,
					maxTokens: 1200,
				});
				if (summarized) {
					page.summary = summarized.text;
					page.modelLabel = summarized.modelLabel;
					usages.push(summarized.usage);
				} else {
					// 要約モデルが使えないときは、本文の冒頭をそのまま渡す
					page.summary = truncate(fetched.text, 2000);
				}
			} catch (error) {
				page.error = error instanceof Error ? error.message : String(error);
				page.summary = target.snippet;
			}
			pages.push(page);
		}

		return { subject: request.subject, pages, searchErrors: errors, usage: sumUsage(usages) };
	}
}

/**
 * 同じサイトばかりにならないよう、ドメインごとに1件ずつ拾ってから残りを埋める。
 * 独立性の担保のため、editorial / user-review / community が混ざるようにする。
 */
export function pickDiverseResults(
	results: readonly SearchResult[],
	sites: readonly ReviewSiteConfig[],
	limit: number,
): SearchResult[] {
	const byHost = new Map<string, SearchResult[]>();
	for (const result of results) {
		const host = hostnameOf(result.url);
		if (!host) continue;
		const bucket = byHost.get(host) ?? [];
		bucket.push(result);
		byHost.set(host, bucket);
	}
	const picked: SearchResult[] = [];
	const hosts = [...byHost.keys()];
	let round = 0;
	while (picked.length < limit) {
		let added = false;
		for (const host of hosts) {
			const bucket = byHost.get(host);
			const candidate = bucket?.[round];
			if (!candidate) continue;
			picked.push(candidate);
			added = true;
			if (picked.length >= limit) break;
		}
		if (!added) break;
		round += 1;
	}
	// レビューサイト設定に載っているドメインを優先して並べ替える
	return picked.sort((a, b) => {
		const rank = (result: SearchResult) => (matchReviewSite(result.url, sites) ? 0 : 1);
		return rank(a) - rank(b);
	});
}
