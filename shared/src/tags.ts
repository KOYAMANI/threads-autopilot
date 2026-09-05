/**
 * 投稿のタグ付け（SPEC §9.1）。web と worker の両方から使う純関数。
 * 集計・採点・選択は全てここの決定的な計算で行い、AI は使わない（SPEC §10 冒頭）。
 */

export type HookType =
  | "意外性型"
  | "警告型"
  | "疑問型"
  | "呼びかけ型"
  | "数字型"
  | "体験談型"
  | "断定型"
  | "その他";

export type LengthBucket = "<100" | "100-200" | "200-300" | "300+";
export type DayType = "weekday" | "weekend";

/** SPEC §9.1 の順序付きルール。最初に当たったものを採用する。 */
const HOOK_RULES: Array<{ type: HookType; re: RegExp }> = [
  { type: "意外性型", re: /実は|本当は|誰も|知らない|バレ|裏側|知ってました/ },
  {
    type: "警告型",
    re: /危険|注意|NG|ダメ|やめて|やめた方|禁止|逆効果|間違い|失敗|しないで|ないと|損/,
  },
  { type: "疑問型", re: /[?？]\s*$|ますか|ですか|でしょうか|ある人/ },
  { type: "呼びかけ型", re: /人へ|人は必見|人集合|方へ|あなた|さん、|全員|人、/ },
  { type: "数字型", re: /[0-9０-９]+(つ|個|選|割|％|%|倍|日|分|円|位|歳|代|本)/ },
  { type: "体験談型", re: /私は|私が|やってみた|続けて|分かった|わかった|してた|だった/ },
  { type: "断定型", re: /です。|ます。|です$|ます$|だ。|である/ },
];

/** 本文1行目（60文字まで）からフック型を判定する。 */
export function classifyHook(text: string): HookType {
  const firstLine = (text ?? "").split("\n")[0] ?? "";
  const head = [...firstLine].slice(0, 60).join("");
  for (const rule of HOOK_RULES) {
    if (rule.re.test(head)) return rule.type;
  }
  return "その他";
}

/** 本文の長さ帯。文字数はコードポイント数で数える。 */
export function lengthBucket(text: string): LengthBucket {
  const n = [...(text ?? "")].length;
  if (n < 100) return "<100";
  if (n < 200) return "100-200";
  if (n < 300) return "200-300";
  return "300+";
}

type TzParts = { hour: number; weekday: number };

/** timeZone 付きで「時」と「曜日（0=日）」を取り出す。 */
function partsInTz(date: Date, tz: string): TzParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
    weekday: "short",
  });
  let hour = 0;
  let weekday = 0;
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (const part of fmt.formatToParts(date)) {
    if (part.type === "hour") hour = Number(part.value) % 24;
    if (part.type === "weekday") {
      const i = names.indexOf(part.value);
      if (i >= 0) weekday = i;
    }
  }
  return { hour, weekday };
}

/** 3時間刻みの枠（0,3,6,...,21）。tz 既定は Asia/Tokyo。 */
export function slotOf(date: Date | string, tz = "Asia/Tokyo"): number {
  const d = typeof date === "string" ? new Date(date) : date;
  const { hour } = partsInTz(d, tz);
  return Math.floor(hour / 3) * 3;
}

/** 土日なら weekend、それ以外は weekday。 */
export function dayTypeOf(date: Date | string, tz = "Asia/Tokyo"): DayType {
  const d = typeof date === "string" ? new Date(date) : date;
  const { weekday } = partsInTz(d, tz);
  return weekday === 0 || weekday === 6 ? "weekend" : "weekday";
}

/** learning.dim='slot' の value（SPEC §9.1）。例: weekday-21 */
export function slotValue(date: Date | string, tz = "Asia/Tokyo"): string {
  return `${dayTypeOf(date, tz)}-${slotOf(date, tz)}`;
}

/** `weekday-21` を「平日 21時台」に直す（SPEC §12.3）。 */
export function slotLabel(value: string): string {
  const m = /^(weekday|weekend)-(\d{1,2})$/.exec(value);
  if (!m) return value;
  return `${m[1] === "weekend" ? "土日" : "平日"} ${Number(m[2])}時台`;
}

export type PostTags = {
  hook: HookType;
  length: LengthBucket;
  /** 3時間刻みの「時」を文字列にしたもの（SPEC §4 の tags_json 例に合わせる）。 */
  slot: string;
  daytype: DayType;
  source_id?: string;
  link?: "comment" | "body" | "none";
  scored?: boolean;
};

/** posts.tags_json / queue.tags_json に入れる形（SPEC §4）を組み立てる。 */
export function buildTags(
  text: string,
  postedAt: Date | string,
  tz = "Asia/Tokyo",
  extra: Partial<Pick<PostTags, "source_id" | "link">> = {},
): PostTags {
  return {
    hook: classifyHook(text),
    length: lengthBucket(text),
    slot: String(slotOf(postedAt, tz)),
    daytype: dayTypeOf(postedAt, tz),
    ...extra,
  };
}

export { similarity, normalizeForSimilarity, grams } from "./similarity";
