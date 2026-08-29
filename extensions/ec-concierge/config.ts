/**
 * ECコンシェルジュの設定。
 *
 * 設定は以下の順にマージされる（後ろほど強い）。
 *   1. コード内の既定値 (DEFAULT_CONFIG)
 *   2. ~/.pi/agent/ec-concierge.json      … 個人設定（APIキーなどはここ）
 *   3. <project>/.pi/ec-concierge.json    … プロジェクト設定（trust 済みのときだけ）
 *   4. $PI_EC_CONFIG が指すファイル
 *   5. 環境変数によるロール別モデル上書き (PI_EC_MODEL_<ROLE>)
 *
 * APIキーなどの秘密は "$ENV_VAR" もしくは "!コマンド" 形式で書ける（pi の models.json と同じ流儀）。
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** LLM を使い分ける「用途（ロール）」。 */
export const ROLE_NAMES = ["concierge", "extract", "review", "translate", "rerank"] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

export const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
	concierge: "ユーザーと対話し、全体の進行と最終提案を行うメインモデル",
	extract: "商品ページ・検索結果から仕様や価格を抽出／要約する下働きモデル",
	review: "レビュー記事・口コミを読み込み、良い点・悪い点に整理するモデル",
	translate: "日本語以外の情報源を日本語に要約・翻訳するモデル",
	rerank: "要件と候補を突き合わせてスコアリング・並べ替えするモデル",
};

export interface RoleModelConfig {
	/** pi のプロバイダID（例: "anthropic", "llamacpp", "lan-llama"） */
	provider: string;
	/** モデルID（例: "claude-sonnet-4-5", "qwen3-30b-a3b"） */
	model: string;
	/** 生成上限トークン */
	maxTokens?: number;
	temperature?: number;
	/** 上のモデルが使えないときに順に試す代替モデル */
	fallback?: Array<{ provider: string; model: string }>;
	/** すべて使えないときに、現在のセッションモデルへフォールバックするか（既定 true） */
	fallbackToSessionModel?: boolean;
}

/** pi に登録する追加プロバイダ（llama.cpp / Ollama / vLLM など）。 */
export interface ExtraProviderConfig {
	baseUrl: string;
	api?: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
	apiKey?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
	compat?: Record<string, unknown>;
	models?: Array<{ id: string } & Record<string, unknown>>;
}

export type SearchBackend = "auto" | "brave" | "tavily" | "serper" | "searxng" | "google-cse" | "duckduckgo";

export interface SearchConfig {
	backend: SearchBackend;
	/** 1回の検索で返す最大件数 */
	maxResults: number;
	brave: { endpoint: string; apiKey?: string; country: string; searchLang: string; uiLang: string };
	/**
	 * Tavily。APIキー無しでも「キーレスモード」で動く（レート制限あり）ため、
	 * 何も設定していないときの既定の検索経路になる。
	 */
	tavily: { endpoint: string; apiKey?: string; searchDepth: "basic" | "advanced"; country?: string };
	/** Serper（Google の検索結果を返すAPI）。キー必須。 */
	serper: { endpoint: string; apiKey?: string; gl: string; hl: string };
	searxng: {
		/** 単一インスタンス（後方互換用）。instances と併用すると両方が対象になる。 */
		baseUrl?: string;
		/**
		 * 複数インスタンスをローテーションする場合はこちら。自前で複数運用している場合や、
		 * searx.space の公開インスタンスを何個か試したい場合に使う。各要素は "$ENV" も解決される。
		 * 注意: 公開インスタンスの多くは JSON 出力（format=json）を無効化しており、
		 * その場合は自動でクールダウンし、次のインスタンスへ回る。
		 */
		instances?: string[];
		language: string;
		engines?: string;
	};
	/** Google Programmable Search。2025年に新規受付終了、2027-01-01 に廃止予定。 */
	googleCse: { endpoint: string; apiKey?: string; cx?: string; lr: string; gl: string };
	duckduckgo: { endpoint: string; region: string };
}

