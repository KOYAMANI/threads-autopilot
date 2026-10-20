import { describe, expect, it } from "vitest";
import { replaceFirstContentLine } from "../src/buzz";

describe("replaceFirstContentLine", () => {
  it("投稿本文の最初の非空行だけを置き換える", () => {
    expect(replaceFirstContentLine("元の1行目\n本文1\n本文2", "新しい1行目"))
      .toBe("新しい1行目\n本文1\n本文2");
  });

  it("候補に本文全体が混ざっても最初の非空行しか使わない", () => {
    expect(replaceFirstContentLine("元の1行目\n残す本文", "\n候補の1行目\n誤って返った候補本文\n候補の締め"))
      .toBe("候補の1行目\n残す本文");
  });

  it("空の候補では本文を変更しない", () => {
    expect(replaceFirstContentLine("元の1行目\n本文", " \n ")).toBe("元の1行目\n本文");
  });
});
