import { describe, expect, it } from "vitest";
import { allocateClicks, type ClickPost } from "../src/clicks";

const post = (id: string, rootId: string, text: string, views: number): ClickPost => ({
  id,
  rootId,
  text,
  views,
});

describe("allocateClicks（SPEC §8.5 の按分）", () => {
  it("そのURLを含む投稿の views の比で按分する", () => {
    const posts = [
      post("r1", "r1", "本文A https://example.com/a", 300),
      post("r2", "r2", "本文B https://example.com/a", 100),
    ];
    const alloc = allocateClicks(new Map([["https://example.com/a", 80]]), posts);
    expect(alloc.byRoot.get("r1")).toBeCloseTo(60, 6);
    expect(alloc.byRoot.get("r2")).toBeCloseTo(20, 6);
    expect(alloc.unassigned).toBe(0);
    expect(alloc.assigned).toBeCloseTo(80, 6);
  });

  it("コメント側にリンクがあるときは、コメントの views で按分し root に集約する", () => {
    // 既定の link_placement='comment'。root の views では按分しない（SPEC §8.5 手順3）
    const posts = [
      post("r1", "r1", "本文だけ", 10_000),
      post("c1", "r1", "続きは https://example.com/a", 200),
      post("r2", "r2", "本文だけ", 10),
      post("c2", "r2", "続きは https://example.com/a", 600),
    ];
    const alloc = allocateClicks(new Map([["https://example.com/a", 80]]), posts);
    expect(alloc.byRoot.get("r1")).toBeCloseTo(20, 6);
    expect(alloc.byRoot.get("r2")).toBeCloseTo(60, 6);
  });

  it("同じツリー内の root と child に同じURLがあると max(views) を1回だけ使う", () => {
    const posts = [
      post("r1", "r1", "本文 https://example.com/a", 100),
      post("c1", "r1", "コメント https://example.com/a", 400),
      post("r2", "r2", "本文 https://example.com/a", 400),
    ];
    const alloc = allocateClicks(new Map([["https://example.com/a", 100]]), posts);
    // ツリー1の重みは max(100, 400)=400。500 ではない
    expect(alloc.byRoot.get("r1")).toBeCloseTo(50, 6);
    expect(alloc.byRoot.get("r2")).toBeCloseTo(50, 6);
    expect(alloc.byUrl.get("https://example.com/a")).toEqual({ clicks: 100, posts: 2 });
  });

  it("突合は正規化URL。UTM・末尾スラッシュ・フラグメントの違いを吸収する", () => {
    const posts = [post("r1", "r1", "https://example.com/a/?utm_source=threads#x", 100)];
    const alloc = allocateClicks(new Map([["https://example.com/a", 50]]), posts);
    expect(alloc.byRoot.get("r1")).toBeCloseTo(50, 6);
    expect(alloc.unassigned).toBe(0);
  });

  it("どの投稿とも一致しないURLは unassigned に落ちる", () => {
    const posts = [post("r1", "r1", "https://example.com/a", 100)];
    const alloc = allocateClicks(
      new Map([
        ["https://example.com/a", 30],
        ["https://other.example/b", 12],
      ]),
      posts,
    );
    expect(alloc.byRoot.get("r1")).toBeCloseTo(30, 6);
    expect(alloc.unassigned).toBe(12);
    expect(alloc.byUrl.get("https://other.example/b")).toEqual({ clicks: 12, posts: 0 });
  });

  it("views が全部 0 のときは頭割りにする（0除算しない）", () => {
    const posts = [
      post("r1", "r1", "https://example.com/a", 0),
      post("r2", "r2", "https://example.com/a", 0),
    ];
    const alloc = allocateClicks(new Map([["https://example.com/a", 10]]), posts);
    expect(alloc.byRoot.get("r1")).toBeCloseTo(5, 6);
    expect(alloc.byRoot.get("r2")).toBeCloseTo(5, 6);
  });

  it("同じ入力なら何度呼んでも同じ結果（決定的）", () => {
    const posts = [
      post("r1", "r1", "https://example.com/a", 300),
      post("r2", "r2", "https://example.com/a", 100),
    ];
    const totals = new Map([["https://example.com/a", 80]]);
    const a = allocateClicks(totals, posts);
    const b = allocateClicks(totals, posts);
    expect([...a.byRoot]).toEqual([...b.byRoot]);
    expect(a.unassigned).toBe(b.unassigned);
  });
});
