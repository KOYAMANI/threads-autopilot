import { describe, expect, it } from "vitest";
import { bodyLength, parseNgWords, validatePost } from "../src/validate";

const codes = (r: ReturnType<typeof validatePost>) => r.issues.map((i) => i.code);

describe("bodyLength", () => {
  it("ASCII はコードポイント数とバイト数が一致する", () => {
    expect(bodyLength("abc")).toBe(3);
  });

  it("絵文字はバイト数（厳しい方）で数える", () => {
    // "あ" は1コードポイント・3バイト → 厳しい方は3
    expect(bodyLength("あ")).toBe(3);
    expect(bodyLength("🙂")).toBe(4);
  });
});

describe("validatePost", () => {
  it("ふつうの本文は通る", () => {
    expect(validatePost("朝の30分で終わらせる方法を書きました")).toEqual({ ok: true, issues: [] });
  });

  it("空の本文を弾く", () => {
    expect(codes(validatePost("  "))).toContain("BODY_EMPTY");
  });

  it("500文字（バイト換算）超を弾く", () => {
    expect(codes(validatePost("a".repeat(501)))).toContain("BODY_TOO_LONG");
    expect(codes(validatePost("a".repeat(500)))).not.toContain("BODY_TOO_LONG");
  });

  it("リンク6本で日本語エラー（本文に置く設定でも）", () => {
    const body = Array.from({ length: 6 }, (_, i) => `https://e${i}.example`).join(" ");
    const r = validatePost(body, { linkPlacement: "body" });
    expect(codes(r)).toContain("LINK_LIMIT");
    expect(r.issues[0]?.message).toContain("5つまで");
  });

  it("リンク5本は通る（本文に置く設定）", () => {
    const body = Array.from({ length: 5 }, (_, i) => `https://e${i}.example`).join(" ");
    expect(validatePost(body, { linkPlacement: "body" }).ok).toBe(true);
  });

  it("link_placement=comment のとき本文のURLを弾く", () => {
    expect(codes(validatePost("こちら https://a.example"))).toContain("LINK_IN_BODY");
    expect(codes(validatePost("こちら https://a.example", { linkPlacement: "none" }))).toContain(
      "LINK_IN_BODY",
    );
    expect(codes(validatePost("こちら https://a.example", { linkPlacement: "body" }))).not.toContain(
      "LINK_IN_BODY",
    );
  });

  it("NGワードを検出する", () => {
    const r = validatePost("必ず稼げます", { ngWords: "必ず\n絶対" });
    expect(codes(r)).toContain("NG_WORD");
    expect(r.issues[0]?.message).toContain("必ず");
  });

  it("NGワードはコメント側も見る", () => {
    const r = validatePost("本文はきれい", { ngWords: ["絶対"], comments: ["絶対に儲かります"] });
    expect(codes(r)).toContain("NG_WORD");
    expect(r.issues[0]?.field).toBe("comments.0");
  });

  it("コメントの長さも見る", () => {
    expect(codes(validatePost("本文", { comments: ["a".repeat(501)] }))).toContain(
      "COMMENT_TOO_LONG",
    );
  });

  it("コメントにリンクを置くのは通る（既定の link_placement=comment）", () => {
    expect(validatePost("本文", { comments: ["登録はこちら https://lin.ee/x"] }).ok).toBe(true);
  });
});

describe("parseNgWords", () => {
  it("改行・読点・カンマで区切る", () => {
    expect(parseNgWords("必ず、絶対\n確実, 保証")).toEqual(["必ず", "絶対", "確実", "保証"]);
  });

  it("空は空配列", () => {
    expect(parseNgWords("")).toEqual([]);
    expect(parseNgWords(undefined)).toEqual([]);
  });
});
