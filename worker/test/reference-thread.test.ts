import {it,expect,vi} from "vitest";
import {ownThread} from "../src/lib/reference-thread";
import {mediaToRow} from "../src/jobs/sync";
it("keeps self → self and stops at another author's reply",()=>{
 const replies=[{id:"self2",reply_to_id:"root"},{id:"self3",reply_to_id:"other"},{id:"self4",reply_to_id:"self3"}];
 expect(ownThread("root",replies).map(r=>r.id)).toEqual(["self2"]);
});
it("follows three own posts but never bridges unknown parents or cycles",()=>{
 expect(ownThread("root",[{id:"b",reply_to_id:"root"},{id:"c",reply_to_id:"b"},{id:"root",reply_to_id:"c"},{id:"d",reply_to_id:null}]).map(r=>r.id)).toEqual(["b","c"]);
});
it("sync preserves the direct target independently of the root",()=>{
 const row=mediaToRow("account",{id:"self3",is_reply:true,root_post:{id:"root"},replied_to:{id:"other"}},"Asia/Tokyo","2026-09-09T00:00:00Z");
 expect(row.slice(0,5)).toEqual(["account","self3","root","other",1]);
});

import {api,insertAccount,mockToken,registerUser,testDb} from "./helpers";
import {pickedPosts} from "../src/routes/ai";
it("API preview and generation use the same own chain, with account isolation",async()=>{
 const {userId,cookie}=await registerUser();const account=await insertAccount({userId,token:mockToken("chain")});const db=testDb();
 for(const [id,parent,reply,text] of [["root",null,0,"冒頭"],["self2","root",1,"本当の続き"],["self3","other",1,"他人への返信"],["self4","self3",1,"会話の続き"]] as const) {
   await db.run("INSERT INTO posts(account_id,id,root_id,reply_to_id,is_reply,text,posted_at) VALUES (?,?,'root',?,?,?,?)",account,id,parent,reply,text,"2026-09-09T00:00:00Z");
 }
 await db.run("UPDATE posts SET own_thread_json=? WHERE account_id=? AND id='root'",JSON.stringify({chain:[{id:"self2",text:"本当の続き"}],parent:"self2",complete:true,checkedAt:Date.now()}),account);
 const result=await api("GET",`/api/accounts/${account}/posts/root/reference`,{cookie});
 expect(result.status).toBe(200);expect(result.body.data.post.children.map((p:{id:string})=>p.id)).toEqual(["self2"]);expect(result.body.data.excludedReplies).toBe(2);
 expect(await pickedPosts(db,account,["root"])).toEqual(["【投稿1】\n冒頭\n\n【投稿2】\n本当の続き"]);
 for (const suffix of ["posts", "posts/root", "dashboard?period=all"]) {
  const response=await api("GET",`/api/accounts/${account}/${suffix}`,{cookie});
  expect(response.status).toBe(200);
  const post=response.body.data.post ?? response.body.data.posts.find((p:{id:string})=>p.id==="root");
  expect(post.children.map((p:{id:string})=>p.id)).toEqual(["self2"]);
 }
 const other=await registerUser();expect((await api("GET",`/api/accounts/${account}/posts/root/reference`,{cookie:other.cookie})).status).toBe(404);
});

