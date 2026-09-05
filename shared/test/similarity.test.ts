import { describe, expect, it } from "vitest";
import { DUPLICATE_THRESHOLD, grams, normalizeForSimilarity, similarity } from "../src/similarity";

describe("normalizeForSimilarity", () => {
  it("URL・空白・全角空白を落として小文字化する", () => {
    expect(normalizeForSimilarity("A B　C https://example.com/x\nD")).toBe("abcd");
  });
});

describe("grams", () => {
  it("連続3文字の集合になる", () => {
    expect([...grams("abcd")]).toEqual(["abc", "bcd"]);
  });

  it("3文字未満は1文字ずつの集合", () => {
    expect([...grams("ab")]).toEqual(["a", "b"]);
    expect([...grams("a")]).toEqual(["a"]);
  });

  it("空は空集合", () => {
    expect(grams("").size).toBe(0);
    expect(grams("   ").size).toBe(0);
  });
});

describe("similarity", () => {
  it("完全一致は1", () => {
    expect(similarity("おはようございます", "おはようございます")).toBe(1);
  });

  it("URL の違いだけなら1（正規化で落ちる）", () => {
    expect(similarity("今日の話 https://a.example", "今日の話 https://b.example/x")).toBe(1);
  });

  it("まったく違う文は0", () => {
    expect(similarity("あいうえお", "かきくけこ")).toBe(0);
  });

  it("Jaccard の値が手計算と一致する", () => {
    // grams("abcd") = {abc,bcd}, grams("abce") = {abc,bce} → 共通1 / 和集合3
    expect(similarity("abcd", "abce")).toBeCloseTo(1 / 3, 10);
  });

  it("両方空なら0", () => {
    expect(similarity("", "")).toBe(0);
  });

  it("しきい値0.8: ほぼ同じ文は重複と判定される", () => {
    const a = "朝の30分で副業の作業を終わらせる方法を書きました。まずは机の上を片付けます。";
    const b = "朝の30分で副業の作業を終わらせる方法を書きました。まずは机の上を片づけます。";
    expect(similarity(a, b)).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
  });

  it("しきい値0.8: 話題が違えば重複にならない", () => {
    const a = "朝の30分で副業の作業を終わらせる方法を書きました。";
    const b = "夜にコンビニへ行って新作のアイスを買ってきた話です。";
    expect(similarity(a, b)).toBeLessThan(DUPLICATE_THRESHOLD);
  });

  it("対称である", () => {
    const a = "テスト用の文章その1";
    const b = "テスト用の文章その2";
    expect(similarity(a, b)).toBe(similarity(b, a));
  });
});
