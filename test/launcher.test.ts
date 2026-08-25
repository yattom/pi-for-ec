import { describe, expect, it } from "vitest";
// @ts-expect-error — ランチャーは .mjs（型定義なし）。振る舞いだけをテストする。
import { buildPiArgs, findConciergeModel, resolvePiInvocation } from "../bin/ec-concierge.mjs";

const PI_ROOT = "/usr/lib/node_modules/@earendil-works/pi-coding-agent";

/** pi が入っている想定のファイルシステムを模した exists / readJson。 */
function fakeFs(files: Record<string, unknown>) {
	return {
		exists: (path: string) => Object.hasOwn(files, path),
		readJson: (path: string) => files[path],
	};
}

const piFiles = {
	[`${PI_ROOT}/package.json`]: { bin: { pi: "dist/bundle/cli.js" } },
	[`${PI_ROOT}/dist/bundle/cli.js`]: "",
};

describe("findConciergeModel", () => {
	it("最初に見つかった concierge ロールを使う", () => {
		expect(
			findConciergeModel([
				{ models: { extract: { provider: "lan", model: "q" } } },
				{ models: { concierge: { provider: "anthropic", model: "claude-sonnet-4-5" } } },
			]),
		).toBe("anthropic/claude-sonnet-4-5");
	});

	it("設定が無ければ undefined（pi の既定モデルに任せる）", () => {
		expect(findConciergeModel([])).toBeUndefined();
		expect(findConciergeModel([{ models: {} }])).toBeUndefined();
	});
});

describe("resolvePiInvocation", () => {
	it("PI_BIN が JS なら node で直接起動する", () => {
		expect(resolvePiInvocation({ env: { PI_BIN: "/opt/pi/cli.js" }, platform: "linux" })).toEqual({
			kind: "node",
			entry: "/opt/pi/cli.js",
		});
	});

	it("PI_BIN が .cmd なら Windows では shell 経由にする", () => {
		expect(resolvePiInvocation({ env: { PI_BIN: "C:\\npm\\pi.cmd" }, platform: "win32" })).toEqual({
			kind: "command",
			command: "C:\\npm\\pi.cmd",
			shell: true,
		});
	});

	it("依存として解決できれば bin の JS エントリを使う", () => {
		const fs = fakeFs(piFiles);
		expect(
			resolvePiInvocation({
				env: {},
				platform: "win32",
				exists: fs.exists,
				readJson: fs.readJson,
				resolveModule: () => `${PI_ROOT}/dist/index.js`,
			}),
		).toEqual({ kind: "node", entry: `${PI_ROOT}/dist/bundle/cli.js` });
	});

	it("グローバルインストール（npm root -g）からエントリを見つける", () => {
		const fs = fakeFs(piFiles);
		expect(
			resolvePiInvocation({
				env: {},
				platform: "win32",
				exists: fs.exists,
				readJson: fs.readJson,
				resolveModule: () => {
					throw new Error("not found");
				},
				npmRoot: () => "/usr/lib/node_modules",
			}),
		).toEqual({ kind: "node", entry: `${PI_ROOT}/dist/bundle/cli.js` });
	});

	it("見つからなければ pi コマンドへフォールバックする（Windows は shell 経由）", () => {
		const fs = fakeFs({});
		const common = {
			env: {},
			exists: fs.exists,
			readJson: fs.readJson,
			resolveModule: () => {
				throw new Error("not found");
			},
			npmRoot: () => undefined,
		};
		expect(resolvePiInvocation({ ...common, platform: "win32" })).toEqual({
			kind: "command",
			command: "pi",
			shell: true,
		});
		expect(resolvePiInvocation({ ...common, platform: "linux" })).toEqual({
			kind: "command",
			command: "pi",
			shell: false,
		});
	});
});

describe("buildPiArgs", () => {
	const base = { root: "/pkg", systemPrompt: "行1\n行2", withBuiltinTools: false };

	it("拡張・スキル・システムプロンプトを渡し、組み込みツールを無効にする", () => {
		const args = buildPiArgs({ ...base, model: "anthropic/claude-sonnet-4-5", passthrough: ["椅子がほしい"] });
		expect(args).toEqual([
			"--system-prompt",
			"行1\n行2",
			"--extension",
			"/pkg/extensions/ec-concierge/index.ts",
			"--skill",
			"/pkg/skills/ec-shopping",
			"--no-builtin-tools",
			"--model",
			"anthropic/claude-sonnet-4-5",
			"椅子がほしい",
		]);
	});

	it("--with-builtin-tools 指定時は無効化しない", () => {
		expect(buildPiArgs({ ...base, withBuiltinTools: true })).not.toContain("--no-builtin-tools");
	});

	it("cmd.exe 経由のときは複数行のシステムプロンプトを渡さない", () => {
		const args = buildPiArgs({ ...base, multilineArgs: false });
		expect(args).not.toContain("--system-prompt");
		expect(args).toContain("--extension");
	});

	it("モデル未指定なら --model を付けない（pi の設定に任せる）", () => {
		expect(buildPiArgs(base)).not.toContain("--model");
	});
});
