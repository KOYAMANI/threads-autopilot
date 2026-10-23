import { describe, expect, it } from "vitest";
import { noteToHtml, noteToMarkdown, notePlaceholders, noteCharCount, type NoteDetail } from "../src";

function note(): NoteDetail {
  return {
    id: "n1", accountId: "a1", title: "犬のごはん選び", titleOptions: [], memo: "", style: "general", volume: "standard",
    refNote: "", refProfile: null, sourceIds: [], outline: null, paywallAfter: 0, qa: [], status: "done", engine: "gemini",
    createdAt: "", updatedAt: "",
    sections: [
      { id: "s2", ord: 1, heading: "第1章 なぜ", targetChars: 100, body: "導入。\n\n## 1-1 毎日\n\n本文です。**強調**も。\n\n- 一つ\n- 二つ\n\n【商品名】を入れる。", summary: "", charCount: 10, status: "done", error: null, updatedAt: "" },
      { id: "s1", ord: 0, heading: "はじめに", targetChars: 100, body: "最初の段落。", summary: "", charCount: 6, status: "done", error: null, updatedAt: "" },
    ],
  };
}

describe("note-export", () => {
  it("Markdown: タイトル → 章（ord 順）→ 節は ###、有料ラインは paywallAfter の次の章の前", () => {
    const md = noteToMarkdown(note());
    expect(md).toBe(
      "# 犬のごはん選び\n\n## はじめに\n\n最初の段落。\n\n（ここから有料）\n\n## 第1章 なぜ\n\n導入。\n\n### 1-1 毎日\n\n本文です。**強調**も。\n\n- 一つ\n- 二つ\n\n【商品名】を入れる。\n",
    );
  });
  it("HTML: 見出し・段落・箇条書き・太字。エスケープする", () => {
    const html = noteToHtml(note());
    expect(html).toContain("<h1>犬のごはん選び</h1>");
    expect(html).toContain("<p>（ここから有料）</p>\n<h2>第1章 なぜ</h2>");
    expect(html).toContain("<h3>1-1 毎日</h3>");
    expect(html).toContain("<p>本文です。<strong>強調</strong>も。</p>");
    expect(html).toContain("<ul><li>一つ</li><li>二つ</li></ul>");
    expect(noteToHtml({ ...note(), title: "a<b" })).toContain("<h1>a&lt;b</h1>");
  });
  it("この章だけ: タイトルと有料ラインを付けない", () => {
    const md = noteToMarkdown(note(), { kind: "chapter", sectionId: "s2" });
    expect(md.startsWith("## 第1章 なぜ")).toBe(true);
    expect(md).not.toContain("（ここから有料）");
  });
  it("有料ライン無し（null）では区切りを出さない", () => {
    expect(noteToMarkdown({ ...note(), paywallAfter: null })).not.toContain("（ここから有料）");
  });
  it("埋める箇所は done の章から ord 順に拾う", () => {
    expect(notePlaceholders(note())).toEqual([{ sectionId: "s2", ord: 1, text: "商品名" }]);
    expect(noteCharCount("あい う\nえ")).toBe(4);
  });
});
