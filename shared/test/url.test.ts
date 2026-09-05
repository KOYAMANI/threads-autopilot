import { describe, expect, it } from "vitest";
import { extractUrls, normalizeUrl } from "../src/url";

describe("normalizeUrl", () => {
  it("scheme と host を小文字化し、host 末尾の . を落とす", () => {
    expect(normalizeUrl("HTTPS://Example.COM./Path")).toBe("https://example.com/Path");
  });

  it("既定ポートを落とす（非既定は残す）", () => {
    expect(normalizeUrl("https://example.com:443/a")).toBe("https://example.com/a");
    expect(normalizeUrl("http://example.com:80/a")).toBe("http://example.com/a");
    expect(normalizeUrl("http://example.com:8080/a")).toBe("http://example.com:8080/a");
  });

  it("フラグメントを落とす", () => {
    expect(normalizeUrl("https://example.com/a#section")).toBe("https://example.com/a");
  });

  it("追跡パラメータを落とし、残りをキー昇順に並べる", () => {
    expect(
      normalizeUrl("https://example.com/a?utm_source=x&b=2&fbclid=z&a=1&si=q&ref=r"),
    ).toBe("https://example.com/a?a=1&b=2");
  });

  it("パス末尾の / を落とす（/ だけなら空にする）", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
    expect(normalizeUrl("https://example.com/a/b/")).toBe("https://example.com/a/b");
  });

  it("同じリンクの表記ゆれが1つのキーに寄る", () => {
    const a = normalizeUrl("https://lin.ee/AbCd/?utm_source=threads#top");
    const b = normalizeUrl("HTTPS://LIN.EE/AbCd");
    expect(a).toBe(b);
    expect(a).toBe("https://lin.ee/AbCd");
  });

  it("パースできない入力は小文字化してそのまま返す", () => {
    expect(normalizeUrl("  NOT A URL  ")).toBe("not a url");
    expect(normalizeUrl("")).toBe("");
  });

  it("クエリ値は保つ", () => {
    expect(normalizeUrl("https://example.com/s?q=%E3%81%82&utm_id=1")).toBe(
      "https://example.com/s?q=%E3%81%82",
    );
  });
});

describe("extractUrls", () => {
  it("本文から拾って末尾の記号を剥がす", () => {
    expect(extractUrls("詳しくはこちら https://example.com/a。 あと https://b.example/x?y=1！")).toEqual([
      "https://example.com/a",
      "https://b.example/x?y=1",
    ]);
  });

  it("括弧閉じを剥がす", () => {
    expect(extractUrls("（https://example.com/a）")).toEqual(["https://example.com/a"]);
    expect(extractUrls("[https://example.com/a]")).toEqual(["https://example.com/a"]);
  });

  it("重複は除く", () => {
    expect(extractUrls("https://a.example https://a.example")).toEqual(["https://a.example"]);
  });

  it("URL が無ければ空配列", () => {
    expect(extractUrls("リンクなしの投稿")).toEqual([]);
    expect(extractUrls("")).toEqual([]);
  });

  it("http と https の両方を拾う", () => {
    expect(extractUrls("http://a.example と https://b.example")).toEqual([
      "http://a.example",
      "https://b.example",
    ]);
  });
});
