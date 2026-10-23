import { describe, expect, it } from "vitest";
import { cleanPart, compose, readCompositionPlan, candidateIssues, candidatesTooSimilar, renderBlueprint, type CompositionInput, type CompositionPlan } from "../src/lib/composition";
import { pickedPosts } from "../src/routes/ai";
import { insertAccount, registerUser, testDb, mockToken } from "./helpers";

const input: CompositionInput = { mode: "template", references: ["参考の本文\n【続き】\n参考の答え"], sources: [{ title: "自分のメモ", content: "りんご・みかん・ぶどうの比較" }], youtubeUrls: [], links: [], instruction: "果物について", n: 3, constraints: { emoji: "none", ngWords: "", linkPlacement: "comment" } };
const plan: CompositionPlan = { status: "ok", summary: "投稿は型、メモは情報", structure: "導入と説明", style: "端的", partCount: 2, anchors: [], variants: [{ label: "原型", approach: "順に紹介" }, { label: "比較", approach: "判断を助ける" }, { label: "短く", approach: "簡潔にまとめる" }] };
plan.variants = plan.variants.map(v => ({ ...v, blueprint: { posts: ["{{body}}", "{{comment}}"], slots: [{ id: "body", task: "本文", maxChars: 450 }, { id: "comment", task: "続き", maxChars: 450 }] } }));
const samples = [
  { key: "A", hook: "一覧型", body: "果物を選ぶなら、この3種類。", comments: ["りんご、みかん、ぶどう。それぞれ並べて選ぼう。"], basis: "メモ" },
  { key: "B", hook: "比較型", body: "今日の気分はどれ？", comments: ["候補はりんご・みかん・ぶどう。食べたいものを比べて決める。"], basis: "メモ" },
  { key: "C", hook: "簡潔型", body: "りんご / みかん / ぶどう", comments: ["選択肢はこの3つ。"], basis: "メモ" },
];

const output = (sample: typeof samples[number]) => ({ slots: { body: sample.body, comment: sample.comments[0] } });