export interface EcSiteConfig {
	id: string;
	name: string;
	domain: string;
	/** 検索クエリに足す修飾語（任意） */
	queryHint?: string;
}

export interface ReviewSiteConfig {
	id: string;
	name: string;
	domain: string;
	lang: "ja" | "en" | "other";
	/** 専門メディア / 口コミ / コミュニティ */
	kind: "editorial" | "user-review" | "community";
}

export interface EcConfig {
	rakuten: { enabled: boolean; applicationId?: string; affiliateId?: string; endpoint: string };
	yahoo: { enabled: boolean; appId?: string; endpoint: string };
	/** 公式APIを持たないサイトはWeb検索経由で辿る */
	webSites: EcSiteConfig[];
	/** ec_search の既定の対象 */
	defaultSites: string[];
}

export interface HttpConfig {
	userAgent: string;
	timeoutMs: number;
	/** 1ページあたりに読み込む最大バイト数 */
	maxBytes: number;
	/** 同一ホストへの最小リクエスト間隔 */
	minIntervalMsPerHost: number;
	/** robots.txt を尊重するか */
	respectRobotsTxt: boolean;
	maxRedirects: number;
}

export interface EcConciergeConfig {
	models: Partial<Record<RoleName, RoleModelConfig>>;
	providers: Record<string, ExtraProviderConfig>;
	search: SearchConfig;
	ec: EcConfig;
	reviewSites: ReviewSiteConfig[];
	http: HttpConfig;
	/** 最終提案の Markdown を書き出すディレクトリ（cwd からの相対可） */
	outputDir: string;
	/**
	 * コンシェルジュ用のシステムプロンプトの扱い。
	 *   auto  : --system-prompt などで独自プロンプトが指定されていなければ追記する（既定）
	 *   always: 常に追記する
	 *   off   : 何もしない（ツールだけ使う）
	 */
	persona: "auto" | "always" | "off";
	/** ページ本文がこの文字数を超えたら extract ロールのモデルで要約する */
	summarizeThresholdChars: number;
}

