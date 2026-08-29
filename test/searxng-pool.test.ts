import { describe, expect, it } from "vitest";
import { createSearxngPoolState, markFailure, markSuccess, pickInstance } from "../extensions/ec-concierge/search/searxng-pool.ts";

const urls = ["https://a.example", "https://b.example", "https://c.example"];

describe("pickInstance", () => {
	it("空リストなら undefined", () => {
		expect(pickInstance([], createSearxngPoolState())).toBeUndefined();
	});

	it("ラウンドロビンで順に回す", () => {
		const state = createSearxngPoolState();
		const picks = [pickInstance(urls, state), pickInstance(urls, state), pickInstance(urls, state), pickInstance(urls, state)];
		expect(picks.map((pick) => pick?.url)).toEqual([urls[0], urls[1], urls[2], urls[0]]);
	});

	it("クールダウン中のインスタンスを飛ばす", () => {
		const state = createSearxngPoolState();
		const now = 1_000_000;
		markFailure(state, urls[1]!, now); // b をクールダウン
		const picks = [
			pickInstance(urls, state, now),
			pickInstance(urls, state, now),
			pickInstance(urls, state, now),
		];
		expect(picks.map((pick) => pick?.url)).toEqual([urls[0], urls[2], urls[0]]);
	});

	it("全滅していれば復帰が一番近いものを返す", () => {
		const state = createSearxngPoolState();
		const now = 1_000_000;
		markFailure(state, urls[0]!, now);
		state.cooldownUntil.set(urls[0]!, now + 10_000);
		state.cooldownUntil.set(urls[1]!, now + 3_000); // 一番早く復帰する
		state.cooldownUntil.set(urls[2]!, now + 20_000);
		expect(pickInstance(urls, state, now)?.url).toBe(urls[1]);
	});
});

describe("markFailure / markSuccess", () => {
	it("失敗するとクールダウンに入る", () => {
		const state = createSearxngPoolState();
		const now = 1_000_000;
		markFailure(state, urls[0]!, now);
		expect(state.cooldownUntil.get(urls[0]!)).toBe(now + 5 * 60 * 1000);
	});

	it("クールダウン中に再度失敗すると残り時間が倍になる（上限あり）", () => {
		const state = createSearxngPoolState();
		let now = 1_000_000;
		markFailure(state, urls[0]!, now); // 5分後に復帰予定
		now += 1000; // まだクールダウン中（残り 299秒）
		markFailure(state, urls[0]!, now);
		// 残り299秒の倍 = 598秒後に復帰
		expect(state.cooldownUntil.get(urls[0]!)).toBe(now + 598 * 1000);

		// 何度も倍にしても 30分を超えない
		for (let i = 0; i < 10; i++) {
			now += 1000;
			markFailure(state, urls[0]!, now);
		}
		expect(state.cooldownUntil.get(urls[0]!)! - now).toBeLessThanOrEqual(30 * 60 * 1000);
	});

	it("クールダウンが明けてから失敗すれば基本の長さに戻る", () => {
		const state = createSearxngPoolState();
		markFailure(state, urls[0]!, 0);
		// 十分に時間が経ってから（クールダウン明け後）また失敗
		markFailure(state, urls[0]!, 1_000_000);
		expect(state.cooldownUntil.get(urls[0]!)).toBe(1_000_000 + 5 * 60 * 1000);
	});

	it("成功するとクールダウンが解除される", () => {
		const state = createSearxngPoolState();
		markFailure(state, urls[0]!, 0);
		markSuccess(state, urls[0]!);
		expect(state.cooldownUntil.has(urls[0]!)).toBe(false);
	});
});
