/**
 * 時刻まわりの小物（SPEC §2.3 の `lib/time.ts`）。
 * DB は UTC の ISO8601 文字列、表示はアカウントの timezone（SPEC §2.4）。
 */

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

/**
 * クリックの週グリッドの固定起点（SPEC §8.5）。値は SPEC が指定する 1712991600 をそのまま使う。
 * 実際の時刻は 2024-04-13T07:00:00Z（= 2024-04-13 16:00 JST）で、UTC 深夜ちょうどではない。
 * 週の境界がどこであっても「固定起点から7日刻み」という性質は変わらないので値は動かさない。
 */
export const CLICK_FLOOR_SEC = 1_712_991_600;
export const CLICK_FLOOR_MS = CLICK_FLOOR_SEC * 1000;

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** UTC の YYYY-MM-DD。 */
export function utcDate(ms: number | string | Date): string {
  const t = ms instanceof Date ? ms.getTime() : typeof ms === "string" ? Date.parse(ms) : ms;
  return new Date(t).toISOString().slice(0, 10);
}

/** アカウントの timezone での YYYY-MM-DD（フォロワー日次などの「当日」）。 */
export function tzDate(ms: number | string | Date, tz = "Asia/Tokyo"): string {
  const t = ms instanceof Date ? ms.getTime() : typeof ms === "string" ? Date.parse(ms) : ms;
  try {
    // en-CA は YYYY-MM-DD 形式
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(t));
  } catch {
    return utcDate(t);
  }
}

export function unixSec(ms: number): number {
  return Math.floor(ms / 1000);
}

/* ── クリックの週グリッド（SPEC §8.5） ─────────────── */

export type ClickWeek = {
  /** 週の通し番号（CLICK_FLOOR からの 7日刻み） */
  index: number;
  /** 週の始まり（含む）の UNIX 秒 */
  sinceSec: number;
  /** 週の終わり（含む）の UNIX 秒 = sinceSec + 7日 - 1秒 */
  untilSec: number;
  /** 週の名前。week_end の UTC 日付 */
  weekEnd: string;
};

/** その時刻が入る週の通し番号。起点より前なら 0。 */
export function weekIndexOf(ms: number): number {
  if (ms < CLICK_FLOOR_MS) return 0;
  return Math.floor((ms - CLICK_FLOOR_MS) / WEEK_MS);
}

/** 通し番号から週を作る。起点が固定なので、いつ実行しても同じ週になる（二重計上しない）。 */
export function weekAt(index: number): ClickWeek {
  const startMs = CLICK_FLOOR_MS + index * WEEK_MS;
  const endMs = startMs + WEEK_MS - 1000;
  return {
    index,
    sinceSec: unixSec(startMs),
    untilSec: unixSec(endMs),
    weekEnd: utcDate(endMs),
  };
}

/**
 * 取得対象の週を、新しい順に並べて返す（SPEC §8.5）。
 * - 上限は now が入る週
 * - 下限は「いちばん古い投稿の1週間前」が入る週
 */
export function clickWeeks(nowMs: number, oldestPostMs: number | null): ClickWeek[] {
  const last = weekIndexOf(nowMs);
  const floor = oldestPostMs === null ? last : weekIndexOf(oldestPostMs - WEEK_MS);
  const first = Math.max(0, Math.min(floor, last));
  const out: ClickWeek[] = [];
  for (let i = last; i >= first; i--) out.push(weekAt(i));
  return out;
}
