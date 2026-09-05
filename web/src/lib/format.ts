/**
 * 表示用の整形（SPEC §2.3 の `lib/format.ts`）。
 * 時刻はDBがUTC、表示はアカウントの timezone（SPEC §2.4）なので tz を受け取る。
 */

import { zonedTimeToUtcMs } from "@tap/shared";

const DEFAULT_TZ = "Asia/Tokyo";

/** 3桁区切り。1234 → "1,234" */
export function fmtN(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return Math.round(n).toLocaleString("ja-JP");
}

/** 大きい数を短く。999 → "999" / 1234 → "1.2万" は使わず、k / M で揃える */
export function fmtK(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  const v = Math.round(n);
  const abs = Math.abs(v);
  if (abs < 1000) return String(v);
  if (abs < 1_000_000) {
    const k = v / 1000;
    return `${abs < 10_000 ? k.toFixed(1) : Math.round(k)}k`;
  }
  const m = v / 1_000_000;
  return `${abs < 10_000_000 ? m.toFixed(1) : Math.round(m)}M`;
}

/** 比率を百分率に。0.1234 → "12.3%"。分母0は "-" */
export function pct(numerator: number, denominator: number, digits = 1): string {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return "-";
  return `${((numerator / denominator) * 100).toFixed(digits)}%`;
}

function parts(value: string | number | Date, tz: string): Record<string, string> {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return {};
  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: tz,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const out: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** 月/日。"9/5" */
export function md(value: string | number | Date, tz: string = DEFAULT_TZ): string {
  const p = parts(value, tz);
  if (!p.month) return "-";
  return `${p.month}/${p.day}`;
}

/** 月/日 時:分。"9/5 21:00" */
export function mdhm(value: string | number | Date, tz: string = DEFAULT_TZ): string {
  const p = parts(value, tz);
  if (!p.month) return "-";
  return `${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

/** 増減の符号つき。0 は "±0" */
export function signed(n: number): string {
  if (!Number.isFinite(n)) return "-";
  if (n === 0) return "±0";
  return `${n > 0 ? "+" : "−"}${fmtN(Math.abs(n))}`;
}

/* ── 日時入力（SPEC §12.3 の日時変更） ───────────────── */

/**
 * `<input type="datetime-local">` の値（`YYYY-MM-DDTHH:mm`）にする。
 * 端末のタイムゾーンではなく**アカウントの timezone**（SPEC §2.4）で組み立てる。
 */
export function toDateTimeLocal(value: string | number | Date, tz: string = DEFAULT_TZ): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(d)) p[part.type] = part.value;
  // en-CA は 24時制で 00 時を "24" と出す実装があるので丸める
  const hour = String(Number(p.hour ?? "0") % 24).padStart(2, "0");
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}`;
}

/** `datetime-local` の値を、アカウントの timezone の壁時計として読んで UTC の ISO にする。 */
export function fromDateTimeLocal(value: string, tz: string = DEFAULT_TZ): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const ms = zonedTimeToUtcMs(
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    tz,
  );
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * 残り時間を日本語で（SPEC §12.3「`approve_deadline` の残り時間は client で計算」）。
 * 過ぎていたら null。
 */
export function remaining(target: string | number | Date, nowMs: number = Date.now()): string | null {
  const t = target instanceof Date ? target.getTime() : new Date(target).getTime();
  if (!Number.isFinite(t)) return null;
  const diff = t - nowMs;
  if (diff <= 0) return null;
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${Math.max(1, min)}分`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 === 0 ? `${h}時間` : `${h}時間${min % 60}分`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d}日` : `${d}日${h % 24}時間`;
}
