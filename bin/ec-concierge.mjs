#!/usr/bin/env node
/**
 * ECショッピング・コンシェルジュのランチャー。
 *
 * pi を「買い物コンシェルジュ」として起動する薄いラッパー。
 *   - assets/system-concierge.md をシステムプロンプトとして渡す
 *   - この拡張とスキルを読み込む
 *   - 既定では組み込みツール（bash/edit/write 等）を無効にする（買い物に不要なため）
 *   - 設定ファイルの models.concierge をメインモデルとして --model に渡す
 *
 * 使い方:
 *   node bin/ec-concierge.mjs "在宅勤務用の椅子がほしい"
 *   node bin/ec-concierge.mjs --with-builtin-tools        # bash などを有効にする
 *   node bin/ec-concierge.mjs --model anthropic/claude-sonnet-4-5
 *   PI_BIN=/path/to/pi node bin/ec-concierge.mjs
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/** 設定ファイルから concierge ロールのモデルを探す。 */
export function findConciergeModel(configs) {
	for (const config of configs) {
		const role = config?.models?.concierge;
		if (role?.provider && role?.model) return `${role.provider}/${role.model}`;
	}
	return undefined;
}

function main() {
	const argv = process.argv.slice(2);
	const withBuiltinTools = argv.includes("--with-builtin-tools");
	const passthrough = argv.filter((arg) => arg !== "--with-builtin-tools");
	const hasModelFlag = passthrough.some((arg) => arg === "--model" || arg.startsWith("--model="));

	const configs = [
		readJson(join(homedir(), ".pi", "agent", "ec-concierge.json")),
		readJson(join(process.cwd(), ".pi", "ec-concierge.json")),
		process.env.PI_EC_CONFIG ? readJson(process.env.PI_EC_CONFIG) : undefined,
	].filter(Boolean);

	const systemPrompt = readFileSync(join(packageRoot, "assets", "system-concierge.md"), "utf8");

	const args = [
		"--system-prompt",
		systemPrompt,
		"--extension",
		join(packageRoot, "extensions", "ec-concierge", "index.ts"),
		"--skill",
		join(packageRoot, "skills", "ec-shopping"),
	];

	if (!withBuiltinTools) args.push("--no-builtin-tools");

	const conciergeModel = hasModelFlag ? undefined : findConciergeModel(configs);
	if (conciergeModel) args.push("--model", conciergeModel);

	args.push(...passthrough);

	const child = spawn(process.env.PI_BIN ?? "pi", args, { stdio: "inherit" });
	child.on("error", (error) => {
		if (error.code === "ENOENT") {
			console.error(
				"pi コマンドが見つかりません。`npm install -g --ignore-scripts @earendil-works/pi-coding-agent` でインストールするか、PI_BIN を設定してください。",
			);
			process.exit(127);
		}
		console.error(error);
		process.exit(1);
	});
	child.on("exit", (code, signal) => {
		if (signal) process.kill(process.pid, signal);
		else process.exit(code ?? 0);
	});
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	main();
}
