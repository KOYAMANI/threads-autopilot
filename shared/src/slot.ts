/**
 * 枠の選択（SPEC §9.3）。`GET /queue/suggest-slot` と、M6 の `ap_plan` で共用する純関数。
 *
 * M4 の範囲は「実績なし → 既定枠（weekday 21時 / weekend 12時）」まで。
 * 実績（`learning` の `dim='slot'` で `n >= 10`）による並べ替えは M6 で
 * `history` を渡すだけで効くよう、候補の列挙と制約はここに全部入れてある。
 *
 * ランダム探索はしない（SPEC §9.3）。同じ入力からは常に同じ枠が出る。
 */
import { dayTypeOf, slotOf, type DayType } from "./tags";

/** 3時間刻みの枠（SPEC §9.1）。 */
export const SLOT_HOURS = [0, 3, 6, 9, 12, 15, 18, 21] as const;

/** `quiet_hours=1` のとき落とす枠。「0〜6時は出さない」（SPEC §4 / §9.3）。 */
export const QUIET_SLOT_HOURS = [0, 3, 6] as const;

/** 実績なしのときの既定枠（SPEC §9.3）。 */
export const DEFAULT_SLOT: Record<DayType, number> = { weekday: 21, weekend: 12 };

/** ある次元の値を「実績あり」と見なす本数（SPEC §16 用語）。 */
export const MIN_SAMPLES = 10;

/** 候補を出す先の日数（SPEC §9.3「今から7日先まで」）。 */
export const HORIZON_DAYS = 7;

export type SlotCandidate = {
  /** UTC の ISO8601 */
  at: string;
  atMs: number;
  daytype: DayType;
  /** 3時間刻みの「時」 */
  slot: number;
  /** `learning.value` と同じ形（`weekday-21`） */
  value: string;
};

export type SlotHistory = {
  /** `weekday-21` の形 */
  value: string;
  n: number;
  /** `score_sum / n` */
  avgScore: number;
};

export type SuggestSlotInput = {
  nowMs: number;
  tz: string;
  quietHours: boolean;
  slotMode?: "auto" | "fixed";
  fixedHour?: number | null;
  /** 既に埋まっている時刻（予約済みキューの `scheduled_at`）。UTC ISO でも ms でもよい */
  taken?: Array<string | number>;
  /** 1日あたりの上限（`autopilot.daily_limit`） */
  dailyLimit?: number;
  /** 投稿間隔（アカウント設定 `minGapMin`） */
  minGapMin?: number;
  /** `learning` の `dim='slot'`（M6 から渡す。M4 は空） */
  history?: SlotHistory[];
  /** 直近の自動投稿が使った枠（新しい順）。同じ枠を避ける（SPEC §9.3 のローテーション） */
  recentValues?: string[];
};

export type SlotSuggestion = { at: string; reason: string; n: number };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** tz の「時」「分」「年月日」をまとめて取る。 */
function tzFields(ms: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const out = { y: 1970, mo: 1, d: 1, h: 0, mi: 0 };
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type === "year") out.y = Number(p.value);
    if (p.type === "month") out.mo = Number(p.value);
    if (p.type === "day") out.d = Number(p.value);
    if (p.type === "hour") out.h = Number(p.value) % 24;
    if (p.type === "minute") out.mi = Number(p.value);
  }
  return out;
}

/**
 * 「tz でこの年月日時分」を UTC の ms に直す。
 * オフセットは Intl から逆算する（Asia/Tokyo は固定だが、DST のある tz でもずれないよう
 * 1回だけ収束させる）。画面の日時入力（`datetime-local`）の変換にも使う。
 */
export function zonedTimeToUtcMs(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  tz: string,
): number {
  const target = Date.UTC(y, mo - 1, d, h, mi, 0);
  let ms = target;
  for (let i = 0; i < 2; i++) {
    const f = tzFields(ms, tz);
    const seen = Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, 0);
    const offset = seen - ms;
    const next = target - offset;
    if (next === ms) break;
    ms = next;
  }
  return ms;
}

