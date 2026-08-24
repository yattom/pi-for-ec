/** ECサイト横断の商品表現。 */

export interface Product {
	/** "rakuten:item-code" のような一意キー */
	id: string;
	/** 取得元 ("rakuten" / "yahoo" / "web:amazon" など) */
	source: string;
	/** 表示用のソース名 */
	sourceName: string;
	title: string;
	url: string;
	price?: number;
	/** 送料に関する注記（分かる場合） */
	shipping?: string;
	shop?: string;
	reviewAverage?: number;
	reviewCount?: number;
	imageUrl?: string;
	availability?: string;
	/** 検索結果のスニペットなど、補足テキスト */
	snippet?: string;
}

export interface ProductSearchQuery {
	keyword: string;
	minPrice?: number;
	maxPrice?: number;
	/** "price-asc" | "price-desc" | "review" | "relevance" */
	sort?: "price-asc" | "price-desc" | "review" | "relevance";
	limit?: number;
}

export interface ProductSearchOutcome {
	products: Product[];
	errors: Array<{ source: string; message: string }>;
	/** 実際に問い合わせたソース */
	sources: string[];
}
