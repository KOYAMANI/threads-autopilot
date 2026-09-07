/** Dedicated Meta privacy callbacks. No app sessions, encryption key, AI or posting code. */
export type CallbackEnv = {
  DB_PRODUCTION: D1Database;
  DB_STAGING: D1Database;
  THREADS_APP_SECRET: string;
  CALLBACK_ORIGIN: string;
};

type VerifiedRequest = { userId: string; issuedAt: number; cutoff: string; fingerprint: string };
const ACCOUNT_TABLES = [
  "posts", "post_metrics_history", "queue", "learning", "links", "autopilot", "jobs",
  "daily_views", "follower_snapshots", "click_weeks", "click_weeks_done", "demographics", "ap_log",
] as const;
const MAX_BODY_BYTES = 16_384;
const encoder = new TextEncoder();
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
class InvalidRequest extends Error {}

function bytesFromBase64Url(input: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(input)) throw new InvalidRequest();
  const unpadded = input.replace(/=+$/, "");
  const raw = atob(unpadded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4-unpadded.length%4)%4));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
function hex(bytes: Uint8Array): string { return [...bytes].map(b => b.toString(16).padStart(2,"0")).join(""); }
function equal(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i=0;i<Math.max(a.length,b.length);i++) diff |= (a[i]??0) ^ (b[i]??0);
  return diff===0;
}
async function mac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}
async function fingerprint(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(value))));
}
async function boundedBody(request: Request): Promise<string> {
  const length = Number(request.headers.get("Content-Length") ?? 0);
  if (!Number.isFinite(length) || length>MAX_BODY_BYTES) throw new InvalidRequest();
  if (!request.body) throw new InvalidRequest();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size>MAX_BODY_BYTES) { await reader.cancel(); throw new InvalidRequest(); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(size);
  let offset=0; for (const chunk of chunks) { all.set(chunk,offset); offset+=chunk.length; }
  return new TextDecoder("utf-8",{fatal:true,ignoreBOM:false}).decode(all);
}

export async function verifySignedRequest(value: string, secret: string, nowMs=Date.now()): Promise<VerifiedRequest> {
  try {
    if (!value || value.length>MAX_BODY_BYTES || !secret) throw new InvalidRequest();
    const parts=value.split(".");
    if (parts.length!==2) throw new InvalidRequest();
    const signature=bytesFromBase64Url(parts[0]!);
    const payload=parts[1]!;
    if (signature.length!==32 || !equal(signature,await mac(secret,payload))) throw new InvalidRequest();
    const data=JSON.parse(new TextDecoder("utf-8",{fatal:true,ignoreBOM:false}).decode(bytesFromBase64Url(payload))) as Record<string,unknown>;
    if (data?.algorithm!=="HMAC-SHA256" || typeof data.user_id!=="string" || !/^[0-9]{1,32}$/.test(data.user_id)) throw new InvalidRequest();
    // Required event ordering: never substitute receipt time when issued_at is missing.
    // Old authenticated retries remain valid; the persisted cutoff protects newer grants.
    if (typeof data.issued_at!=="number" || !Number.isSafeInteger(data.issued_at) || data.issued_at<=0 || data.issued_at>Math.floor(nowMs/1000)+300) throw new InvalidRequest();
    // Meta timestamps have second precision. Include the entire issued second.
    const cutoff=new Date(data.issued_at*1000+999).toISOString();
    return {userId:data.user_id,issuedAt:data.issued_at,cutoff,fingerprint:await fingerprint(value)};
  } catch { throw new InvalidRequest(); }
}

const TARGET = "SELECT id FROM accounts WHERE threads_user_id=? AND id IN (SELECT account_id FROM meta_account_grants WHERE granted_at<=?)";
function statement(db:D1Database, sql:string, ...values:unknown[]) { return db.prepare(sql).bind(...values as never[]); }
async function applyCallback(db:D1Database, event:VerifiedRequest, deletion:boolean):Promise<void> {
  const target = [event.userId,event.cutoff];
  const pending = [statement(db,`INSERT INTO meta_subject_cutoffs(threads_user_id,blocked_before,delete_before) VALUES (?,?,?)
    ON CONFLICT(threads_user_id) DO UPDATE SET
      blocked_before=MAX(meta_subject_cutoffs.blocked_before,excluded.blocked_before),
      delete_before=CASE WHEN excluded.delete_before IS NULL THEN meta_subject_cutoffs.delete_before
        ELSE MAX(COALESCE(meta_subject_cutoffs.delete_before,''),excluded.delete_before) END`,
    event.userId,event.cutoff,deletion?event.cutoff:null)];
  if (deletion) {
    // Resolve targets inside the same transaction as deletion, never from an earlier SELECT.
    for (const table of ACCOUNT_TABLES) pending.push(statement(db,`DELETE FROM ${table} WHERE account_id IN (${TARGET})`,...target));
    pending.push(statement(db,`DELETE FROM audit_log WHERE CASE WHEN json_valid(detail) THEN json_extract(detail,'$.accountId') END IN (${TARGET})`,...target));
    pending.push(statement(db,`DELETE FROM accounts WHERE id IN (${TARGET})`,...target));
    // Stage-only posting schedules/reservations cascade from accounts. No reference
    // to those tables here: production schema 0005 does not have them.
  } else {
    // These updates precede token removal so normal guard checks remain effective.
    // Already-revoked rows are no-ops on retry; their guard forbids new child writes.
    const activeTarget = `${TARGET} AND token_enc<>''`;
    pending.push(statement(db,`UPDATE autopilot SET enabled=0,updated_at=? WHERE account_id IN (${activeTarget})`,new Date().toISOString(),...target));
    pending.push(statement(db,`UPDATE queue SET status='cancelled',next_step_at=NULL,updated_at=?
      WHERE account_id IN (${activeTarget}) AND status IN ('pending_approval','scheduled','publishing')`,new Date().toISOString(),...target));
    pending.push(statement(db,`DELETE FROM jobs WHERE account_id IN (${TARGET})`,...target));
    pending.push(statement(db,`UPDATE accounts SET status='needs_reauth',token_enc='',token_long_lived=0,token_last_refresh_at=NULL
      WHERE id IN (${TARGET})`,...target));
  }
  await db.batch(pending);
}

