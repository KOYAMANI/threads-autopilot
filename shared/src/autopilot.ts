/**
 * オートパイロットの計算（SPEC §9.2 / §9.3 / §9.4）。web と worker の両方から使う純関数。
 *
 * 採点も集計も枠と型の選択も、すべてここの決定的な計算で行う。**AI は使わない**
 * （SPEC §10 冒頭）。同じ入力からは常に同じ結果が出る。
 */
import type { HookType } from "./tags";

/* ── 分布と順位（SPEC §9.2） ─────────────────────────── */

/** ある次元の値を「実績あり」と見なす本数（SPEC §16 用語）。`slot.ts` と同じ値。 */
export const MIN_SAMPLES_LEARNING = 10;

/** 採点に使う分布の母数の下限（SPEC §9.2「10本未満のときは採点を見送る」）。 */
export const MIN_DISTRIBUTION = 10;

/** 分布を作る期間（SPEC §9.2「直近180日」）。 */
export const DISTRIBUTION_DAYS = 180;

/** 採点の対象になるまでの経過時間（SPEC §9.2）。 */
export const SCORE_AFTER_HOURS = 48;

/**
 * 昇順のソート済み配列の中での順位を 0..1 で返す（SPEC §9.2）。
 * 二分探索の上界（`v` 以下が何個あるか）÷ 全体。投稿ごとに SQL を投げないための形。
 */
export function percentile(sortedAsc: number[], v: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedAsc[mid]! <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo / n;
}

/* ── 採点（SPEC §9.2） ───────────────────────────────── */

export type ScoreWeightsName = "balanced" | "followers" | "clicks";

export type ScoreWeights = { views: number; likes: number; carry: number; ctr: number };

/** SPEC §9.2 の重み表。 */
export const SCORE_WEIGHTS: Record<ScoreWeightsName, ScoreWeights> = {
  balanced: { views: 0.5, likes: 0.2, carry: 0.2, ctr: 0.1 },
  followers: { views: 0.4, likes: 0.3, carry: 0.3, ctr: 0 },
  clicks: { views: 0.3, likes: 0.1, carry: 0.2, ctr: 0.4 },
};

export function scoreWeightsOf(name: string | null | undefined): ScoreWeights {
  return SCORE_WEIGHTS[(name ?? "balanced") as ScoreWeightsName] ?? SCORE_WEIGHTS.balanced;
}

export type ScoreInput = {
  /** 48h チェックポイントの views */
  views: number;
  /** 48h チェックポイントの likes */
  likes: number;
  /** children[0].views（現在値。SPEC §9.2「比率なので断面のずれの影響が小さい」） */
  firstChildViews: number | null;
  /** 按分後のクリック（現在値）。リンクを持たない投稿は null */
  clicks: number | null;
  /** 直近180日の 48h views を昇順に並べたもの */
  viewsDist: number[];
  /** 直近180日の 48h の likes/views を昇順に並べたもの（views=0 は除外済み） */
  likeRateDist: number[];
  weights: ScoreWeights;
};

export type ScoreResult = {
  score: number;
  pv: number;
  pl: number | null;
  carry: number | null;
  ctr: number | null;
};

/**
 * 1投稿を採点する（SPEC §9.2）。
 * `null` の項は分子からも分母（重みの合計）からも外す。
 */
export function scorePost(input: ScoreInput): ScoreResult {
  const V = input.views;
  const pv = percentile(input.viewsDist, V);
  const pl = V > 0 ? percentile(input.likeRateDist, input.likes / V) : null;
  const carry =
    input.firstChildViews !== null && V > 0 ? Math.min(1, input.firstChildViews / V) : null;
  const ctr = input.clicks !== null && V > 0 ? Math.min(1, input.clicks / V) : null;

  const terms: Array<[number, number | null]> = [
    [input.weights.views, pv],
    [input.weights.likes, pl],
    [input.weights.carry, carry],
    [input.weights.ctr, ctr],
  ];
  let num = 0;
  let den = 0;
  for (const [w, v] of terms) {
    if (v === null || w === 0) continue;
    num += w * v;
    den += w;
  }
  return { score: den === 0 ? 0 : num / den, pv, pl, carry, ctr };
}

/* ── 型の選択（SPEC §9.4-3） ─────────────────────────── */

