/**
 * 拡張全体で共有するサービス群。
 * 設定の再読み込み（/ec-reload）で HTTP クライアントごと作り直せるようにまとめてある。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	cloneDefaultConfig,
	type EcConciergeConfig,
	type LoadedConfigSource,
	loadConfig,
	resolveSecret,
} from "./config.ts";
import { EcSearchService } from "./ec/index.ts";
import { HttpClient } from "./http.ts";
import { ReviewResearcher } from "./reviews.ts";
import { RoleRouter } from "./roles.ts";
import { WebSearch } from "./search/index.ts";
import { type ConciergeState, emptyState } from "./state.ts";

export class Services {
	private config: EcConciergeConfig = cloneDefaultConfig();
	private state: ConciergeState = emptyState();
	sources: LoadedConfigSource[] = [];

	http!: HttpClient;
	search!: WebSearch;
	ec!: EcSearchService;
	reviews!: ReviewResearcher;
	readonly roles = new RoleRouter(() => this.config);

	constructor() {
		this.build();
	}

	/** 現在の設定から各サービスを組み立てる。 */
	private build(): void {
		this.http = new HttpClient(this.config.http);
		this.search = new WebSearch(
			this.http,
			() => this.config.search,
			(value) => resolveSecret(value),
		);
		this.ec = new EcSearchService(
			this.http,
			this.search,
			() => this.config.ec,
			(value) => resolveSecret(value),
		);
		this.reviews = new ReviewResearcher(
			this.http,
			this.search,
			this.roles,
			() => this.config.reviewSites,
			// 1トークン≒4文字として、要約しきい値の数倍までは読み込む
			() => this.config.summarizeThresholdChars * 4,
		);
	}

	/** 設定ファイルを読み直す。 */
	reloadConfig(options: { cwd: string; projectTrusted: boolean }): void {
		const loaded = loadConfig(options);
		this.config = loaded.config;
		this.sources = loaded.sources;
		this.build();
	}

	getConfig(): EcConciergeConfig {
		return this.config;
	}

	getState(): ConciergeState {
		return this.state;
	}

	setState(next: ConciergeState): void {
		this.state = next;
	}

	resolve(value: string | undefined): Promise<string | undefined> {
		return resolveSecret(value);
	}

	/** ツール実行時のシグナル（中断対応）。 */
	signalOf(ctx: ExtensionContext, toolSignal?: AbortSignal): AbortSignal | undefined {
		return toolSignal ?? ctx.signal;
	}
}
