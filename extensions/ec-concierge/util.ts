/**
 * 汎用ユーティリティ。
 * ここに置く関数は副作用を持たず、単体テストしやすい形にしておく。
 */

/** URL から追跡用に付与されがちなクエリパラメータを取り除く。 */
const TRACKING_PARAM_PREFIXES = ["utm_", "yclid", "gclid", "fbclid", "dclid", "msclkid", "_bdad"];
const TRACKING_PARAM_NAMES = new Set([
	"ref",
	"ref_",
	"tag",
	"linkCode",
	"ascsubtag",
	"psc",
	"trackingId",
	"scid",
	"sc_e",
	"sc_i",
	"rafcid",
	"icm_cid",
]);

export function stripTrackingParams(rawUrl: string): string {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return rawUrl;
	}
	for (const key of [...url.searchParams.keys()]) {
		const lower = key.toLowerCase();
		if (TRACKING_PARAM_NAMES.has(key) || TRACKING_PARAM_PREFIXES.some((p) => lower.startsWith(p))) {
			url.searchParams.delete(key);
		}
	}
	url.hash = "";
	return url.toString();
}

export function hostnameOf(rawUrl: string): string {
	try {
		return new URL(rawUrl).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

/** `domain` が URL のホスト（サブドメイン含む）にマッチするか。 */
export function matchesDomain(rawUrl: string, domain: string): boolean {
	const host = hostnameOf(rawUrl);
	if (!host) return false;
	const target = domain.replace(/^www\./, "").toLowerCase();
	return host === target || host.endsWith(`.${target}`);
}

/** 全角の数字・カンマ・ピリオドを半角に変換する。 */
export function toHalfWidth(input: string): string {
	return input
		.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
		.replace(/，/g, ",")
		.replace(/．/g, ".");
}

/**
 * 日本語の価格表記から数値を取り出す。
 * "¥12,800" / "12,800円" / "12800円(税込)" / "1万2800円" などに対応する。
 *
 * 通貨の目印（円 / yen / ¥）が無い裸の数字は価格とみなさない。
 * 商品名に含まれる型番の数字（"KI-RX50" の 50 など）を価格と誤認しないため。
 */
export function parseJpPrice(input: string | number | null | undefined): number | undefined {
	if (typeof input === "number") return Number.isFinite(input) ? input : undefined;
	if (!input) return undefined;
	const text = toHalfWidth(input);

	const manMatch = text.match(/([0-9][0-9,]*(?:\.[0-9]+)?)\s*万\s*([0-9][0-9,]*)?\s*円?/);
	if (manMatch) {
		const man = Number(manMatch[1]?.replace(/,/g, "") ?? "0");
		const rest = Number(manMatch[2]?.replace(/,/g, "") ?? "0");
		const value = man * 10000 + rest;
		if (Number.isFinite(value) && value > 0) return Math.round(value);
	}

	const match =
		text.match(/([0-9][0-9,]{0,12})\s*(?:円|yen)/i) ?? text.match(/[¥￥]\s*([0-9][0-9,]{0,12})/);
	if (!match?.[1]) return undefined;
	const value = Number(match[1].replace(/,/g, ""));
	return Number.isFinite(value) ? value : undefined;
}

export function formatJpy(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) return "価格不明";
	return `${Math.round(value).toLocaleString("ja-JP")}円`;
}

export function dedupeBy<T>(items: readonly T[], keyFn: (item: T) => string): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const item of items) {
		const key = keyFn(item);
		if (key && seen.has(key)) continue;
		if (key) seen.add(key);
		out.push(item);
	}
	return out;
}

export function truncate(text: string, maxChars: number): string {
	if (maxChars <= 0 || text.length <= maxChars) return text;
	const cut = text.slice(0, maxChars);
	return `${cut}\n…(${text.length - maxChars}文字を省略しました)`;
}

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	yen: "¥",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	middot: "・",
};

export function decodeHtmlEntities(text: string): string {
	return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
		if (body.startsWith("#x") || body.startsWith("#X")) {
			const code = Number.parseInt(body.slice(2), 16);
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
		}
		if (body.startsWith("#")) {
			const code = Number.parseInt(body.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
		}
		return ENTITIES[body.toLowerCase()] ?? whole;
	});
}

/** HTML からタイトルを取り出す（og:title を優先）。 */
export function extractTitle(html: string): string | undefined {
	const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
	if (og?.[1]) return decodeHtmlEntities(og[1]).trim();
	const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	if (title?.[1]) return decodeHtmlEntities(title[1]).replace(/\s+/g, " ").trim();
	return undefined;
}

/** HTML の meta description。 */
export function extractDescription(html: string): string | undefined {
	const patterns = [
		/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i,
		/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
	];
	for (const pattern of patterns) {
		const match = html.match(pattern);
		if (match?.[1]) return decodeHtmlEntities(match[1]).trim();
	}
	return undefined;
}

/**
 * HTML を本文テキストへ落とす簡易コンバータ。
 * 完璧な抽出は狙わず、LLM に渡して読める程度のテキストにすることを目的とする。
 */
export function htmlToText(html: string): string {
	let text = html;
	text = text.replace(/<!--[\s\S]*?-->/g, " ");
	text = text.replace(/<(script|style|noscript|svg|iframe|template)[^>]*>[\s\S]*?<\/\1>/gi, " ");
	text = text.replace(/<(head)[^>]*>[\s\S]*?<\/\1>/gi, " ");
	text = text.replace(/<(br|hr)\s*\/?>/gi, "\n");
	text = text.replace(/<\/(p|div|section|article|li|tr|h[1-6]|table|ul|ol|dl|dd|dt)>/gi, "\n");
	text = text.replace(/<li[^>]*>/gi, "・");
	text = text.replace(/<t[dh][^>]*>/gi, " | ");
	text = text.replace(/<[^>]+>/g, " ");
	text = decodeHtmlEntities(text);
	text = text.replace(/\r\n?/g, "\n");
	text = text.replace(/[ \t ]+/g, " ");
	text = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1]!.length > 0))
		.join("\n");
	return text.replace(/\n{3,}/g, "\n\n").trim();
}

/** ファイル名に使えるタイムスタンプ（ローカル時刻）。 */
export function timestampForFilename(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
		`-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
	);
}

/** ファイル名に使えない文字を落とす。 */
export function slugify(text: string, maxLength = 40): string {
	const cleaned = text
		.replace(/[\\/:*?"<>|\s]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return cleaned.slice(0, maxLength) || "untitled";
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
