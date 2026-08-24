/**
 * 用途（ロール）別のモデル振り分け。
 *
 * メインの対話は pi 本体が選んでいるモデル（/model で切り替え）で動く。
 * このモジュールは「ページ抽出」「レビュー要約」「翻訳」「並べ替え」といった
 * 下働きの推論を、設定で指定した別モデル（例: LAN 内の llama.cpp）へ送るためのもの。
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EcConciergeConfig, RoleName } from "./config.ts";
import { ROLE_NAMES } from "./config.ts";

export interface RoleRunOptions {
	system?: string;
	prompt: string;
	maxTokens?: number;
	temperature?: number;
	signal?: AbortSignal;
}

export interface RoleRunResult {
	text: string;
	usage?: Usage;
	/** 実際に使われたモデル（"provider/model"） */
	modelLabel: string;
	/** 設定どおりのモデルが使えず、セッションモデルなどに落ちたか */
	fallbackUsed: boolean;
}

export interface ResolvedRole {
	role: RoleName;
	/** 設定に書かれた第一候補（未設定なら undefined） */
	configured?: string;
	/** 実際に使えるモデル（"provider/model"）。どれも使えなければ undefined */
	effective?: string;
	source: "configured" | "fallback" | "session" | "none";
	note?: string;
}

type ModelHandle = NonNullable<ExtensionContext["model"]>;

function label(model: ModelHandle): string {
	return `${model.provider}/${model.id}`;
}

export class RoleRouter {
	constructor(private readonly getConfig: () => EcConciergeConfig) {}

	/** ロールに対して実際に使うモデルを決める。 */
	resolve(ctx: ExtensionContext, role: RoleName): { model?: ModelHandle; source: ResolvedRole["source"] } {
		const roleConfig = this.getConfig().models[role];
		const candidates = roleConfig ? [{ provider: roleConfig.provider, model: roleConfig.model }, ...(roleConfig.fallback ?? [])] : [];

		for (const [index, candidate] of candidates.entries()) {
			const model = ctx.modelRegistry.find(candidate.provider, candidate.model);
			if (!model) continue;
			if (!ctx.modelRegistry.hasConfiguredAuth(model)) continue;
			return { model, source: index === 0 ? "configured" : "fallback" };
		}

		if (roleConfig?.fallbackToSessionModel === false) return { source: "none" };
		return ctx.model ? { model: ctx.model, source: "session" } : { source: "none" };
	}

	/** /ec-models 表示用に、全ロールの解決結果を返す。 */
	describe(ctx: ExtensionContext): ResolvedRole[] {
		const config = this.getConfig();
		return ROLE_NAMES.map((role) => {
			const roleConfig = config.models[role];
			const configured = roleConfig ? `${roleConfig.provider}/${roleConfig.model}` : undefined;
			const resolved = this.resolve(ctx, role);
			let note: string | undefined;
			if (configured && resolved.source === "session") note = "設定モデルが未認証/未登録のためセッションモデルを使用";
			if (!configured && resolved.source === "session") note = "未設定のためセッションモデルを使用";
			if (resolved.source === "none") note = "利用可能なモデルがありません";
			return {
				role,
				configured,
				effective: resolved.model ? label(resolved.model) : undefined,
				source: resolved.source,
				note,
			};
		});
	}

	/** ロールのモデルで 1 回だけ推論する（ツール呼び出しなしの単発生成）。 */
	async run(ctx: ExtensionContext, role: RoleName, options: RoleRunOptions): Promise<RoleRunResult> {
		const resolved = this.resolve(ctx, role);
		if (!resolved.model) {
			throw new Error(
				`ロール "${role}" に使えるモデルがありません。/ec-models で設定を確認してください。`,
			);
		}
		const roleConfig = this.getConfig().models[role];
		const response = await ctx.modelRegistry.complete(
			resolved.model,
			{
				systemPrompt: options.system,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: options.prompt }],
						timestamp: Date.now(),
					},
				],
			},
			{
				signal: options.signal,
				maxTokens: options.maxTokens ?? roleConfig?.maxTokens,
				temperature: options.temperature ?? roleConfig?.temperature,
			},
		);

		const text = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();

		return {
			text,
			usage: response.usage,
			modelLabel: label(resolved.model),
			fallbackUsed: resolved.source !== "configured",
		};
	}

	/**
	 * ロールのモデルで推論するが、失敗しても例外にせず undefined を返す。
	 * 「要約できたら要約する、無理なら生テキストで進む」という使い方向け。
	 */
	async tryRun(ctx: ExtensionContext, role: RoleName, options: RoleRunOptions): Promise<RoleRunResult | undefined> {
		try {
			const result = await this.run(ctx, role, options);
			return result.text ? result : undefined;
		} catch {
			return undefined;
		}
	}
}

/** 複数の Usage を合算する（ツール結果の usage 報告用）。 */
export function sumUsage(usages: Array<Usage | undefined>): Usage | undefined {
	const present = usages.filter((usage): usage is Usage => Boolean(usage));
	if (present.length === 0) return undefined;
	const total: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const usage of present) {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.totalTokens += usage.totalTokens;
		total.cost.input += usage.cost.input;
		total.cost.output += usage.cost.output;
		total.cost.cacheRead += usage.cost.cacheRead;
		total.cost.cacheWrite += usage.cost.cacheWrite;
		total.cost.total += usage.cost.total;
	}
	return total;
}