/** 「tz でこの年月日時の0分ちょうど」を UTC の ms に直す（枠は3時間刻みなので分は持たない）。 */
export function zonedHourToUtcMs(
  y: number,
  mo: number,
  d: number,
  h: number,
  tz: string,
): number {
  return zonedTimeToUtcMs(y, mo, d, h, 0, tz);
}

/** tz での「今日」の 00:00 を UTC ms で返す。 */
export function startOfTzDay(ms: number, tz: string): number {
  const f = tzFields(ms, tz);
  return zonedHourToUtcMs(f.y, f.mo, f.d, 0, tz);
}

/**
 * 今から7日先までの候補を、早い順に並べて返す（SPEC §9.3）。
 * `quiet_hours` と `slot_mode='fixed'` はここで効かせる。埋まり具合（`daily_limit` /
 * `minGapMin`）は `filterAvailable()` 側で見る。
 */
export function slotCandidates(input: SuggestSlotInput): SlotCandidate[] {
  const { nowMs, tz } = input;
  const fixed =
    input.slotMode === "fixed" && typeof input.fixedHour === "number"
      ? Math.max(0, Math.min(23, Math.floor(input.fixedHour)))
      : null;
  const hours: number[] =
    fixed === null
      ? SLOT_HOURS.filter((h) => !(input.quietHours && (QUIET_SLOT_HOURS as readonly number[]).includes(h)))
      : [fixed];

  const out: SlotCandidate[] = [];
  const day0 = startOfTzDay(nowMs, tz);
  for (let day = 0; day <= HORIZON_DAYS; day++) {
    // tz の日付を1日ずつ進める（DST で 23h/25h になる日があっても正午基準なら安全）
    const noon = day0 + day * DAY_MS + 12 * HOUR_MS;
    const f = tzFields(noon, tz);
    for (const h of hours) {
      const atMs = zonedHourToUtcMs(f.y, f.mo, f.d, h, tz);
      if (atMs <= nowMs) continue;
      if (atMs > nowMs + HORIZON_DAYS * DAY_MS) continue;
      const daytype = dayTypeOf(new Date(atMs), tz);
      out.push({
        at: new Date(atMs).toISOString(),
        atMs,
        daytype,
        slot: slotOf(new Date(atMs), tz),
        value: `${daytype}-${slotOf(new Date(atMs), tz)}`,
      });
    }
  }
  out.sort((a, b) => a.atMs - b.atMs);
  return out;
}

function toMs(v: string | number): number {
  return typeof v === "number" ? v : Date.parse(v);
}

/**
 * 既に埋まっている枠を落とす（SPEC §9.3）。
 * - 同じ tz 日に `dailyLimit` 件の予約がある日は避ける
 * - `minGapMin` 以内に既存の予約がある枠は避ける
 */
export function filterAvailable(
  candidates: SlotCandidate[],
  input: SuggestSlotInput,
): SlotCandidate[] {
  const takenMs = (input.taken ?? []).map(toMs).filter((n) => Number.isFinite(n));
  const dailyLimit = Math.max(1, input.dailyLimit ?? 1);
  const gapMs = Math.max(0, input.minGapMin ?? 0) * 60_000;

  const perDay = new Map<string, number>();
  for (const t of takenMs) {
    const key = String(startOfTzDay(t, input.tz));
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }

  return candidates.filter((c) => {
    const key = String(startOfTzDay(c.atMs, input.tz));
    if ((perDay.get(key) ?? 0) >= dailyLimit) return false;
    if (gapMs > 0 && takenMs.some((t) => Math.abs(t - c.atMs) < gapMs)) return false;
    return true;
  });
}

