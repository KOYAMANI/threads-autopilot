import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";
import callback, { type CallbackEnv, verifySignedRequest } from "../../callbacks/src/index";

const bindings = env as unknown as { DB_PRODUCTION:D1Database; DB_STAGING:D1Database; TEST_META_CALLBACK_MIGRATIONS:D1Migration[] };
const SECRET = "synthetic-meta-app-secret-for-isolated-tests-only";
const ORIGIN = "https://privacy.example.test";
const OLD = "2025-01-01T00:00:00.000Z";
const EVENT = Date.parse("2025-02-01T00:00:00.000Z") / 1000;
const FRESH = "2025-03-01T00:00:00.000Z";
const cenv:CallbackEnv = { ...bindings, THREADS_APP_SECRET:SECRET, CALLBACK_ORIGIN:ORIGIN };
const DBS = [bindings.DB_PRODUCTION,bindings.DB_STAGING];
const TABLES = ["posts","post_metrics_history","queue","learning","links","autopilot","jobs","daily_views","follower_snapshots","click_weeks","click_weeks_done","demographics","ap_log"];
beforeAll(async () => {
  await applyD1Migrations(bindings.DB_PRODUCTION,env.TEST_MIGRATIONS.filter(m => m.name < "0007"));
  await applyD1Migrations(bindings.DB_STAGING,env.TEST_MIGRATIONS);
  for (const db of DBS) await applyD1Migrations(db,bindings.TEST_META_CALLBACK_MIGRATIONS);
});
const run = (db:D1Database,sql:string,...args:(string|number|null)[]) => db.prepare(sql).bind(...args).run();
const first = <T=Record<string,unknown>>(db:D1Database,sql:string,...args:(string|number|null)[]) => db.prepare(sql).bind(...args).first<T>();
async function count(db:D1Database,table:string,account?:string) {
  return (await first<{n:number}>(db,`SELECT COUNT(*) AS n FROM ${table}${account ? " WHERE account_id=?" : ""}`,...(account ? [account] : [])))!.n;
}
function b64(bytes:Uint8Array):string { return btoa(String.fromCharCode(...bytes)).replace(/=/g,"").replace(/\+/g,"-").replace(/\//g,"_"); }
async function signed(payload:Record<string,unknown>,secret=SECRET):Promise<string> {
  const encoded=b64(new TextEncoder().encode(JSON.stringify(payload)));
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  return `${b64(new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(encoded))))}.${encoded}`;
}
async function request(path:string,userId:string,opts:{issued?:number; env?:CallbackEnv; signed?:string}={}) {
  const value=opts.signed ?? await signed({algorithm:"HMAC-SHA256",user_id:userId,issued_at:opts.issued ?? EVENT});
  return callback.fetch(new Request(ORIGIN+path,{method:"POST",body:new URLSearchParams({signed_request:value})}),opts.env??cenv);
}
async function seed(db:D1Database,subject:string,at=OLD) {
  const id=crypto.randomUUID(), uid=crypto.randomUUID(), qid=crypto.randomUUID();
  await run(db,"INSERT INTO users(id,email,pass_hash,pass_salt,license_id,created_at) VALUES (?,?,?,?,?,?)",uid,`${uid}@example.test`,"dummy","salt",uid,OLD);
  await run(db,"INSERT INTO ai_settings(user_id,provider,key_enc,updated_at) VALUES (?,'gemini','dummy-ai',?)",uid,OLD);
  await run(db,"INSERT INTO accounts(id,user_id,threads_user_id,username,color,token_enc,token_obtained_at,token_long_lived,created_at) VALUES (?,?,?,'synthetic','#000','dummy-token',?,1,?)",id,uid,subject,at,OLD);
  await run(db,"INSERT INTO posts(account_id,id,root_id,text,posted_at) VALUES (?,'p','p','synthetic post',?)",id,OLD);
  await run(db,"INSERT INTO post_metrics_history(account_id,post_id,checkpoint,at) VALUES (?,'p','48h',?)",id,OLD);
  await run(db,"INSERT INTO queue(id,account_id,status,body,created_at,updated_at) VALUES (?,?,'scheduled','synthetic draft',?,?)",qid,id,OLD,OLD);
  await run(db,"INSERT INTO autopilot(account_id,enabled,updated_at) VALUES (?,1,?)",id,OLD);
  await run(db,"INSERT INTO links(id,account_id,url,label,created_at) VALUES (?,?,'https://example.test','synthetic link',?)",crypto.randomUUID(),id,OLD);
  await run(db,"INSERT INTO jobs(id,account_id,type,next_run_at,created_at,updated_at) VALUES (?,?,'full_sync',?,?,?)",crypto.randomUUID(),id,OLD,OLD,OLD);
  await run(db,"INSERT INTO daily_views(account_id,date,views) VALUES (?,'2025-01-01',1)",id);
  await run(db,"INSERT INTO follower_snapshots(account_id,date,followers) VALUES (?,'2025-01-01',1)",id);
  await run(db,"INSERT INTO click_weeks(account_id,week_end,url,clicks,fetched_at) VALUES (?,'2025-01-01','https://example.test',1,?)",id,OLD);
  await run(db,"INSERT INTO click_weeks_done(account_id,week_end) VALUES (?,'2025-01-01')",id);
  await run(db,"INSERT INTO demographics(account_id,breakdown,json,fetched_at) VALUES (?,'country','{}',?)",id,OLD);
  await run(db,"INSERT INTO learning(account_id,dim,value,updated_at) VALUES (?,'hook','test',?)",id,OLD);
  await run(db,"INSERT INTO ap_log(id,account_id,at,kind,message) VALUES (?,?,?,'test','synthetic')",crypto.randomUUID(),id,OLD);
  await run(db,"INSERT INTO audit_log(id,user_id,at,action,detail) VALUES (?,?,?,'account_connect',?)",crypto.randomUUID(),uid,OLD,JSON.stringify({accountId:id}));
  return {id,uid,qid};
}
// Match the old production maintenance SQL exactly. This is intentionally NOT a reconnect.
function refresh(db:D1Database,id:string,at:string) {
  return run(db,"UPDATE accounts SET token_enc=?, token_obtained_at=?, token_last_refresh_at=?, token_long_lived=1 WHERE id=?","refreshed-token",at,at,id);
}
// The existing connect route distinguishes a new grant by nulling the refresh time.
function reconnect(db:D1Database,id:string,at=FRESH) {
  return run(db,"UPDATE accounts SET username=?, name=?, avatar_url=?, token_enc=?, token_obtained_at=?, token_long_lived=?, token_last_refresh_at=NULL, status='ok' WHERE id=?","reconnected",null,null,"fresh-token",at,1,id);
}

describe("dedicated Meta callbacks",() => {
  it("never touches either DB for GET reachability, unsigned/forged/malformed requests",async () => {
    const prepare=vi.fn(()=>{throw new Error("must not access DB");});
    const db={prepare} as unknown as D1Database;
    const noDb={...cenv,DB_PRODUCTION:db,DB_STAGING:db};
    for(const path of ["/deauthorize","/data-deletion"]) {
      expect((await callback.fetch(new Request(ORIGIN+path),noDb)).status).toBe(200);
      expect((await callback.fetch(new Request(ORIGIN+path,{method:"POST",body:new URLSearchParams()}),noDb)).status).toBe(400);
    }
    const invalid = [
      await signed({algorithm:"HMAC-SHA256",user_id:"900001",issued_at:EVENT},"wrong-secret"),
      await signed({algorithm:"none",user_id:"900001",issued_at:EVENT}),
      await signed({algorithm:"HMAC-SHA256",user_id:"900001"}),
      await signed({algorithm:"HMAC-SHA256",user_id:900001,issued_at:EVENT}),
      await signed({algorithm:"HMAC-SHA256",user_id:"900001 OR 1=1",issued_at:EVENT}),
      await signed({algorithm:"HMAC-SHA256",user_id:"900001",issued_at:1e15}),
      "x.y", "", "a".repeat(17_000),
    ];
    for(const value of invalid) expect((await request("/data-deletion","900001",{signed:value,env:noDb})).status).toBe(400);
    const value=await signed({algorithm:"HMAC-SHA256",user_id:"900001",issued_at:EVENT});
    expect((await callback.fetch(new Request(ORIGIN+"/data-deletion",{method:"POST",body:new URLSearchParams([["signed_request",value],["signed_request",value]])}),noDb)).status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  });
  it("verifies raw encoded payload and orders callbacks at second precision",async () => {
    const value=await signed({algorithm:"HMAC-SHA256",user_id:"900002",issued_at:EVENT});
    expect(await verifySignedRequest(value,SECRET)).toMatchObject({userId:"900002",cutoff:"2025-02-01T00:00:00.999Z"});
    await expect(verifySignedRequest(value.replace(".",".A"),SECRET)).rejects.toThrow();
    await expect(verifySignedRequest(await signed({algorithm:"HMAC-SHA256",user_id:"900002",issued_at:EVENT+301}),SECRET,EVENT*1000)).rejects.toThrow();
  });
  it("revokes all matching grants in both schemas, preserving unrelated users and retained analytics",async () => {
    const fixtures=[];
    for(const db of DBS) fixtures.push({db,one:await seed(db,"900010"),two:await seed(db,"900010"),other:await seed(db,"900011"),fresh:await seed(db,"900010",FRESH)});
    expect((await request("/deauthorize","900010")).status).toBe(200);
    for(const {db,one,two,other,fresh} of fixtures) {
      for(const f of [one,two]) {
        expect(await first(db,"SELECT token_enc,status FROM accounts WHERE id=?",f.id)).toEqual({token_enc:"",status:"needs_reauth"});
        expect(await first(db,"SELECT enabled FROM autopilot WHERE account_id=?",f.id)).toEqual({enabled:0});
        expect(await first(db,"SELECT status FROM queue WHERE id=?",f.qid)).toEqual({status:"cancelled"});
        expect(await count(db,"jobs",f.id)).toBe(0);
        expect(await count(db,"posts",f.id)).toBe(1);
        expect(await first(db,"SELECT id FROM users WHERE id=?",f.uid)).toBeTruthy();
        expect(await first(db,"SELECT key_enc FROM ai_settings WHERE user_id=?",f.uid)).toEqual({key_enc:"dummy-ai"});
      }
      for(const f of [other,fresh]) expect(await first(db,"SELECT token_enc FROM accounts WHERE id=?",f.id)).toEqual({token_enc:"dummy-token"});
    }
    expect((await request("/deauthorize","900010")).status).toBe(200);
  });
  it("deletes all 13 child tables atomically in schema0005 and cascades schema0009 schedules",async () => {
    const p=await seed(DBS[0]!,"900020"), s=await seed(DBS[1]!,"900020");
    const other=await seed(DBS[0]!,"900021");
    await run(DBS[1]!,"INSERT INTO posting_schedules(account_id,times_json,updated_at) VALUES (?,'[]',?)",s.id,OLD);
    await run(DBS[1]!,"INSERT INTO posting_slot_reservations(account_id,scheduled_at,queue_id,reservation_key,source,local_day) VALUES (?,?,?,?, 'manual','2025-01-01')",s.id,OLD,s.qid,s.qid);
    await run(DBS[0]!,"INSERT INTO audit_log(id,at,action,detail) VALUES ('bad-json',?,'test','{broken')",OLD);
    expect(await first(DBS[0]!,"SELECT name FROM sqlite_master WHERE name='posting_schedules'")).toBeNull();
    const response=await request("/data-deletion","900020");
    expect(response.status).toBe(200);
    for(const [db,f] of [[DBS[0]!,p],[DBS[1]!,s]] as const) {
      for(const table of TABLES) expect(await count(db,table,f.id)).toBe(0);
      expect(await first(db,"SELECT id FROM accounts WHERE id=?",f.id)).toBeNull();
      expect(await count(db,"meta_account_grants",f.id)).toBe(0);
      expect(await first(db,"SELECT id FROM audit_log WHERE detail=?",JSON.stringify({accountId:f.id}))).toBeNull();
      expect(await first(db,"SELECT id FROM users WHERE id=?",f.uid)).toBeTruthy();
    }
    expect(await count(DBS[1]!,"posting_schedules",s.id)).toBe(0);
    expect(await count(DBS[1]!,"posting_slot_reservations",s.id)).toBe(0);
    expect(await count(DBS[0]!,"posts",other.id)).toBe(1);
    expect(await first(DBS[0]!,"SELECT id FROM audit_log WHERE id='bad-json'")).toBeTruthy();
    const receipt=await response.json() as {url:string;confirmation_code:string};
    expect(receipt.url).toBe(ORIGIN+"/deletion-status?code="+receipt.confirmation_code);
    expect(receipt.confirmation_code).toMatch(/^1[0-9a-f]{128}$/);
    expect(JSON.stringify(receipt)).not.toContain("900020");
    expect((await callback.fetch(new Request(receipt.url),cenv)).status).toBe(200);
    expect((await callback.fetch(new Request(receipt.url.slice(0,-1)+"z"),cenv)).status).toBe(404);
    expect(await (await request("/data-deletion","900020")).json()).toEqual(receipt);
  });
  it.each([0,1])("rejects old grant resurrection and delayed account-owned writes in DB%d",async index => {
    const db=DBS[index]!, f=await seed(db,`900030${index}`);
    expect((await request("/data-deletion",`900030${index}`)).status).toBe(200);
    const writes=[
      ["INSERT INTO posts(account_id,id,root_id,posted_at) VALUES (?,'late','late',?)",f.id,OLD],
      ["INSERT INTO links(id,account_id,url,label,created_at) VALUES ('late',?,'https://example.test','late',?)",f.id,OLD],
      ["INSERT INTO queue(id,account_id,status,body,created_at,updated_at) VALUES ('late',?,'scheduled','late',?,?)",f.id,OLD,OLD],
      ["INSERT INTO autopilot(account_id,enabled,updated_at) VALUES (?,1,?)",f.id,OLD],
      ["INSERT INTO jobs(id,account_id,type,next_run_at,created_at,updated_at) VALUES ('late',?,'full_sync',?,?,?)",f.id,OLD,OLD,OLD],
      ["INSERT INTO audit_log(id,at,action,detail) VALUES ('late',?,'test',?)",OLD,JSON.stringify({accountId:f.id})],
    ];
    for(const [sql,...values] of writes) await expect(run(db,sql!,...values)).rejects.toThrow("META_ACCOUNT_UNAVAILABLE");
    await expect(seed(db,`900030${index}`)).rejects.toThrow("META_ACCOUNT_REVOKED");
    const fresh=await seed(db,`900030${index}`,FRESH);
    expect((await request("/data-deletion",`900030${index}`)).status).toBe(200);
    expect(await count(db,"posts",fresh.id)).toBe(1);
  });
  it.each([0,1])("refresh-before-callback never changes authorization cutoff, DB%d",async index => {
    const db=DBS[index]!,f=await seed(db,`900040${index}`);
    await refresh(db,f.id,FRESH); // Callback arrives late, after the token was automatically extended.
    expect(await first(db,"SELECT granted_at FROM meta_account_grants WHERE account_id=?",f.id)).toEqual({granted_at:OLD});
    expect((await request("/deauthorize",`900040${index}`)).status).toBe(200);
    expect(await first(db,"SELECT token_enc FROM accounts WHERE id=?",f.id)).toEqual({token_enc:""});
    await expect(refresh(db,f.id,"2025-04-01T00:00:00.000Z")).rejects.toThrow("META_ACCOUNT_REVOKED");
    expect((await request("/data-deletion",`900040${index}`)).status).toBe(200);
    expect(await first(db,"SELECT id FROM accounts WHERE id=?",f.id)).toBeNull();
  });
  it.each([0,1])("fresh explicit reconnect survives old revoke/delete and stale refresh, DB%d",async index => {
    const db=DBS[index]!,f=await seed(db,`900050${index}`);
    expect((await request("/deauthorize",`900050${index}`)).status).toBe(200);
    await expect(run(db,"UPDATE queue SET status='scheduled' WHERE id=?",f.qid)).rejects.toThrow("META_ACCOUNT_UNAVAILABLE");
    await reconnect(db,f.id);
    expect(await first(db,"SELECT granted_at FROM meta_account_grants WHERE account_id=?",f.id)).toEqual({granted_at:FRESH});
    await expect(refresh(db,f.id,"2025-02-15T00:00:00.000Z")).rejects.toThrow("META_ACCOUNT_REVOKED");
    expect((await request("/deauthorize",`900050${index}`)).status).toBe(200);
    expect((await request("/data-deletion",`900050${index}`)).status).toBe(200);
    expect(await first(db,"SELECT token_enc,status FROM accounts WHERE id=?",f.id)).toEqual({token_enc:"fresh-token",status:"ok"});
    expect(await count(db,"posts",f.id)).toBe(1); // Retained history transfers with this new grant; not old-grant lineage deletion.
    expect(await first(db,"SELECT enabled FROM autopilot WHERE account_id=?",f.id)).toEqual({enabled:0});
    await run(db,"UPDATE queue SET body='new draft' WHERE id=?",f.qid);
    await refresh(db,f.id,"2025-04-01T00:00:00.000Z");
    expect(await first(db,"SELECT granted_at FROM meta_account_grants WHERE account_id=?",f.id)).toEqual({granted_at:FRESH});
  });
  it("does not issue a completion receipt until BOTH DBs succeeded and makes partial failures retryable",async () => {
    const prod=await seed(DBS[0]!,"900060"),stage=await seed(DBS[1]!,"900060");
    const failStage={prepare:DBS[1]!.prepare.bind(DBS[1]),batch:vi.fn().mockRejectedValue(new Error("synthetic failure"))} as unknown as D1Database;
    const failed=await request("/data-deletion","900060",{env:{...cenv,DB_STAGING:failStage}});
    expect(failed.status).toBe(503);
    expect(await failed.json()).not.toHaveProperty("confirmation_code");
    expect(await first(DBS[0]!,"SELECT id FROM accounts WHERE id=?",prod.id)).toBeNull();
    expect(await first(DBS[1]!,"SELECT id FROM accounts WHERE id=?",stage.id)).toBeTruthy();
    expect((await request("/data-deletion","900060")).status).toBe(200);
    expect(await first(DBS[1]!,"SELECT id FROM accounts WHERE id=?",stage.id)).toBeNull();
  });
  it("rolls back the cutoff and all preceding table deletes if a DB transaction fails",async () => {
    const db=DBS[0]!,f=await seed(db,"900070");
    await run(db,"CREATE TRIGGER synthetic_abort_delete BEFORE DELETE ON accounts BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    expect((await request("/data-deletion","900070")).status).toBe(503);
    expect(await count(db,"posts",f.id)).toBe(1);
    expect(await count(db,"jobs",f.id)).toBe(1);
    expect(await first(db,"SELECT threads_user_id FROM meta_subject_cutoffs WHERE threads_user_id='900070'")).toBeNull();
    await run(db,"DROP TRIGGER synthetic_abort_delete");
    expect((await request("/data-deletion","900070")).status).toBe(200);
  });
  it("allows ordinary connected or expired-token edits and global jobs/audits",async () => {
    for(const db of DBS) {
      const f=await seed(db,"900080");
      await run(db,"UPDATE accounts SET status='needs_reauth' WHERE id=?",f.id);
      await run(db,"UPDATE posts SET views=10 WHERE account_id=?",f.id);
      await run(db,"UPDATE queue SET body='edited' WHERE id=?",f.qid);
      await run(db,"UPDATE links SET label='edited' WHERE account_id=?",f.id);
      await run(db,"UPDATE autopilot SET enabled=0 WHERE account_id=?",f.id);
      await run(db,"INSERT INTO jobs(id,type,next_run_at,created_at,updated_at) VALUES (?,'cleanup',?,?,?)",crypto.randomUUID(),OLD,OLD,OLD);
      await run(db,"INSERT INTO audit_log(id,at,action,detail) VALUES (?,?,'login','{}')",crypto.randomUUID(),OLD);
      expect(await first(db,"SELECT views FROM posts WHERE account_id=?",f.id)).toEqual({views:10});
    }
  });
  it("fixed callback origin and completion pages do not reflect untrusted hosts or user IDs",async () => {
    const value=await signed({algorithm:"HMAC-SHA256",user_id:"900090",issued_at:EVENT});
    const res=await callback.fetch(new Request("https://attacker.example/data-deletion",{method:"POST",body:new URLSearchParams({signed_request:value})}),cenv);
    const receipt=await res.json() as {url:string};
    expect(receipt.url.startsWith(ORIGIN+"/")).toBe(true);
    const status=await callback.fetch(new Request(receipt.url),cenv);
    expect(status.headers.get("Cache-Control")).toBe("no-store");
    expect(await status.text()).toContain("稼働中データベース内");
    expect((await callback.fetch(new Request(ORIGIN+"/deauthorize"),{...cenv,CALLBACK_ORIGIN:"http://insecure.test"})).status).toBe(503);
  });
});