describe("役割を分けた投稿生成", () => {
  it("型だけで新しい素材がなければAPIを呼ばず入力を求める", async () => {
    const result = await compose({ ...input, sources: [], instruction: "" }, async () => { throw new Error("must not call"); });
    expect(result.candidates).toEqual([]); expect(result.notes[0]).toContain("テーマ");
  });
  it("型の分析と情報を区別し、3つの方針を別リクエストへ渡す", async () => {
    const requests: any[] = [];
    const result = await compose(input, async (_system, user) => {
      const q = JSON.parse(user); requests.push(q);
      return JSON.stringify(q.task === "composition-plan" ? plan : output(samples[q.index]!));
    });
    expect(requests).toHaveLength(4);
    expect(requests[0].references).toEqual(input.references);
    expect(requests[0].sources).toEqual(input.sources);
    expect(requests.slice(1).map(q => q.variant.label)).toEqual(["原型", "比較", "短く"]);
    expect(result.candidates.map(c => c.key)).toEqual(["A", "B", "C"]);
    expect(result.candidates.map(c => c.angle)).toEqual(["原型", "比較", "短く"]);
  });
  it("リライト元は事実の根拠になり、他の素材が空でも生成する", async () => {
    const rewrite = { ...input, mode: "rewrite" as const, references: ["1,000万。原型を残す"], sources: [], instruction: "", n: 1 };
    const result = await compose(rewrite, async (_system, user) => JSON.stringify(JSON.parse(user).task === "composition-plan" ? { ...plan, partCount: 1, anchors: ["1,000万"], variants: [{ ...plan.variants[0]!, blueprint: { posts: ["{{body}}"], slots: [{ id: "body", task: "本文", maxChars: 450 }] } }] } : { slots: { body: "原型を残して1,000万。" } }));
    expect(result.candidates).toHaveLength(1);
  });
  it("長すぎる説明・文字列の数値・書式の違うスロット名は直して読む", () => {
    const loose = { ...plan, status: "OK", structure: "あ".repeat(5000), partCount: "2", variants: plan.variants.map(v => ({ ...v, label: v.label + "x".repeat(60), blueprint: { posts: ["{{ IntroText }}", "{{comment-1}}"], slots: [{ id: "IntroText", task: "本文", maxChars: 900 }, { id: "comment-1", task: "続き", maxChars: "200" }] } })) };
    const read = readCompositionPlan(JSON.stringify(loose), input);
    expect(read.structure).toHaveLength(3000);
    expect(read.partCount).toBe(2);
    expect(read.variants[0]!.label).toHaveLength(40);
    expect(read.variants[0]!.blueprint!.posts).toEqual(["{{intro_text}}", "{{comment_1}}"]);
    expect(read.variants[0]!.blueprint!.slots.map(s => [s.id, s.maxChars])).toEqual([["intro_text", 450], ["comment_1", 200]]);
  });
  it("読めなかった理由と応答の頭を raw に残す", () => {
    try { readCompositionPlan(JSON.stringify({ status: "maybe" }), input); throw new Error("not thrown"); }
    catch (e) { expect((e as { raw: string }).raw).toContain("status"); }
  });
  it("素材にない数字は固定せず、それを書き込んだ骨組みも使わない", () => {
    const withNumber = { ...plan, anchors: ["売上300万"], variants: plan.variants.map((v, i) => i === 0 ? { ...v, blueprint: { ...v.blueprint!, posts: ["売上300万 {{body}}", "{{comment}}"] } } : v) };
    const read = readCompositionPlan(JSON.stringify(withNumber), input);
    expect(read.anchors).toEqual([]);
    expect(read.variants[0]!.blueprint).toBeUndefined();
    expect(read.variants[1]!.blueprint).toBeDefined();
  });
  it("AI が付けたステップ名など素材にない言葉は、固定する項目から外して進める", () => {
    const read = readCompositionPlan(JSON.stringify({ ...plan, anchors: ["① アカウント設計"] }), input);
    expect(read.anchors).toEqual([]);
    expect(read.variants.every(v => v.blueprint)).toBe(true);
  });
  it("項目の欠落・投稿数・文字数・設定違反を検出する", () => {
    const issues = candidateIssues({ ...samples[0]!, body: "あ".repeat(501) + "https://example.com 😀禁止", comments: [] }, { ...plan, anchors: ["りんご"] }, { ...input, constraints: { ...input.constraints, ngWords: "禁止" } });
    expect(issues.length).toBe(6);
  });
  it("冒頭だけを変えた候補を同じと判定する", () => {
    expect(candidatesTooSimilar(samples[0]!, { ...samples[0]!, body: "別の冒頭。" }, [])).toBe(true);
    expect(candidatesTooSimilar(samples[0]!, samples[1]!, [])).toBe(false);
  });
  it("重複候補は1回再生成し、既存案と理由を渡す", async () => {
    let repairs = 0;
    const result = await compose(input, async (_system, user) => {
      const q = JSON.parse(user);
      if (q.task === "composition-plan") return JSON.stringify(plan);
      if (q.feedback) { repairs++; expect(q.feedback.avoid).toHaveLength(1); }
      // 再試行は骨組み無しの1案まるごと（composition-write）
      if (q.task === "composition-write") { expect(q.variant.blueprint).toBeUndefined(); return JSON.stringify({ candidates: [samples[q.index]!] }); }
      return JSON.stringify(output(q.index === 1 ? samples[0]! : samples[q.index]!));
    });
    expect(repairs).toBe(1); expect(result.candidates).toHaveLength(3);
  });
  it("再生成しても同じ候補なら成功として返さず、作れた案だけ返す", async () => {
    const result = await compose(input, async (_system, user) => JSON.stringify(JSON.parse(user).task === "composition-plan" ? plan : output(samples[0]!)));
    expect(result.candidates.map(c => c.key)).toEqual(["A"]);
    expect(result.notes[0]).toContain("1案だけ");
  });
  it("全案が作れなければ最初の失敗を返す", async () => {
    await expect(compose(input, async (_system, user) => JSON.parse(user).task === "composition-plan" ? JSON.stringify(plan) : "読めない応答")).rejects.toThrow("JSON");
  });
  it("残り時間が足りなければ再試行せず、作れた案で返す", async () => {
    let calls = 0;
    let t = 0;
    const result = await compose(input, async (_system, user) => {
      calls++;
      const q = JSON.parse(user);
      if (q.task === "composition-plan") return JSON.stringify(plan);
      return q.index === 2 ? "読めない応答" : JSON.stringify(output(samples[q.index]!));
    }, { deadline: 20_000, now: () => t });
    expect(calls).toBe(4);
    expect(result.candidates.map(c => c.key)).toEqual(["A", "B"]);
  });
  it("不足情報は生成案の代わりに質問として返す", async () => {
    const result = await compose(input, async () => JSON.stringify({ status: "needs_input", question: "新しい比較対象は？" }));
    expect(result.notes).toEqual(["新しい比較対象は？"]); expect(result.candidates).toHaveLength(0);
    expect(result.question).toBe("新しい比較対象は？");
  });
  it("「任せる」(assume) は計画の依頼に渡り、質問が返らなければ案になる", async () => {
    const requests: any[] = [];
    const result = await compose({ ...input, assume: true }, async (_system, user) => {
      const q = JSON.parse(user); requests.push(q);
      return JSON.stringify(q.task === "composition-plan" ? plan : output(samples[q.index]!));
    });
    expect(requests[0].assume).toBe(true);
    expect(result.candidates).toHaveLength(3); expect(result.question).toBeUndefined();
  });
  it("assume でも AI が質問を返したら、そのまま質問として返す（回し続けない）", async () => {
    let calls = 0;
    const result = await compose({ ...input, assume: true }, async () => { calls++; return JSON.stringify({ status: "needs_input", question: "何を比べますか？" }); });
    expect(calls).toBe(1); expect(result.question).toBe("何を比べますか？"); expect(result.candidates).toHaveLength(0);
  });
});

