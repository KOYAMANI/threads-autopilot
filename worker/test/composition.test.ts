import {describe,it,expect,vi} from "vitest";
import {compose as runCompose,splitOverflow,referencePosts,abstractTemplate,candidateIssues,normalizePastedThread,referenceShape,withoutEmoji,type CompositionInput} from "../src/lib/composition";
import {validatePost} from "@tap/shared";
import {pickedPosts} from "../src/routes/ai";
import {AiError} from "../src/lib/ai";
import {registerUser,insertAccount,mockToken,testDb} from "./helpers";
// Most tests isolate validation; independent editor behavior is exercised below.
const compose:typeof runCompose=(input,call)=>runCompose(input,async(s,u,v,schema)=>{
 const q=JSON.parse(u);
 if(q.task==="post-edit")return JSON.stringify({candidates:q.drafts,notes:[]});
 return call(s,u,v,schema);
});
const input:CompositionInput={mode:"template",references:["導入\n・一つ\n・二つ\n【投稿2】\n・答え"],sources:[],youtubeUrls:[],links:[],instruction:"果物の選び方",n:3,constraints:{emoji:"none",ngWords:"",linkPlacement:"none"}};
const outputs=[["果物なら\n・りんご\n・みかん","・ぶどう"],["選ぶなら\n・りんご\n・みかん","・ぶどうが好き"],["果物の選択\n・りんご\n・みかん","・好みはぶどう"]];
const response=(posts:string[][])=>JSON.stringify({candidates:posts.map(posts=>({posts})),notes:[]});
it("gives the writer full reference, content mapping and explicit layout",async()=>{
 const abstractReference=await abstractTemplate(input.references[0]!,async(s,u)=>{expect(s).toContain("再現度50");expect(JSON.parse(u).posts).toHaveLength(2);expect(JSON.parse(u).fidelity).toBe(50);return JSON.stringify({structure:"導入と並列2項目、続きで1項目の答え",tone:"率直な口語"});},[],"",[],50);
 await compose({...input,abstractReference},async(_s,u)=>{const q=JSON.parse(u);expect(q.reference.posts).toHaveLength(2);expect(q.reference.layout[0].listItems).toBe(2);expect(q.reference.structure).toContain("並列2項目");expect(q.supplementaryReferences).toEqual([]);expect(q.resolvedRules.listItems).toEqual([2,1]);return response(outputs);});
});
it("loosens post count and layout at fidelity 50",async()=>{
 const r=await compose({...input,fidelity:50,n:1},async(_s,u)=>{const q=JSON.parse(u);expect(q.reproduction.fidelity).toBe(50);expect(q.reproduction.guidance).toContain("大まかな展開");expect(q.resolvedRules.postCount).toBeUndefined();return response([["自由な流れで作った本文"]]);});
 expect(r.candidates[0]!.comments).toEqual([]);
});
it("passes the selected post purpose to the writer",async()=>{
 await compose({...input,purpose:"action",n:1},async(_s,u)=>{
  const q=JSON.parse(u);expect(q.postPurpose.id).toBe("action");expect(q.postPurpose.guidance).toContain("行動を一つに絞り");
  return response([outputs[0]!]);
 });
});
it("writes coherent full posts without required line slots or added blank lines",async()=>{
 const r=await runCompose({...input,n:1},async(_s,u,_v,schema)=>{
  const q=JSON.parse(u);expect(q.requiredBlocks).toBeUndefined();
  expect((schema as any).properties.candidates.properties.A.properties.posts).toBeDefined();
  return response([outputs[0]!]);
 });expect(r.candidates[0]!.body).toBe(outputs[0]![0]);
});
it("edits a coherent draft with full sources and its plan",async()=>{
 const tasks:string[]=[];
 const r=await runCompose({...input,mode:"rewrite",n:1,sources:[{title:"素材",content:"本文末の根拠"}]},async(system,u)=>{
  const q=JSON.parse(u);tasks.push(q.task);
  if(q.task==="post-compose")return JSON.stringify({preparation:"主張と素材の対応",candidates:{A:{posts:outputs[0]}},notes:[]});
  expect(system).toContain("独立した添削工程");expect(q.preparation).toBe("主張と素材の対応");expect(q.sources[0].content).toBe("本文末の根拠");expect(q.drafts.A.posts).toEqual(outputs[0]);
  return response([outputs[1]!]);
 });expect(tasks).toEqual(["post-compose","post-edit"]);expect(r.candidates[0]!.body).toBe(outputs[1]![0]);
});
it("retains generated text when the separate editor is unavailable",async()=>{
 const r=await runCompose({...input,n:1},async(_s,u)=>{if(JSON.parse(u).task==="post-edit")throw new AiError("AI_FAILED","timeout");return response([outputs[0]!]);});
 expect(r.candidates[0]!.body).toBe(outputs[0]![0]);expect(r.notes.join()).toContain("添削を完了できなかった");
});
it("splits overflow into self replies without dropping text or adding blank lines",async()=>{
 const long=Array.from({length:34},(_,i)=>`${i}行目は具体的な説明を自然につないで書く。`).join("\n");
 const r=await compose({...input,mode:"information",references:[],n:1},async()=>response([[long]]));
 const parts=[r.candidates[0]!.body,...r.candidates[0]!.comments];
 expect(parts.length).toBeGreaterThan(1);expect(parts.every(p=>[...p].length<=500)).toBe(true);
 expect(validatePost(parts[0]!,{comments:parts.slice(1)}).ok).toBe(true);
 expect(parts.join("\n")).toBe(long);expect(parts.join("\n")).not.toContain("\n\n");
 expect(splitOverflow(["𠮷".repeat(501)])).toEqual(["𠮷".repeat(500),"𠮷"]);
});
it("repairs excess total length instead of emitting more than three comments",async()=>{
 let calls=0;const r=await compose({...input,mode:"information",references:[],n:1},async(_s,u)=>{
  if(++calls===1)return response([["文".repeat(2100)]]);
  expect(JSON.parse(u).feedback.join()).toContain("合計1800文字以内");return response([["内容を保った本文"]]);
 });expect(r.candidates[0]!.comments).toEqual([]);expect(calls).toBe(2);
});
it("recognizes standalone continuation labels without changing body line spacing",()=>{
 expect(referencePosts("導入\n・例\n\n続き\n\n答え\n理由")).toEqual(["導入\n・例","答え\n理由"]);
 expect(referencePosts("続きが気になる\n続きを読む")).toEqual(["続きが気になる\n続きを読む"]);
});
it("uses shared knowledge across representative origin, mode and source combinations",async()=>{
 for(const {origin,mode,hasSources} of [
  {origin:"own" as const,mode:"template" as const,hasSources:false},
  {origin:"paste" as const,mode:"rewrite" as const,hasSources:true},
 ]) {
  const result=await compose({...input,mode,referenceOrigin:origin,sources:hasSources?[{title:"教材",content:"最後の重要な情報"}]:[]},async(system,user)=>{
   const q=JSON.parse(user);expect(q.reference.origin).toBe(origin);expect(q.mode).toBe(mode);
   expect(q.writingKnowledge).toContain("同じ説明の反復");expect(system).toContain("伝聞");
   expect(q.sources).toHaveLength(hasSources?1:0);if(hasSources)expect(q.sources[0].content).toContain("最後の重要な情報");
   expect(q.resolvedRules.postCount).toBe(2);return response(outputs);
  });expect(result.candidates).toHaveLength(3);
 }
});
it("keeps valid candidates and repairs only the missing one",async()=>{
 let calls=0;
 const r=await compose(input,async(_s,u)=>{
  const q=JSON.parse(u);calls++;
  if(calls===1)return response([outputs[0]!,["### 見出し"],outputs[2]!]);
  expect(q.n).toBe(1);expect(q.accepted).toHaveLength(2);expect(q.feedback.join()).toContain("Markdown");
  return response([outputs[1]!]);
 });expect(calls).toBe(2);expect(r.candidates.map(c=>c.key)).toEqual(["A","B","C"]);
 expect(r.candidates[0]!.body).toBe(outputs[0]![0]);
});
it("returns partial success on repair provider failure",async()=>{
 let calls=0;const r=await compose(input,async()=>{if(++calls===1)return response([outputs[0]!]);throw new AiError("AI_FAILED","timeout");});
 expect(r.candidates).toHaveLength(1);expect(r.notes.join()).toContain("3案中1案");
});
it("exact duplicates become partial success, but similar rewrites are allowed",async()=>{
 const r=await compose(input,async()=>response([outputs[0]!,outputs[0]!,outputs[0]!]));
 expect(r.candidates).toHaveLength(1);
 const reference="ワイの会社の社長、元外コンで年3～4,000万とか貰ってたらしい。負けたくないな。";
 const r2=await compose({...input,mode:"rewrite",references:[reference],instruction:"内容同じで"},async()=>response([[reference],[reference.replace("ワイの会社の社長","ワイの会社の社長って")],[reference.replace("負けたくないな","負けたくないわ")]]));
 expect(r2.candidates).toHaveLength(3);expect(r2.candidates.every(c=>c.comments.length===0)).toBe(true);
});
it("repairs numbers and hearsay without inventing expanded numbers",async()=>{
 const reference="年3～4,000万とか貰ってたらしい。";let calls=0;
 await compose({...input,mode:"rewrite",references:[reference],instruction:"内容同じで",n:1},async(_s,u)=>{
  calls++;if(calls===1)return response([["年3,000～4,000万円貰っていた。"]]);
  expect(JSON.parse(u).feedback.join()).toContain("伝聞");return response([[reference]]);
 });expect(calls).toBe(2);
});
it("does not fail normal length/line-break changes and does reject headings/unwanted continuation",()=>{
 const request={...input,references:["Obsidian何がいいの？使い道ある？"]};
 expect(candidateIssues({key:"A",body:"マンジャロってどうなの？\n何から調べたらいい？",comments:[],hook:"",basis:""},request)).toEqual([]);
 const issues=candidateIssues({key:"A",body:"### ポイント1",comments:["続き"],hook:"",basis:""},request);
 expect(issues.join()).toContain("同じ1投稿");expect(issues.join()).toContain("Markdown");
});
it("keeps a short question short while allowing an explicit request for detail",()=>{
 const request={...input,references:["道具って何がいいの？使い道ある？"]};
 const candidate={key:"A",hook:"",basis:"",body:"質問に長い説明を足す。".repeat(20),comments:[]};
 expect(candidateIssues(candidate,request).join()).toContain("100文字以内");
 expect(candidateIssues(candidate,{...request,instruction:"詳しく解説して"})).toEqual([]);
});
it("repair attempts are bounded and return actionable validation errors",async()=>{
 const call=vi.fn(async()=>"invalid JSON");
 await expect(compose(input,call)).rejects.toMatchObject({category:"content_validation",retryable:true});expect(call).toHaveBeenCalledTimes(2);
});
it("information mode does not inherit a template and receives all sources",async()=>{
 const r=await compose({...input,mode:"information",references:[],sources:[{title:"資料",content:"a".repeat(8000)+"末尾の事実"}],n:1},async(_s,u)=>{
  const q=JSON.parse(u);expect(q.resolvedRules.postCount).toBeUndefined();expect(q.sources[0].content).toContain("末尾の事実");return response([["資料からの本文"]]);
 });expect(r.candidates).toHaveLength(1);
});
it("latest edited draft is the revision source, with the latest instruction taking priority",async()=>{
 const currentDraft={key:"B",body:"編集した本文",comments:[],hook:"",basis:""};
 const r=await compose({...input,currentDraft,instruction:"1投稿にまとめて",n:1},async(_s,u)=>{
  const q=JSON.parse(u);expect(q.operation).toBe("revise");expect(q.currentDraft.body).toBe("編集した本文");expect(q.reference.posts).toEqual([]);expect(q.resolvedRules.postCount).toBe(1);return response([["修正した本文"]]);
 });expect(r.candidates[0]!.comments).toEqual([]);
});
it("does not disable fact checks when the instruction says not to add facts",()=>{
 const issues=candidateIssues({key:"A",hook:"",basis:"",body:"年3000〜4000万円もらっていた。",comments:[]},{...input,mode:"rewrite",references:["年3～4,000万とか貰ってたらしい。"],instruction:"資料に事実があっても追加せず語順を自然にする"});
 expect(issues.join()).toContain("数値");expect(issues.join()).toContain("伝聞");
});
it("rewrites ending text as ordinary text, with no CTA-specific policy",async()=>{
 const r=await compose({...input,references:["導入【投稿2】説明。使い分け知りたい人は固定ポストから"],n:1},async(system,u)=>{
  expect(system).not.toContain("CTA");expect(JSON.parse(u).reference.posts[1]).toContain("固定ポスト");return response([["果物の選び方","詳しくはプロフィールへ"]]);
 });expect(r.candidates[0]!.comments).toEqual(["詳しくはプロフィールへ"]);
});
it("uniformly removes emojis, preserving rank meaning",()=>{
 expect(withoutEmoji("🥉ゴミ\n🥈便利\n🥇最強 👨‍👩‍👧‍👦🇯🇵👍🏽❤️")).toBe("3位 ゴミ\n2位 便利\n1位 最強");
});
it("preserves usable drafts when list-length repair fails, and explains the difference",async()=>{
 let calls=0;const r=await compose({...input,fidelity:90,n:1},async()=>{calls++;return response([["果物なら\n・りんご","・ぶどう"]]);});
 expect(calls).toBe(2);expect(r.candidates).toHaveLength(1);expect(r.candidates[0]!.body).toContain("りんご");expect(r.notes.join()).toContain("項目数が異なる");
});
it("also preserves usable drafts if their editorial repair hits a provider error",async()=>{
 let calls=0;const r=await compose({...input,fidelity:90,n:1},async()=>{if(++calls===1)return response([["果物なら\n・りんご","・ぶどう"]]);throw new AiError("AI_FAILED","timeout");});
 expect(r.candidates).toHaveLength(1);expect(r.notes.join()).toContain("項目数が異なる");
});
it("asks only when neither a new theme nor sources are supplied",async()=>{
 const call=vi.fn();const r=await compose({...input,instruction:""},call);expect(r.clarification).toBeDefined();expect(call).not.toHaveBeenCalled();
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
    await expect(pickedPosts(db, a, ["root"])).rejects.toThrow("本人のツリー");
    await db.run("UPDATE posts SET own_thread_json=? WHERE account_id=? AND id='root'",JSON.stringify({chain:[{id:"answer",text:"最強の答え"},{id:"later",text:"最後の誘導"}],parent:"later",complete:true,checkedAt:Date.now()}),a);
    const got = await pickedPosts(db, a, ["root"], ["answer", "later"]);
    expect(got).toEqual(["【投稿1】\n順位の導入\n\n【投稿2】\n最強の答え\n\n【投稿3】\n最後の誘導"]);
    expect(await pickedPosts(db, a, ["root"], [])).toEqual(got);
    expect(await pickedPosts(db, a, ["root"])).toEqual(got);
    await expect(pickedPosts(db, a, ["root"], ["secret"])).rejects.toThrow("本人のツリー以外");
    expect(await pickedPosts(db, a, ["secret"])).toEqual([]);
  });
});


