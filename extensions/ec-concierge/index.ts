/**
 * pi 拡張「ECショッピング・コンシェルジュ」。
 *
 * - ツール: ask_user / web_search / web_fetch / ec_search / review_research /
 *           requirements / candidates / rank_candidates / recommend
 * - コマンド: /ec-models /ec-config /ec-status /ec-reload
 *
 * 設計メモ:
 *  - Web検索とページ取得は pi 実行マシンから発行する（LLM 側の検索機能は使わない）。
 *  - 下働きの推論（抽出・要約・翻訳・採点）は用途別に別モデルへ振り分けられる。
 *    設定は ~/.pi/agent/ec-concierge.json の models セクション。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import {
	ROLE_DESCRIPTIONS,
	ROLE_NAMES,
	type RoleName,
	maskSecret,
	normalizeProviderConfig,
	parseModelRef,
} from "./config.ts";
import { Services } from "./services.ts";
import { emptyState } from "./state.ts";
import { createAskUserTool } from "./tools/ask-user.ts";
import { createEcSearchTool } from "./tools/ec-search.ts";
import { createRankTool } from "./tools/rank.ts";
import { createRecommendTool } from "./tools/recommend.ts";
import { createReviewResearchTool } from "./tools/review-research.ts";
import { createCandidatesTool, createRequirementsTool } from "./tools/state-tools.ts";
import { createWebFetchTool, createWebSearchTool } from "./tools/web.ts";
import { formatCandidates, formatRequirements } from "./state.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** コンシェルジュのシステムプロンプト（assets/system-concierge.md）。 */
export function loadPersonaPrompt(): string {
	try {
		return readFileSync(join(HERE, "..", "..", "assets", "system-concierge.md"), "utf8").trim();
	} catch {
		return "あなたは日本のECサイトでの買い物を支援するコンシェルジュです。要件を対話で確かめ、ECサイトと独立したレビューを調べ、根拠と購入リンク付きでおすすめを提示してください。";
	}
}