describe("参考のツリー全文とアカウント分離", () => {
  it("本人の続きだけを順に取得し、削除済みと別アカウントを除く", async () => {
    const { userId } = await registerUser();
    const a = await insertAccount({ userId, token: mockToken("tree-a") });
    const b = await insertAccount({ userId, token: mockToken("tree-b") });
    const db = testDb();
    for (const [account, id, reply, text, date, deleted] of [[a, "root", 0, "順位の導入", "01", 0], [a, "later", 1, "最後の誘導", "03", 0], [a, "answer", 1, "最強の答え", "02", 0], [a, "deleted", 1, "削除済み", "04", 1], [b, "root", 0, "別アカウントの親", "01", 0], [b, "secret", 1, "別アカウントの続き", "02", 0]] as const) {
      await db.run("INSERT INTO posts (account_id,id,root_id,is_reply,text,posted_at,tags_json,source,deleted) VALUES (?,?,'root',?,?,?,'{}','external',?)", account, id, reply, text, `2026-09-07T00:00:${date}Z`, deleted);
    }
    const got = await pickedPosts(db, a, ["root"]);
    expect(got).toEqual(["【投稿1】\n順位の導入\n\n【投稿2】\n最強の答え\n\n【投稿3】\n最後の誘導"]);
    expect(await pickedPosts(db, a, ["secret"])).toEqual([]);
  });
});


describe("固定する骨組みと可変部分", () => {
  const bp = { posts: ["第3位 ゴミ\n・Manus\n{{intro}}", "第1位 最強\n・Codex\n{{reason}}"], slots: [{ id: "intro", task: "導入", maxChars: 30 }, { id: "reason", task: "理由", maxChars: 40 }] };
  it("AIが項目を書かなくても骨組みの項目と順番は残る", () => {
    expect(renderBlueprint(bp, JSON.stringify({ slots: { intro: "続きへ", reason: "共有しながら壁打ち。" } }))).toEqual(["第3位 ゴミ\n・Manus\n続きへ", "第1位 最強\n・Codex\n共有しながら壁打ち。"]);
  });
  it("未定義・空・長すぎるスロットは返さない", () => {
    for (const slots of [{ intro: "導入" }, { intro: "", reason: "説明" }, { intro: "あ".repeat(31), reason: "説明" }]) expect(() => renderBlueprint(bp, JSON.stringify({ slots }))).toThrow();
  });
  it("骨組みに固定項目がない案は、骨組みを使わず1案まるごと書く", () => {
    const read = readCompositionPlan(JSON.stringify({ ...plan, anchors: ["りんご"] }), input);
    expect(read.anchors).toEqual(["りんご"]);
    expect(read.variants.every(v => v.blueprint === undefined)).toBe(true);
  });
  it("骨組みが崩れていても全体は止めず、案の数が足りなくても作れる分で進む", async () => {
    const broken = { ...plan, variants: [{ label: "原型", approach: "順に", blueprint: { posts: ["{{body}}"], slots: [{ id: "body", task: "本文", maxChars: 450 }] } }, { label: "原型", approach: "比較" }] };
    const result = await compose(input, async (_system, user) => {
      const q = JSON.parse(user);
      if (q.task === "composition-plan") return JSON.stringify(broken);
      return JSON.stringify({ candidates: [samples[q.index]!] });
    });
    expect(result.candidates.map(c => c.angle)).toEqual(["原型", "原型2"]);
  });
});

describe("貼り付け形式の漏れ", () => {
  it("末尾の【続き】や「続きはツリーへ」の行を外す", () => {
    expect(cleanPart("本文\n\n②\n【続き】")).toBe("本文\n\n②");
    expect(cleanPart("本文\n続きはツリーへ")).toBe("本文");
    expect(cleanPart("【続き】\n① 本文")).toBe("① 本文");
  });
});
