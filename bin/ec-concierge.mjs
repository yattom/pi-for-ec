#!/usr/bin/env node
/**
 * ECショッピング・コンシェルジュのランチャー。
 *
 * pi を「買い物コンシェルジュ」として起動する薄いラッパー。
 *   - assets/system-concierge.md をシステムプロンプトとして渡す
 *   - この拡張とスキルを読み込む
 *   - 既定では組み込みツール（bash/edit/write 等）を無効にする（買い物に不要なため）
 *   - 設定ファイルの models.concierge をメインモデルとして --model に渡す
 *   - PI_EC_ACTIVATE=1 を設定して起動する。拡張は既定で非活性（activation: "manual"）
 *     なので、このランチャーを介さず素の `pi` を起動した場合は買い物モードにならない。
 *
 * 使い方:
 *   node bin/ec-concierge.mjs "在宅勤務用の椅子がほしい"
 *   node bin/ec-concierge.mjs --with-builtin-tools        # bash などを有効にする
 *   node bin/ec-concierge.mjs --model anthropic/claude-sonnet-4-5
 *   PI_BIN=/path/to/pi node bin/ec-concierge.mjs
 *
 * Windows について:
 *   npm が置く `pi` は `pi.cmd` というシムなので、Node からは shell 経由でしか起動できず、
 *   その場合 cmd.exe が複数行の引数（システムプロンプト）を扱えない。
 *   そこで pi の JS エントリ（dist/bundle/cli.js）を探し、`node <entry>` として起動する。
 *   見つからないときだけ `pi` コマンドへフォールバックし、その際はシステムプロンプトを
 *   コマンドラインで渡さず、拡張側のプロンプト追記（persona）に任せる。
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PI_PACKAGE = "@earendil-works/pi-coding-agent";

export function readJson(path, read = readFileSync) {
	try {
		return JSON.parse(read(path, "utf8"));
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

/** パッケージ内のファイルパスから、その package.json がある位置まで遡る。 */
function packageRootOf(filePath, exists) {
	let dir = dirname(filePath);
	for (let depth = 0; depth < 10; depth++) {
		if (exists(join(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

/** パッケージルートから bin.pi のパスを取り出す。 */
function binEntryOf(root, deps) {
	const manifest = deps.readJson(join(root, "package.json"));
	const bin = typeof manifest?.bin === "string" ? manifest.bin : manifest?.bin?.pi;
	if (!bin) return undefined;
	const entry = join(root, bin);
	return deps.exists(entry) ? entry : undefined;
}

/**
 * pi の起動方法を決める。
 *
 * 戻り値:
 *   { kind: "node", entry }             … `node <entry>` で起動する（引数をそのまま渡せる）
 *   { kind: "command", command, shell } … `pi` コマンドで起動する（Windows では shell 経由）
 */
export function resolvePiInvocation(options = {}) {
	const {
		env = process.env,
		platform = process.platform,
		exists = existsSync,
		resolveModule,
		npmRoot,
		readJson: readJsonFile = (path) => readJson(path),
	} = options;
	const deps = { exists, readJson: readJsonFile };
	const isWindows = platform === "win32";

	// 1. PI_BIN の明示指定を最優先する
	const explicit = env.PI_BIN;
	if (explicit) {
		if (/\.[cm]?js$/.test(explicit)) return { kind: "node", entry: explicit };
		return { kind: "command", command: explicit, shell: isWindows && /\.(cmd|bat)$/i.test(explicit) };
	}

	// 2. 依存として解決できる場合（このパッケージと同じ node_modules に居る場合）
	try {
		const resolved = resolveModule?.(PI_PACKAGE);
		const root = resolved ? packageRootOf(resolved, exists) : undefined;
		const entry = root ? binEntryOf(root, deps) : undefined;
		if (entry) return { kind: "node", entry };
	} catch {
		// 解決できないのは普通のこと（グローバルインストール）。次の手段へ。
	}

	// 3. グローバルインストール（npm root -g）
	try {
		const root = npmRoot?.();
		const entry = root ? binEntryOf(join(root, ...PI_PACKAGE.split("/")), deps) : undefined;
		if (entry) return { kind: "node", entry };
	} catch {
		// npm が無い環境もある。最後の手段へ。
	}

	// 4. PATH 上の pi コマンド（Windows は pi.cmd なので shell 経由が必要）
	return { kind: "command", command: "pi", shell: isWindows };
}

/**
 * pi に渡す引数を組み立てる。
 *
 * `multilineArgs: false`（cmd.exe 経由の起動）のときは、複数行のシステムプロンプトを
 * コマンドラインに載せられないので省略する。その場合は拡張側の persona 追記が働く。
 */
export function buildPiArgs(options) {
	const { root, systemPrompt, withBuiltinTools, model, passthrough = [], multilineArgs = true } = options;
	const args = [];
	if (multilineArgs && systemPrompt) args.push("--system-prompt", systemPrompt);
	args.push("--extension", join(root, "extensions", "ec-concierge", "index.ts"));
	args.push("--skill", join(root, "skills", "ec-shopping"));
	if (!withBuiltinTools) args.push("--no-builtin-tools");
	if (model) args.push("--model", model);
	args.push(...passthrough);
	return args;
}

function npmRootGlobal() {
	const output = execFileSync("npm", ["root", "-g"], {
		encoding: "utf8",
		shell: process.platform === "win32",
		stdio: ["ignore", "pipe", "ignore"],
	});
	return output.trim() || undefined;
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

	const require = createRequire(import.meta.url);
	const invocation = resolvePiInvocation({
		resolveModule: (id) => require.resolve(id),
		npmRoot: npmRootGlobal,
	});

	const multilineArgs = invocation.kind === "node" || !invocation.shell;
	if (!multilineArgs) {
		console.error(
			"[ec-concierge] pi の JS エントリが見つからないため pi コマンド経由で起動します。\n" +
				"[ec-concierge] システムプロンプトはコマンドラインで渡さず、拡張側で追記します（動作に支障はありません）。",
		);
	}

	const args = buildPiArgs({
		root: packageRoot,
		systemPrompt: readFileSync(join(packageRoot, "assets", "system-concierge.md"), "utf8"),
		withBuiltinTools,
		model: hasModelFlag ? undefined : findConciergeModel(configs),
		passthrough,
		multilineArgs,
	});

	// この拡張は既定で非活性（activation: "manual"）。ランチャー経由の起動は
	// 明示的な「買い物モードで使う」という意思表示なので、ここで強制的に有効化する。
	const spawnEnv = { ...process.env, PI_EC_ACTIVATE: "1" };
	const child =
		invocation.kind === "node"
			? spawn(process.execPath, [invocation.entry, ...args], { stdio: "inherit", env: spawnEnv })
			: spawn(invocation.command, args, { stdio: "inherit", shell: invocation.shell, env: spawnEnv });

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
		if (signal && process.platform !== "win32") process.kill(process.pid, signal);
		else process.exit(code ?? 0);
	});
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	main();
}