it("recognizes blank lines and escaped usernames in a copied Threads tree",()=>{
 const first="導入\n\n🥉ゴミ\n\n"+Array.from({length:4},(_,i)=>`・項目${i}`).join("\n\n")+"\n\n🥈便利\n\n"+Array.from({length:4},(_,i)=>`・別項目${i}`).join("\n\n")+"\n\n🥇最強↓";
 const second="・続き1\n\n・続き2\n\n・続き3\n\n説明";
 const pasted=first+"&#x20;\r\n\r\n1\r\n\r\n/\r\n\r\n2\r\n\r\nyama\\_threads\r\n\r\n2日\r\n\r\n"+second;
 const normalized=normalizePastedThread(pasted);
 const parts=normalized.split("【投稿2】").map(p=>p.trim());
 expect(parts).toEqual([first,second]);
 expect(referenceShape({...input,references:[pasted]})!.partCount).toBe(2);
 expect(parts.map(p=>(p.match(/^・/gm)??[]).length)).toEqual([8,3]);
 expect(normalizePastedThread(normalized)).toBe(normalized);
 expect(normalizePastedThread("本文\n1\n/\n2\n続きの本文\n2日")).toBe("本文\n1\n/\n2\n続きの本文\n2日");
});

it("removes invented empty lines only when the reference has none, with an explicit layout override",async()=>{
 const draft="導入\n\n・一つ\n\n・二つ";
 const generated=async()=>response([[draft,"・答え"]]);
 const layoutInput={...input,fidelity:90,references:["元の導入\n・元A\n・元B\n【投稿2】\n・元の答え"]};
 const normal=await compose({...layoutInput,n:1},generated);expect(normal.candidates[0]!.body).toBe("導入\n・一つ\n・二つ");
 const spaced=await compose({...layoutInput,n:1,instruction:"空行を入れて"},generated);expect(spaced.candidates[0]!.body).toBe(draft);
 const originalSpace=await compose({...layoutInput,n:1,references:["元の導入\n\n・元A\n\n・元B【投稿2】・元の答え"]},generated);expect(originalSpace.candidates[0]!.body).toBe(draft);
});

it("repairs missing ranking headings without turning every line into a slot",async()=>{
 let calls=0;const ranks="3位 未整理\n・一つ\n2位 工夫\n・二つ\n1位 実用\n・三つ", corrected="3位 手軽\n・りんご\n2位 工夫\n・みかん\n1位 定番\n・ぶどう";
 const r=await compose({...input,fidelity:90,references:[ranks],n:1},async(_s,u)=>{
  const q=JSON.parse(u);expect(q.reference.layout[0].rankOrder).toEqual(["3位","2位","1位"]);
  if(++calls===1)return response([["・りんご\n・みかん\n・ぶどう"]]);
  expect(q.feedback.join()).toContain("順位の見出し");return response([[corrected]]);
 });expect(calls).toBe(2);expect(r.candidates[0]!.body).toBe(corrected);
});
