import { describe, expect, it } from "vitest";
import { ownChain } from "../src/routes/post-view";

const r = (id: string, replyTo: string | null, at: string) => ({ id, reply_to_id: replyTo, posted_at: at });

describe("本人の続き（ownChain）", () => {
  it("root から直接つながる返信の連なりだけを続きにし、他人のコメントへの返信は外す", () => {
    const replies = [
      r("c2", "root", "2026-10-01T00:01:00Z"),
      r("c3", "c2", "2026-10-01T00:02:00Z"),
      // 他人のコメント（someone）への返信。本人の投稿にはぶら下がっていない
      r("x", "someone", "2026-10-01T00:03:00Z"),
      r("c4", "c3", "2026-10-01T00:04:00Z"),
    ];
    expect(ownChain("root", replies).map((x) => x.id)).toEqual(["c2", "c3", "c4"]);
  });
  it("同じ親に2つぶら下がるときは早い方を続きにする", () => {
    const replies = [r("late", "root", "2026-10-01T00:05:00Z"), r("early", "root", "2026-10-01T00:01:00Z")];
    expect(ownChain("root", replies).map((x) => x.id)).toEqual(["early"]);
  });
  it("再同期前（reply_to_id が全部 null）は従来どおり全部を続きにする", () => {
    const replies = [r("a", null, "2026-10-01T00:01:00Z"), r("b", null, "2026-10-01T00:02:00Z")];
    expect(ownChain("root", replies)).toEqual(replies);
  });
  it("輪になっても止まる", () => {
    const replies = [r("a", "root", "2026-10-01T00:01:00Z"), r("b", "a", "2026-10-01T00:02:00Z"), r("a2", "b", "2026-10-01T00:03:00Z")];
    expect(ownChain("root", [...replies, r("root", "a2", "2026-10-01T00:04:00Z")]).map((x) => x.id)).toEqual(["a", "b", "a2"]);
  });
});
