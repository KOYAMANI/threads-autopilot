import { describe, expect, it } from "vitest";
import {
  classifyHook,
  dayTypeOf,
  lengthBucket,
  slotLabel,
  slotOf,
  slotValue,
  buildTags,
} from "../src/tags";

describe("classifyHook", () => {
  it("ルールの順序どおりに最初に当たった型を返す", () => {
    expect(classifyHook("実は誰も知らない話があります")).toBe("意外性型");
    expect(classifyHook("これは危険なやり方です")).toBe("警告型");
    expect(classifyHook("この方法、知ってますか")).toBe("疑問型");
    expect(classifyHook("副業したい人へ")).toBe("呼びかけ型");
    expect(classifyHook("収益を伸ばす3つの方法")).toBe("数字型");
    expect(classifyHook("私は半年間これを続けてきた")).toBe("体験談型");
    expect(classifyHook("これで十分です。")).toBe("断定型");
    expect(classifyHook("ねこ")).toBe("その他");
  });

  it("意外性型が警告型より先に当たる（順序の確認）", () => {
    // 「実は」（意外性型）と「危険」（警告型）の両方を含む
    expect(classifyHook("実はこれ、危険です")).toBe("意外性型");
  });

  it("判定は1行目の先頭60文字だけを見る", () => {
    const head = "あ".repeat(60);
    expect(classifyHook(head + "危険")).toBe("その他");
    expect(classifyHook("ふつうの行\n危険な話")).toBe("その他");
  });

  it("空文字はその他", () => {
    expect(classifyHook("")).toBe("その他");
  });
});

describe("lengthBucket", () => {
  it("境界値", () => {
    expect(lengthBucket("あ".repeat(99))).toBe("<100");
    expect(lengthBucket("あ".repeat(100))).toBe("100-200");
    expect(lengthBucket("あ".repeat(199))).toBe("100-200");
    expect(lengthBucket("あ".repeat(200))).toBe("200-300");
    expect(lengthBucket("あ".repeat(299))).toBe("200-300");
    expect(lengthBucket("あ".repeat(300))).toBe("300+");
  });

  it("サロゲートペアは1文字として数える", () => {
    expect(lengthBucket("👨‍👩‍👧".repeat(10))).toBe("<100");
  });
});

describe("slotOf / dayTypeOf", () => {
  // 2026-09-04T12:34:00Z = 2026-09-04 21:34 JST（金曜）
  const friday = "2026-09-04T12:34:00.000Z";
  // 2026-09-05T03:00:00Z = 2026-09-05 12:00 JST（土曜）
  const saturday = "2026-09-05T03:00:00.000Z";

  it("Asia/Tokyo で3時間刻みに丸める", () => {
    expect(slotOf(friday)).toBe(21);
    expect(slotOf(saturday)).toBe(12);
  });

  it("tz を変えると枠も変わる", () => {
    expect(slotOf(friday, "UTC")).toBe(12);
    expect(slotOf(saturday, "UTC")).toBe(3);
  });

  it("daytype は土日で切り替わる", () => {
    expect(dayTypeOf(friday)).toBe("weekday");
    expect(dayTypeOf(saturday)).toBe("weekend");
    // JST では土曜だが UTC ではまだ金曜
    expect(dayTypeOf(saturday, "UTC")).toBe("weekend");
    expect(dayTypeOf("2026-09-05T14:00:00.000Z", "UTC")).toBe("weekend");
    expect(dayTypeOf("2026-09-05T14:00:00.000Z", "Asia/Tokyo")).toBe("weekend");
  });

  it("日付をまたぐ枠（JST 深夜）", () => {
    // 2026-09-04T16:00:00Z = 2026-09-05 01:00 JST（土曜）
    expect(slotOf("2026-09-04T16:00:00.000Z")).toBe(0);
    expect(dayTypeOf("2026-09-04T16:00:00.000Z")).toBe("weekend");
  });

  it("slotValue / slotLabel", () => {
    expect(slotValue(friday)).toBe("weekday-21");
    expect(slotValue(saturday)).toBe("weekend-12");
    expect(slotLabel("weekday-21")).toBe("平日 21時台");
    expect(slotLabel("weekend-12")).toBe("土日 12時台");
    expect(slotLabel("なにか")).toBe("なにか");
  });
});

describe("buildTags", () => {
  it("tags_json の形をそのまま組み立てる", () => {
    expect(buildTags("これは危険です", "2026-09-04T12:34:00.000Z", "Asia/Tokyo", { link: "comment" })).toEqual({
      hook: "警告型",
      length: "<100",
      slot: "21",
      daytype: "weekday",
      link: "comment",
    });
  });
});
