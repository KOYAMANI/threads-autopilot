import { describe, expect, it } from "vitest";
import { compose, readCompositionPlan, candidateIssues, candidatesTooSimilar, renderBlueprint, type CompositionInput, type CompositionPlan } from "../src/lib/composition";
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
  it("素材にない分析上の固有名詞は生成へ進めない", () => {
    expect(() => readCompositionPlan(JSON.stringify({ ...plan, anchors: ["捏造した実績"] }), input)).toThrow("素材にない");
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
      return JSON.stringify(output(q.index === 1 && !q.feedback ? samples[0]! : samples[q.index]!));
    });
    expect(repairs).toBe(1); expect(result.candidates).toHaveLength(3);
  });
  it("再生成しても同じ候補なら成功として返さない", async () => {
    await expect(compose(input, async (_system, user) => JSON.stringify(JSON.parse(user).task === "composition-plan" ? plan : output(samples[0]!)))).rejects.toThrow("候補B");
  });
  it("不足情報は生成案の代わりに質問として返す", async () => {
    const result = await compose(input, async () => JSON.stringify({ status: "needs_input", question: "新しい比較対象は？" }));
    expect(result.notes).toEqual(["新しい比較対象は？"]); expect(result.candidates).toHaveLength(0);
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
  it("骨組みに固定項目がない場合は生成を止める", () => {
    expect(() => readCompositionPlan(JSON.stringify({ ...plan, anchors: ["りんご"] }), input)).toThrow("骨組みに項目が足りません");
  });
});


describe("生成前の会話とおまかせ", () => {
  it("質問を構造化して返す", async () => {
    const result=await compose(input,async()=>JSON.stringify({status:"needs_input",question:"誰に向けて書きますか？"}));
    expect(result.clarification?.question).toBe("誰に向けて書きますか？");
  });
  it("ユーザーの回答を事実の根拠にし、AIの質問は根拠にしない", async () => {
    const seen:any[]=[];
    await compose({...input,conversation:[{role:"assistant",text:"医師の実績は？"},{role:"user",text:"会社員向けです"}]},async(_system,user)=>{
      const q=JSON.parse(user);seen.push(q);
      return JSON.stringify(q.task==="composition-plan"?plan:output(samples[q.index]!));
    });
    expect(seen[0].instruction).toContain("会社員向けです");
    expect(seen[0].instruction).not.toContain("医師の実績");
  });
  it("おまかせでは再質問を一度だけやり直して生成へ進む", async () => {
    let plans=0;
    const result=await compose({...input,sources:[],instruction:"果物について。全部任せる"},async(system,user)=>{
      const q=JSON.parse(user);
      expect(q.clarificationMode).toBe("delegate");
      if(q.task==="composition-plan") {
        expect(system).toContain("追加質問は禁止");
        if(++plans===1)return JSON.stringify({status:"needs_input",question:"何を選ぶ？"});
        return JSON.stringify(plan);
      }
      return JSON.stringify(output(samples[q.index]!));
    });
    expect(result.candidates).toHaveLength(3);expect(result.clarification).toBeUndefined();expect(plans).toBe(2);
  });
  it("おまかせ時の質問ループを制限する",async()=>{
    let calls=0;
    await expect(compose({...input,clarificationMode:"delegate"},async()=>{calls++;return JSON.stringify({status:"needs_input",question:"情報は？"});})).rejects.toThrow("おまかせ");
    expect(calls).toBe(2);
  });
});