import {advanceOwnTree,resolveOwnTree,type OwnTree} from "../src/lib/reference-thread";
import * as threads from "../src/lib/threads";
import {loadAccount} from "../src/lib/accounts";
import {createBudget} from "../src/lib/budget";
import {env} from "cloudflare:test";
const initial=():OwnTree=>({chain:[],parent:"root",complete:false,checkedAt:0});
const self=(id:string,parent:string,time="2026-09-09T00:00:00Z")=>({id,text:id,timestamp:time,replied_to:{id:parent},username:"owner",is_reply_owned_by_me:true});
it("filters other authors, their own descendants, and later sibling replies",()=>{
 const first=advanceOwnTree(initial(),{data:[{...self("other","root"),is_reply_owned_by_me:false},self("conversation","other"),self("late","root","2026-09-09T01:00:00Z"),self("b","root")]},"owner");
 expect(first.chain.map(p=>p.id)).toEqual(["b"]);
 const second=advanceOwnTree(first,{data:[self("c","b"),{...self("stranger","b"),username:"stranger",is_reply_owned_by_me:false}]},"owner");
 expect(second.chain.map(p=>p.id)).toEqual(["b","c"]);
 expect(advanceOwnTree(second,{data:[]},"owner").complete).toBe(true);
});
it("checks all pages before picking the earliest, and resumes at that child",()=>{
 const page1=advanceOwnTree(initial(),{data:[self("late","root","2026-09-09T01:00:00Z")],paging:{next:"ignored-url",cursors:{after:"cursor"}}},"owner");
 expect(page1.chain).toEqual([]);expect(page1.after).toBe("cursor");
 const page2=advanceOwnTree(page1,{data:[self("early","root")]},"owner");
 expect(page2.chain.map(p=>p.id)).toEqual(["early"]);expect(page2.after).toBeUndefined();expect(page2.complete).toBe(false);
});
it("ownership unknown is excluded, username fallback is case-insensitive, and explicit false wins",()=>{
 expect(advanceOwnTree(initial(),{data:[{id:"unknown",timestamp:self("a","root").timestamp}]},"owner").chain).toEqual([]);
 expect(advanceOwnTree(initial(),{data:[{...self("b","root"),username:"OWNER",is_reply_owned_by_me:undefined}]},"owner").chain.map(p=>p.id)).toEqual(["b"]);
 expect(advanceOwnTree(initial(),{data:[{...self("b","root"),is_reply_owned_by_me:false}]},"owner").chain).toEqual([]);
});
it("malformed pagination and timestamps cannot silently truncate the tree",()=>{
 expect(()=>advanceOwnTree(initial(),{data:[],paging:{next:"next"}},"owner")).toThrow("次ページ");
 expect(()=>advanceOwnTree(initial(),{data:[{...self("b","root"),timestamp:undefined}]},"owner")).toThrow("日時");
});
it("legacy replies stay hidden; live resolution persists progress and failures remain retryable",async()=>{
 const {userId,cookie}=await registerUser();const accountId=await insertAccount({userId,token:mockToken("live-tree")});const db=testDb();
 await db.run("INSERT INTO posts(account_id,id,root_id,text,posted_at) VALUES (?,'root','root','冒頭',?)",accountId,new Date().toISOString());
 await db.run("INSERT INTO posts(account_id,id,root_id,is_reply,text,posted_at) VALUES (?,'other','root',1,'他人',?)",accountId,new Date().toISOString());
 const list=await api("GET",`/api/accounts/${accountId}/posts`,{cookie});expect(list.body.data.posts[0].children).toEqual([]);expect(list.body.data.posts[0].treeStatus).toBe("pending");
 const account=(await loadAccount(db,accountId))!;
 const spy=vi.spyOn(threads,"call");
 try {
  spy.mockResolvedValueOnce({data:[self("b","root")]});
  const one=await api("GET",`/api/accounts/${accountId}/posts/root/tree`,{cookie});
  expect(one.status).toBe(200);expect(one.body.data.pending).toBe(true);expect(one.body.data.post.children).toEqual([]);
  const root=(await db.first<{id:string;own_thread_json:string}>("SELECT id,own_thread_json FROM posts WHERE account_id=? AND id='root'",accountId))!;
  spy.mockRejectedValueOnce(new Error("temporary failure"));
  await expect(resolveOwnTree(db,account,root,{budget:createBudget(),env})).rejects.toThrow("temporary failure");
  expect((await db.first<{own_thread_json:string}>("SELECT own_thread_json FROM posts WHERE account_id=? AND id='root'",accountId))!.own_thread_json).toBe(root.own_thread_json);
  spy.mockResolvedValueOnce({data:[]});
  const done=await api("GET",`/api/accounts/${accountId}/posts/root/tree`,{cookie});
  expect(done.body.data.pending).toBe(false);expect(done.body.data.post.children.map((p:{id:string})=>p.id)).toEqual(["b"]);
  expect(spy.mock.calls[2]![2]).toBe("/b/replies");
 } finally {spy.mockRestore();}
});