export default function ecConcierge(pi: ExtensionAPI) {
	const services = new Services();
	let personaPrompt: string | undefined;

	/** プロバイダ登録に失敗した理由（/ec-config で表示する） */
	const providerErrors: Array<{ name: string; message: string }> = [];

	/** 設定を読み直し、追加プロバイダ（llama.cpp など）を登録する。 */
	const reload = (ctx: { cwd: string; isProjectTrusted(): boolean }) => {
		services.reloadConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
		providerErrors.length = 0;
		for (const [name, provider] of Object.entries(services.getConfig().providers)) {
			try {
				pi.registerProvider(name, normalizeProviderConfig(provider) as ProviderConfig);
			} catch (error) {
				providerErrors.push({ name, message: error instanceof Error ? error.message : String(error) });
			}
		}
	};

	// 起動直後（プロジェクト trust 前）はグローバル設定だけ読む。
	// プロバイダ登録をここで済ませておくと `pi --list-models` にも出る。
	reload({ cwd: process.cwd(), isProjectTrusted: () => false });

	// ---------------------------------------------------------------- ツール
	pi.registerTool(createAskUserTool());
	pi.registerTool(createWebSearchTool(services));
	pi.registerTool(createWebFetchTool(services));
	pi.registerTool(createEcSearchTool(services));
	pi.registerTool(createReviewResearchTool(services));
	pi.registerTool(createRequirementsTool(services));
	pi.registerTool(createCandidatesTool(services));
	pi.registerTool(createRankTool(services));
	pi.registerTool(createRecommendTool(services));

	// ------------------------------------------------------------ ライフサイクル
	pi.on("session_start", async (_event, ctx) => {
		reload(ctx);
		restoreState(services, ctx);
		updateStatus(services, ctx);
	});

	pi.on("before_agent_start", async (event) => {
		const persona = services.getConfig().persona;
		if (persona === "off") return;
		if (persona === "auto" && event.systemPromptOptions?.customPrompt) return;
		personaPrompt ??= loadPersonaPrompt();
		if (event.systemPrompt.includes("ショッピング・コンシェルジュ")) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${personaPrompt}` };
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("ec-concierge", undefined);
	});

	// -------------------------------------------------------------- コマンド
	pi.registerCommand("ec-models", {
		description: "用途（ロール）別のモデル割り当てを表示・変更する",
		handler: async (args, ctx) => {
			const [roleArg, refArg] = args.trim().split(/\s+/).filter(Boolean);
			if (roleArg && refArg) {
				if (!(ROLE_NAMES as readonly string[]).includes(roleArg)) {
					ctx.ui.notify(`未知のロールです: ${roleArg}（${ROLE_NAMES.join(", ")}）`, "error");
					return;
				}
				const parsed = parseModelRef(refArg);
				if (!parsed) {
					ctx.ui.notify('モデルは "provider/model" 形式で指定してください（例: llamacpp/qwen3-30b）', "error");
					return;
				}
				const config = services.getConfig();
				config.models[roleArg as RoleName] = { ...config.models[roleArg as RoleName], ...parsed };
				ctx.ui.notify(`${roleArg} → ${refArg}（このセッションのみ。永続化は ec-concierge.json へ）`, "info");
				updateStatus(services, ctx);
				return;
			}

			const rows = services.roles.describe(ctx).map((resolved) => {
				const configured = resolved.configured ?? "(未設定)";
				const effective = resolved.effective ?? "(利用不可)";
				const note = resolved.note ? `  ※${resolved.note}` : "";
				return `- ${resolved.role.padEnd(9)} 設定: ${configured}\n    実際: ${effective}${note}\n    用途: ${ROLE_DESCRIPTIONS[resolved.role]}`;
			});
			ctx.ui.notify(
				[
					"用途別モデル割り当て",
					...rows,
					"",
					"変更: /ec-models <role> <provider/model>（このセッションのみ）",
					"永続化: ~/.pi/agent/ec-concierge.json の models セクション",
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("ec-config", {
		description: "ECコンシェルジュの設定（検索バックエンド・EC API・読み込んだ設定ファイル）を表示する",
		handler: async (_args, ctx) => {
			const config = services.getConfig();
			const availability = await services.search.availability();
			const sources = services.sources.length
				? services.sources.map((source) => `- ${source.path}${source.ok ? "" : ` (エラー: ${source.error})`}`)
				: ["- (設定ファイルなし。既定値で動作中)"];
			ctx.ui.notify(
				[
					"■ 読み込んだ設定ファイル",
					...sources,
					"",
					"■ Web検索（実行マシンから発行）",
					`- 設定: ${config.search.backend}`,
					...Object.entries(availability).map(([id, ok]) => `- ${id}: ${ok ? "利用可" : "資格情報なし"}`),
					"",
					"■ ECサイト",
					`- 楽天API: ${config.ec.rakuten.enabled ? maskSecret(config.ec.rakuten.applicationId) : "無効"}`,
					`- Yahoo!API: ${config.ec.yahoo.enabled ? maskSecret(config.ec.yahoo.appId) : "無効"}`,
					`- Web検索経由: ${config.ec.webSites.map((site) => site.id).join(", ")}`,
					`- 既定の対象: ${config.ec.defaultSites.join(", ")}`,
					"",
					"■ その他",
					`- レビューサイト: ${config.reviewSites.length}件`,
					`- 追加プロバイダ: ${Object.keys(config.providers).join(", ") || "(なし)"}`,
					...providerErrors.map((error) => `  ! ${error.name} の登録に失敗: ${error.message}`),
					`- 出力先: ${config.outputDir}`,
					`- robots.txt 尊重: ${config.http.respectRobotsTxt ? "する" : "しない"}`,
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("ec-status", {
		description: "現在の要件メモと候補リストを表示する",
		handler: async (_args, ctx) => {
			const state = services.getState();
			ctx.ui.notify(
				["■ 要件", formatRequirements(state.requirements), "", "■ 候補", formatCandidates(state.candidates)].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("ec-reload", {
		description: "ECコンシェルジュの設定ファイルを再読み込みする",
		handler: async (_args, ctx) => {
			reload(ctx);
			updateStatus(services, ctx);
			ctx.ui.notify("ec-concierge の設定を再読み込みしました", "info");
		},
	});
}

/** フッターに現在のロール割り当てを出す。 */
function updateStatus(services: Services, ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	const resolved = services.roles.describe(ctx);
	const extract = resolved.find((entry) => entry.role === "extract")?.effective ?? "-";
	const review = resolved.find((entry) => entry.role === "review")?.effective ?? "-";
	ctx.ui.setStatus("ec-concierge", `EC: 抽出=${shorten(extract)} レビュー=${shorten(review)}`);
}

function shorten(label: string): string {
	const [, model] = label.split("/");
	return (model ?? label).slice(0, 20);
}

/**
 * ツール結果の details に残したスナップショットから状態を復元する。
 * 現在のブランチだけを見るので、/fork や /tree の分岐にも追従する。
 */
function restoreState(services: Services, ctx: ExtensionContext): void {
	let restored = emptyState();
	let found = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; toolName?: string; details?: { state?: unknown } };
		if (message.role !== "toolResult") continue;
		const state = message.details?.state;
		if (state && typeof state === "object" && "requirements" in state && "candidates" in state) {
			restored = state as typeof restored;
			found = true;
		}
	}
	if (found) services.setState(restored);
}
