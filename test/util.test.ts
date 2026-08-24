import { describe, expect, it } from "vitest";
import {
	dedupeBy,
	decodeHtmlEntities,
	extractDescription,
	extractTitle,
	formatJpy,
	htmlToText,
	matchesDomain,
	parseJpPrice,
	slugify,
	stripTrackingParams,
	toHalfWidth,
	truncate,
} from "../extensions/ec-concierge/util.ts";

describe("parseJpPrice", () => {
	it("よくある日本語の価格表記を数値にする", () => {
		expect(parseJpPrice("12,800円")).toBe(12800);
		expect(parseJpPrice("¥12,800")).toBe(12800);
		expect(parseJpPrice("価格: 3980円(税込)")).toBe(3980);
		expect(parseJpPrice("１２，８００円")).toBe(12800);
		expect(parseJpPrice(4500)).toBe(4500);
	});

	it("万単位の表記を扱う", () => {
		expect(parseJpPrice("1万2800円")).toBe(12800);
		expect(parseJpPrice("約3万円")).toBe(30000);
	});

	it("価格がなければ undefined", () => {
		expect(parseJpPrice("送料無料")).toBeUndefined();
		expect(parseJpPrice("")).toBeUndefined();
		expect(parseJpPrice(undefined)).toBeUndefined();
	});

	it("型番などの裸の数字を価格と誤認しない", () => {
		expect(parseJpPrice("SHARP KI-RX50 空気清浄機")).toBeUndefined();
		expect(parseJpPrice("2026年モデル")).toBeUndefined();
		// 通貨の目印がある部分だけを拾う
		expect(parseJpPrice("SHARP KI-RX50 最安価格 39,800円")).toBe(39800);
	});
});

describe("formatJpy", () => {
	it("3桁区切りにする", () => {
		expect(formatJpy(12800)).toBe("12,800円");
		expect(formatJpy(undefined)).toBe("価格不明");
	});
});

describe("toHalfWidth", () => {
	it("全角数字を半角にする", () => {
		expect(toHalfWidth("１２３４５")).toBe("12345");
		expect(toHalfWidth("１，０００．５")).toBe("1,000.5");
	});
});

describe("stripTrackingParams", () => {
	it("追跡パラメータとフラグメントを落とす", () => {
		const url = stripTrackingParams("https://example.com/item?id=5&utm_source=x&gclid=y&tag=aff-22#reviews");
		expect(url).toBe("https://example.com/item?id=5");
	});

	it("URLでない文字列はそのまま返す", () => {
		expect(stripTrackingParams("not a url")).toBe("not a url");
	});
});

describe("matchesDomain", () => {
	it("サブドメインも一致とみなす", () => {
		expect(matchesDomain("https://kakaku.com/item/1", "kakaku.com")).toBe(true);
		expect(matchesDomain("https://review.kakaku.com/item/1", "kakaku.com")).toBe(true);
		expect(matchesDomain("https://notkakaku.com/item/1", "kakaku.com")).toBe(false);
	});
});

describe("htmlToText", () => {
	it("スクリプトとタグを除き、ブロック要素で改行する", () => {
		const html = `
			<html><head><title>商品ページ</title><style>.a{color:red}</style></head>
			<body><script>alert(1)</script>
			<h1>すごい椅子</h1><p>価格は <b>39,800</b> 円です。</p>
			<ul><li>高さ調整</li><li>ランバーサポート</li></ul>
			</body></html>`;
		const text = htmlToText(html);
		expect(text).toContain("すごい椅子");
		expect(text).toContain("39,800");
		expect(text).toContain("・高さ調整");
		expect(text).not.toContain("alert(1)");
		expect(text).not.toContain("color:red");
	});

	it("HTMLエンティティを戻す", () => {
		expect(htmlToText("<p>A &amp; B &yen;100</p>")).toBe("A & B ¥100");
	});
});

describe("decodeHtmlEntities", () => {
	it("数値参照を戻す", () => {
		expect(decodeHtmlEntities("&#x3042;&#12356;")).toBe("あい");
	});
});

describe("extractTitle / extractDescription", () => {
	it("og:title を優先する", () => {
		const html = '<meta property="og:title" content="OG タイトル"><title>普通のタイトル</title>';
		expect(extractTitle(html)).toBe("OG タイトル");
	});

	it("title タグにフォールバックする", () => {
		expect(extractTitle("<title>  普通の\nタイトル </title>")).toBe("普通の タイトル");
	});

	it("meta description を読む", () => {
		expect(extractDescription('<meta name="description" content="説明文">')).toBe("説明文");
	});
});

describe("dedupeBy / truncate / slugify", () => {
	it("キーで重複を除く", () => {
		const items = [{ url: "a" }, { url: "b" }, { url: "a" }];
		expect(dedupeBy(items, (item) => item.url)).toHaveLength(2);
	});

	it("長い文字列を切り詰めて省略を伝える", () => {
		const result = truncate("あ".repeat(100), 10);
		expect(result.startsWith("あ".repeat(10))).toBe(true);
		expect(result).toContain("90文字を省略");
	});

	it("ファイル名に使えない文字を落とす", () => {
		expect(slugify("SHARP KI/RX50 空気清浄機")).toBe("SHARP-KI-RX50-空気清浄機");
	});
});