/** `n >= 10` の型が1つも無いときのローテーション順（SPEC §9.4-3）。 */
export const DEFAULT_HOOK_ORDER: HookType[] = [
  "呼びかけ型",
  "警告型",
  "意外性型",
  "数字型",
  "体験談型",
  "疑問型",
  "断定型",
];

export type HookHistory = { value: string; n: number; avgScore: number };

export type PickHookInput = {
  /** `learning` の `dim='hook'` */
  history?: HookHistory[];
  /** 直近の自動投稿が使った型（新しい順）。同じ型を避ける */
  recentHooks?: string[];
  mode?: "auto" | "fixed";
  fixedHook?: string | null;
};

/**
 * 次に使う型を1つ決める（SPEC §9.4-3）。
 * - `hook_mode='fixed'` … `fixed_hook` に固定
 * - `n >= 10` の型があれば、平均 score の高い順に、直近3本と同じ型を避けて選ぶ
 * - 1つも無ければ既定順のローテーション（直近3本に無いものを上から）
 */
export function pickHook(input: PickHookInput): { hook: string; n: number; proven: boolean } {
  if (input.mode === "fixed" && input.fixedHook && input.fixedHook.trim() !== "") {
    return { hook: input.fixedHook, n: 0, proven: false };
  }
  const recent = new Set((input.recentHooks ?? []).slice(0, 3));
  const proven = (input.history ?? [])
    .filter((h) => h.n >= MIN_SAMPLES_LEARNING)
    .sort((a, b) => b.avgScore - a.avgScore || a.value.localeCompare(b.value));

  if (proven.length > 0) {
    const fresh = proven.find((h) => !recent.has(h.value));
    const pick = fresh ?? proven[0]!;
    return { hook: pick.value, n: pick.n, proven: true };
  }

  const fresh = DEFAULT_HOOK_ORDER.find((h) => !recent.has(h));
  return { hook: fresh ?? DEFAULT_HOOK_ORDER[0]!, n: 0, proven: false };
}

/* ── 必要本数の日割り（SPEC §9.4-2） ─────────────────── */

/**
 * 週 `perWeek` 本を7日に割り、`dowIndex` の日の本数を返す（SPEC §9.4-2）。
 * 余りは週の前半に寄せる。`dowIndex` は月曜=0 … 日曜=6。
 *
 * 例: `perWeek=3` → 月火水が1本ずつ、木〜日は0本。`perWeek=14` → 毎日2本。
 */
export function postsForDay(perWeek: number, dowIndex: number): number {
  const total = Math.max(0, Math.floor(perWeek));
  const base = Math.floor(total / 7);
  const rem = total % 7;
  const d = ((Math.floor(dowIndex) % 7) + 7) % 7;
  return base + (d < rem ? 1 : 0);
}

/** 月曜=0 … 日曜=6。`Date.getUTCDay()`（日曜=0）からの変換にも使う。 */
export function mondayIndex(sundayBasedDay: number): number {
  return (sundayBasedDay + 6) % 7;
}

/* ── 学習の集計を画面向けに整える（SPEC §7.7） ───────── */

export type LearningAggregate = {
  dim: "hook" | "slot" | "length" | "source";
  value: string;
  n: number;
  /** `n < 10` のときは null（画面は数値を出さない。SPEC §7.7 / §12.3） */
  avgScore: number | null;
  avgViews: number | null;
  likeRate: number | null;
};

export type LearningRaw = {
  dim: string;
  value: string;
  n: number;
  scoreSum: number;
  viewsSum: number;
  likeRateSum: number;
};

/**
 * `learning` の素の集計を `GET /autopilot/learning` の形にする（SPEC §7.7）。
 * `n < 10` の行は3つとも `null`。倍率・事前分布・おすすめは出さない（SPEC §9.2 末尾）。
 */
export function toLearningAggregate(row: LearningRaw): LearningAggregate {
  const enough = row.n >= MIN_SAMPLES_LEARNING;
  return {
    dim: row.dim as LearningAggregate["dim"],
    value: row.value,
    n: row.n,
    avgScore: enough && row.n > 0 ? row.scoreSum / row.n : null,
    avgViews: enough && row.n > 0 ? row.viewsSum / row.n : null,
    likeRate: enough && row.n > 0 ? row.likeRateSum / row.n : null,
  };
}