/**
 * おすすめ枠を1つ返す（SPEC §9.3 / §7.4）。
 *
 * - 実績あり（`n >= 10`）の枠が1つ以上あれば、平均 score の高い順に見て、
 *   直近3本と同じ枠を避けつつ、いちばん早く空いている枠を選ぶ
 * - 実績が無ければ既定枠（weekday 21時 / weekend 12時）でいちばん早いもの
 * - 候補が全部埋まっていたら、制約（ローテーション）を外して上から選び直す
 */
export function suggestSlot(input: SuggestSlotInput): SlotSuggestion {
  const all = slotCandidates(input);
  const open = filterAvailable(all, input);
  const pool = open.length > 0 ? open : all;

  const proven = (input.history ?? []).filter((h) => h.n >= MIN_SAMPLES);
  const recent = new Set((input.recentValues ?? []).slice(0, 3));

  if (proven.length > 0) {
    const ranked = [...proven].sort((a, b) => b.avgScore - a.avgScore);
    for (const pass of [0, 1]) {
      for (const h of ranked) {
        if (pass === 0 && recent.has(h.value)) continue;
        const hit = pool.find((c) => c.value === h.value);
        if (hit) {
          return {
            at: hit.at,
            reason: `${hit.slot}時台は${h.n}本の平均が上位です`,
            n: h.n,
          };
        }
      }
    }
  }

  const defaults = pool.find((c) => c.slot === DEFAULT_SLOT[c.daytype]);
  const pick = defaults ?? pool[0];
  if (!pick) {
    // 候補が1つも作れないのは fixed_hour が過去しか指さないときだけ。24時間後に倒す
    const at = new Date(input.nowMs + DAY_MS).toISOString();
    return { at, reason: "実績がまだ足りないので既定の枠です", n: 0 };
  }
  return { at: pick.at, reason: "実績がまだ足りないので既定の枠です", n: 0 };
}

/** 毎日の投稿時刻。表示時刻はアカウントの timezone を使う。 */
export const DEFAULT_POSTING_TIMES = ["09:00", "12:00", "18:00"];
export const MAX_POSTING_TIMES = 10;

export function normalizePostingTimes(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_POSTING_TIMES) return null;
  if (value.some((v) => typeof v !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v))) return null;
  const times = value as string[];
  if (new Set(times).size !== times.length) return null;
  return [...times].sort();
}

export function localDateKey(ms: number, tz: string): string {
  const f = tzFields(ms, tz);
  return `${f.y}-${String(f.mo).padStart(2, "0")}-${String(f.d).padStart(2, "0")}`;
}

/** DST の存在しない時刻は生成しない。二重になる時刻は決定的に一つだけ選ぶ。 */
export function postingSlotsForDate(date: string, times: string[], tz: string): Array<{ at: string; time: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  if (new Date(Date.UTC(y, mo - 1, d)).toISOString().slice(0, 10) !== date) return [];
  return times.flatMap((time) => {
    const [h, mi] = time.split(":").map(Number) as [number, number];
    const ms = zonedTimeToUtcMs(y, mo, d, h, mi, tz);
    const seen = tzFields(ms, tz);
    if (seen.y !== y || seen.mo !== mo || seen.d !== d || seen.h !== h || seen.mi !== mi) return [];
    return [{ at: new Date(ms).toISOString(), time }];
  }).sort((a, b) => a.at.localeCompare(b.at));
}

export function upcomingPostingSlots(nowMs: number, times: string[], tz: string, horizonDays = 7): Array<{ at: string; time: string }> {
  const f = tzFields(nowMs, tz);
  const out: Array<{ at: string; time: string }> = [];
  for (let i = 0; i <= horizonDays; i++) {
    const date = new Date(Date.UTC(f.y, f.mo - 1, f.d + i)).toISOString().slice(0, 10);
    out.push(...postingSlotsForDate(date, times, tz).filter((s) => Date.parse(s.at) > nowMs));
  }
  return out;
}
