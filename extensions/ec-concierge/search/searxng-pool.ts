/**
 * 複数の SearXNG インスタンスをローテーションする小さなプール。
 *
 * 公開インスタンス（searx.space に載っているようなもの）は運営者の判断で
 * JSON 出力を無効化していることが多く、1つに固定すると突然使えなくなりがちである。
 * ラウンドロビンで順に試し、失敗したインスタンスは一定時間クールダウンして外す。
 * 全滅していれば、クールダウンの終わりが一番近いものへ最後の望みをかける。
 */

export interface SearxngPoolState {
	/** 次に試す位置（ラウンドロビン用のカーソル） */
	cursor: number;
	/** インスタンスURL → 復帰予定時刻(ms epoch) */
	cooldownUntil: Map<string, number>;
}

export function createSearxngPoolState(): SearxngPoolState {
	return { cursor: 0, cooldownUntil: new Map() };
}

export interface PickResult {
	url: string;
	index: number;
}

/** クールダウン中でない候補からラウンドロビンで1つ選ぶ。全滅なら復帰が一番近いものを選ぶ。 */
export function pickInstance(
	urls: readonly string[],
	state: SearxngPoolState,
	now = Date.now(),
): PickResult | undefined {
	if (urls.length === 0) return undefined;
	const available = urls.map((url, index) => ({ url, index })).filter(({ url }) => (state.cooldownUntil.get(url) ?? 0) <= now);

	if (available.length > 0) {
		const pick = available[state.cursor % available.length]!;
		state.cursor = (state.cursor + 1) % urls.length;
		return pick;
	}

	// 全滅: 復帰が一番近いものにかける（クールダウン自体は解除しない。成否は呼び出し側が反映する）
	let best: { url: string; index: number; until: number } | undefined;
	urls.forEach((url, index) => {
		const until = state.cooldownUntil.get(url) ?? 0;
		if (!best || until < best.until) best = { url, index, until };
	});
	return best;
}

const BASE_COOLDOWN_MS = 5 * 60 * 1000; // 5分
const MAX_COOLDOWN_MS = 30 * 60 * 1000; // 30分

/** 失敗を記録する。連続して失敗しているインスタンスほどクールダウンを倍々に伸ばす。 */
export function markFailure(state: SearxngPoolState, url: string, now = Date.now()): void {
	const previousUntil = state.cooldownUntil.get(url) ?? 0;
	const previousLength = previousUntil > now ? previousUntil - now : 0;
	const nextLength = Math.min(previousLength > 0 ? previousLength * 2 : BASE_COOLDOWN_MS, MAX_COOLDOWN_MS);
	state.cooldownUntil.set(url, now + nextLength);
}

/** 成功したインスタンスのクールダウンを解除する。 */
export function markSuccess(state: SearxngPoolState, url: string): void {
	state.cooldownUntil.delete(url);
}