export const DEFAULT_CONFIG: EcConciergeConfig = {
	models: {},
	providers: {},
	search: {
		backend: "auto",
		maxResults: 8,
		brave: {
			endpoint: "https://api.search.brave.com/res/v1/web/search",
			apiKey: "$BRAVE_SEARCH_API_KEY",
			country: "JP",
			searchLang: "jp",
			uiLang: "ja-JP",
		},
		tavily: {
			endpoint: "https://api.tavily.com/search",
			apiKey: "$TAVILY_API_KEY",
			searchDepth: "basic",
		},
		serper: {
			endpoint: "https://google.serper.dev/search",
			apiKey: "$SERPER_API_KEY",
			gl: "jp",
			hl: "ja",
		},
		googleCse: {
			endpoint: "https://www.googleapis.com/customsearch/v1",
			apiKey: "$GOOGLE_CSE_API_KEY",
			cx: "$GOOGLE_CSE_CX",
			lr: "lang_ja",
			gl: "jp",
		},
		searxng: { baseUrl: "$SEARXNG_BASE_URL", instances: [], language: "ja" },
		duckduckgo: { endpoint: "https://html.duckduckgo.com/html/", region: "jp-jp" },
	},
	ec: {
		rakuten: {
			enabled: true,
			applicationId: "$RAKUTEN_APPLICATION_ID",
			affiliateId: "$RAKUTEN_AFFILIATE_ID",
			endpoint: "https://app.rakuten.co.jp/services/api/IchibaItem/Search/20220601",
		},
		yahoo: {
			enabled: true,
			appId: "$YAHOO_APP_ID",
			endpoint: "https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch",
		},
		webSites: [
			{ id: "amazon", name: "Amazon.co.jp", domain: "amazon.co.jp" },
			{ id: "kakaku", name: "価格.com", domain: "kakaku.com" },
			{ id: "yodobashi", name: "ヨドバシ.com", domain: "yodobashi.com" },
			{ id: "biccamera", name: "ビックカメラ", domain: "biccamera.com" },
			{ id: "rakuten-web", name: "楽天市場(Web)", domain: "rakuten.co.jp" },
			{ id: "yahoo-web", name: "Yahoo!ショッピング(Web)", domain: "shopping.yahoo.co.jp" },
			{ id: "mercari", name: "メルカリ", domain: "mercari.com" },
			{ id: "monotaro", name: "モノタロウ", domain: "monotaro.com" },
			{ id: "askul", name: "アスクル/LOHACO", domain: "lohaco.yahoo.co.jp" },
		],
		defaultSites: ["rakuten", "yahoo", "amazon", "kakaku", "yodobashi"],
	},
	reviewSites: [
		{ id: "kakaku-review", name: "価格.com クチコミ・レビュー", domain: "kakaku.com", lang: "ja", kind: "user-review" },
		{ id: "mybest", name: "mybest", domain: "my-best.com", lang: "ja", kind: "editorial" },
		{ id: "the360life", name: "the360.life (テストする女性誌LDK)", domain: "the360.life", lang: "ja", kind: "editorial" },
		{ id: "kakakumag", name: "価格.comマガジン", domain: "kakakumag.com", lang: "ja", kind: "editorial" },
		{ id: "watch-impress", name: "Impress Watch", domain: "watch.impress.co.jp", lang: "ja", kind: "editorial" },
		{ id: "itmedia", name: "ITmedia", domain: "itmedia.co.jp", lang: "ja", kind: "editorial" },
		{ id: "sakidori", name: "SAKIDORI", domain: "sakidori.co", lang: "ja", kind: "editorial" },
		{ id: "note-review", name: "個人ブログ/note", domain: "note.com", lang: "ja", kind: "community" },
		{ id: "rtings", name: "RTINGS.com", domain: "rtings.com", lang: "en", kind: "editorial" },
		{ id: "dpreview", name: "DPReview", domain: "dpreview.com", lang: "en", kind: "editorial" },
		{ id: "wirecutter", name: "NYT Wirecutter", domain: "nytimes.com", lang: "en", kind: "editorial" },
		{ id: "techradar", name: "TechRadar", domain: "techradar.com", lang: "en", kind: "editorial" },
		{ id: "reddit", name: "Reddit", domain: "reddit.com", lang: "en", kind: "community" },
	],
	http: {
		userAgent:
			"pi-ec-concierge/0.1 (+https://github.com/yattom/pi-for-ec) personal shopping assistant; contact via repository",
		timeoutMs: 20000,
		maxBytes: 2_000_000,
		minIntervalMsPerHost: 1200,
		respectRobotsTxt: true,
		maxRedirects: 5,
	},
	outputDir: "output",
	persona: "auto",
	summarizeThresholdChars: 6000,
};

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 配列は「置き換え」、オブジェクトは再帰マージ。 */
export function deepMerge<T>(base: T, override: unknown): T {
	if (override === undefined) return base;
	if (!isPlainObject(base) || !isPlainObject(override)) return override as T;
	const result: Json = { ...base };
	for (const [key, value] of Object.entries(override)) {
		if (value === undefined) continue;
		const current = result[key];
		result[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
	}
	return result as T;
}

export interface LoadedConfigSource {
	path: string;
	ok: boolean;
	error?: string;
}

export interface LoadConfigResult {
	config: EcConciergeConfig;
	sources: LoadedConfigSource[];
}

export function configFileCandidates(options: { cwd: string; projectTrusted: boolean; home?: string }): string[] {
	const home = options.home ?? homedir();
	const paths = [join(home, ".pi", "agent", "ec-concierge.json")];
	if (options.projectTrusted) paths.push(join(options.cwd, ".pi", "ec-concierge.json"));
	const explicit = process.env.PI_EC_CONFIG;
	if (explicit) paths.push(explicit);
	return paths;
}

/** "provider/model" 形式の文字列を RoleModelConfig にする。 */
export function parseModelRef(ref: string): RoleModelConfig | undefined {
	const trimmed = ref.trim();
	if (!trimmed) return undefined;
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

/** PI_EC_MODEL_EXTRACT="llamacpp/qwen3-30b" のような環境変数を取り込む。 */
export function applyEnvModelOverrides(
	config: EcConciergeConfig,
	env: NodeJS.ProcessEnv = process.env,
): EcConciergeConfig {
	const models = { ...config.models };
	for (const role of ROLE_NAMES) {
		const raw = env[`PI_EC_MODEL_${role.toUpperCase()}`];
		if (!raw) continue;
		const parsed = parseModelRef(raw);
		if (!parsed) continue;
		models[role] = { ...models[role], ...parsed };
	}
	return { ...config, models };
}

/** 既定設定の複製を返す。DEFAULT_CONFIG 自体を書き換えないための入口。 */
export function cloneDefaultConfig(): EcConciergeConfig {
	return structuredClone(DEFAULT_CONFIG);
}

export function loadConfig(options: { cwd: string; projectTrusted: boolean; home?: string }): LoadConfigResult {
	let config = cloneDefaultConfig();
	const sources: LoadedConfigSource[] = [];
	for (const path of configFileCandidates(options)) {
		try {
			const raw = readFileSync(path, "utf8");
			config = deepMerge(config, JSON.parse(raw));
			sources.push({ path, ok: true });
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") continue;
			sources.push({ path, ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { config: applyEnvModelOverrides(config), sources };
}

/**
 * 設定値の解決。pi の models.json と同じ記法をサポートする。
 *   "$VAR" / "${VAR}"  … 環境変数
 *   "!command"          … コマンドを実行し標準出力を使う
 *   "$$" / "$!"         … 先頭の $ / ! のエスケープ
 * 解決できない（環境変数が無いなど）ときは undefined を返す。
 */
export async function resolveSecret(
	value: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (trimmed.startsWith("$$")) return `$${trimmed.slice(2)}`;
	if (trimmed.startsWith("$!")) return `!${trimmed.slice(2)}`;
	if (trimmed.startsWith("!")) {
		const command = trimmed.slice(1);
		try {
			const { stdout } = await execFileAsync(command, { shell: true, timeout: 15000 });
			const out = stdout.trim();
			return out.length > 0 ? out : undefined;
		} catch {
			return undefined;
		}
	}
	if (trimmed.includes("$")) {
		let unresolved = false;
		const interpolated = trimmed.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a, b) => {
			const name = (a ?? b) as string;
			const resolved = env[name];
			if (resolved === undefined || resolved === "") {
				unresolved = true;
				return "";
			}
			return resolved;
		});
		return unresolved ? undefined : interpolated;
	}
	return trimmed;
}

/**
 * 設定に書かれたプロバイダ定義を pi の ProviderConfig が要求する形に整える。
 *
 * 1. pi の models.json は省略時の既定値を補ってくれるが、拡張から registerProvider() する場合は
 *    name / reasoning / input / cost / contextWindow / maxTokens が揃っている必要がある。
 *    設定ファイルには `{"id": "qwen3-30b"}` だけ書けるようにしたいので、ここで補完する。
 * 2. registerProvider() の ProviderConfig にはプロバイダ階層の `compat` が無い（models.json にはある）。
 *    プロバイダ階層に書かれた compat は各モデルへ配る。モデル側の指定が優先。
 */
export function normalizeProviderConfig(config: ExtraProviderConfig): ExtraProviderConfig {
	if (!config.models) return config;
	const { compat: providerCompat, ...rest } = config;
	return {
		...rest,
		models: config.models.map((model) => {
			const compat =
				providerCompat || model.compat
					? { ...providerCompat, ...(model.compat as Record<string, unknown> | undefined) }
					: undefined;
			return {
				name: model.id,
				reasoning: false,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 16384,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				...model,
				...(compat ? { compat } : {}),
			};
		}),
	};
}

/** 表示用に秘密情報を伏せる。 */
export function maskSecret(value: string | undefined): string {
	if (!value) return "(未設定)";
	if (value.startsWith("$") || value.startsWith("!")) return value; // 参照式はそのまま見せてよい
	if (value.length <= 8) return "****";
	return `${value.slice(0, 4)}…${value.slice(-2)}`;
}
