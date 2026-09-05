/**
 * 表示用の整形（SPEC §2.3 の `lib/format.ts`）。
 * 時刻はDBがUTC、表示はアカウントの timezone（SPEC §2.4）なので tz を受け取る。
 */

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