async function completionCode(event:VerifiedRequest, secret:string):Promise<string> {
  // Stable, opaque and alphanumeric. No user ID, signed payload, token or profile
  // data is encoded in the receipt. Domain separation prevents signature reuse.
  const tag=hex(await mac(secret,`tap-meta-deletion-completed:v1|${event.fingerprint}`));
  return `1${event.fingerprint}${tag}`;
}
async function validCompletionCode(code:string, secret:string):Promise<boolean> {
  if (!/^1[0-9a-f]{128}$/.test(code)) return false;
  const expected=await mac(secret,`tap-meta-deletion-completed:v1|${code.slice(1,65)}`);
  const given=Uint8Array.from(code.slice(65).match(/../g)!,p=>Number.parseInt(p,16));
  return equal(given,expected);
}
function json(value:unknown,status=200):Response {
  return new Response(JSON.stringify(value),{status,headers:{...headers,"Content-Type":"application/json; charset=utf-8"}});
}
function page(message:string,status=200):Response {
  return new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Threads アプリのデータ削除</title><main><h1>Threads アプリのデータ削除</h1><p>${message}</p></main></html>`,
    {status,headers:{...headers,"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":"default-src 'none'; frame-ancestors 'none'; base-uri 'none'"}});
}
export default {
  async fetch(request:Request,env:CallbackEnv):Promise<Response> {
    const url=new URL(request.url);
    if (!env.THREADS_APP_SECRET || !env.CALLBACK_ORIGIN) return json({error:"Callback configuration unavailable"},503);
    let origin:URL;
    try { origin=new URL(env.CALLBACK_ORIGIN); if (origin.protocol!=="https:" || origin.username || origin.password || origin.pathname!=="/" || origin.search || origin.hash) throw new Error(); }
    catch { return json({error:"Callback configuration unavailable"},503); }
    if (url.pathname==="/deletion-status") {
      if (request.method!=="GET") return json({error:"Method not allowed"},405);
      return await validCompletionCode(url.searchParams.get("code")??"",env.THREADS_APP_SECRET)
        ? page("この削除要求の対象となった、稼働中データベース内のThreads連携データの削除処理が完了しています。要求後に同じアカウントを再接続した場合、そのアカウントに引き継がれた既存投稿を含むデータは対象外です。バックアップや利用者が外部へ保存したコピーも含みません。")
        : page("有効な削除確認コードを確認できませんでした。",404);
    }
    if (url.pathname!=="/deauthorize" && url.pathname!=="/data-deletion") return json({error:"Not found"},404);
    // Reachability checks may GET the configured URL. GET never alters app data.
    if (request.method==="GET" || request.method==="HEAD") return page("Metaからの署名付きリクエストを受け付ける窓口です。このページを開くだけでは解除・削除は実行されません。");
    if (request.method!=="POST") return json({error:"Method not allowed"},405);
    if (!(request.headers.get("Content-Type")??"").toLowerCase().startsWith("application/x-www-form-urlencoded")) return json({error:"Expected a signed form request"},415);
    let event:VerifiedRequest;
    try {
      const form=new URLSearchParams(await boundedBody(request));
      const values=form.getAll("signed_request");
      if(values.length!==1) throw new InvalidRequest();
      event=await verifySignedRequest(values[0]!,env.THREADS_APP_SECRET);
    } catch { return json({error:"Invalid signed request"},400); }
    const deletion=url.pathname==="/data-deletion";
    try {
      // Each batch is atomic. Across DBs partial success returns 503; Meta can
      // safely retry the identical signed request without touching a newer grant.
      await applyCallback(env.DB_PRODUCTION,event,deletion);
      await applyCallback(env.DB_STAGING,event,deletion);
      if (!deletion) return json({success:true});
      const code=await completionCode(event,env.THREADS_APP_SECRET);
      return json({url:`${origin.origin}/deletion-status?code=${code}`,confirmation_code:code});
    } catch { return json({error:"Callback processing incomplete; retry required"},503); }
  },
};
