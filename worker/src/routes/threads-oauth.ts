import { Hono } from "hono";
import { z } from "zod";
import { ok } from "@tap/shared";
import { fail, type AppEnv } from "../app";
import { sha256Hex } from "../lib/crypto";
import { randomToken } from "../lib/google";
import { readCookie } from "../lib/session";
import { rateHit } from "../lib/rate";
import { exchangeToken, ThreadsApiError } from "../lib/threads";
import { BudgetExceeded } from "../lib/budget";
import { connectThreadsAccount } from "./accounts";
import type { Env } from "../env";

const COOKIE = "__Secure-tap_threads_oauth";
export const THREADS_SCOPES = "threads_basic,threads_content_publish,threads_manage_insights,threads_read_replies,threads_manage_replies";
const configured = (env: Env) => Boolean(env.THREADS_APP_ID && env.THREADS_APP_SECRET);
const redirect = (env: Env) => new URL("/api/threads/oauth/callback", env.APP_ORIGIN).href;

// Logs must never receive the error object, message, stack or provider payload:
// fetch errors can embed token-bearing URLs and provider messages can echo secrets.
type OAuthStage = "short_exchange" | "long_exchange" | "profile_save";
const FAILURE_CODE:Record<OAuthStage,string> = {
  short_exchange:"OAUTH_SHORT_EXCHANGE", long_exchange:"OAUTH_LONG_EXCHANGE", profile_save:"OAUTH_PROFILE_SAVE",
};
class OAuthResponseError extends Error {}
const safeInteger = (value:unknown):number|undefined => typeof value==="number" && Number.isSafeInteger(value) ? value : undefined;
function logOAuthFailure(stage:OAuthStage,error:unknown,httpStatus?:number) {
  // Class labels are constants, never err.name / constructor.name supplied by input.
  const errorClass = error instanceof ThreadsApiError ? "ThreadsApiError"
    : error instanceof BudgetExceeded ? "BudgetExceeded"
    : error instanceof OAuthResponseError ? "OAuthResponseError"
    : error instanceof SyntaxError ? "SyntaxError"
    : error instanceof TypeError ? "TypeError"
    : error instanceof DOMException ? (error.name==="TimeoutError" ? "TimeoutError" : error.name==="AbortError" ? "AbortError" : "DOMException")
    : error instanceof Error ? "Error" : "UnknownError";
  console.error("[threads-oauth]", {
    stage, errorClass,
    ...(safeInteger(httpStatus)===undefined ? {} : {httpStatus}),
    ...(error instanceof ThreadsApiError && safeInteger(error.code)!==undefined ? {providerCode:error.code} : {}),
    ...(error instanceof ThreadsApiError && safeInteger(error.subcode)!==undefined ? {providerSubcode:error.subcode} : {}),
    ...(error instanceof BudgetExceeded ? {used:error.used,limit:error.limit} : {}),
  });
}

export function threadsOAuthRoutes() {
  const r = new Hono<AppEnv>();
  r.get("/status", c => c.json(ok({configured: configured(c.env), redirectUri: redirect(c.env)})));
  r.post("/start", async c => {
    if (!configured(c.env)) return fail("NOT_CONFIGURED", "Threadsのかんたん接続は管理者による設定待ちです", 503);
    const db=c.get("db"), userId=c.get("userId")!;
    if (!await rateHit(db, `threads-oauth:${userId}`, 10, 10)) return fail("RATE_LIMITED", "少し待ってからお試しください", 429);
    const state=randomToken(), browser=randomToken(), now=new Date();
    await db.batch([
      {sql:"DELETE FROM threads_oauth_states WHERE user_id=? OR expires_at<?",params:[userId,now.toISOString()]},
      {sql:"INSERT INTO threads_oauth_states(id,user_id,session_id,browser_hash,expires_at) VALUES (?,?,?,?,?)",params:[await sha256Hex(state),userId,c.get("sessionId"),await sha256Hex(browser),new Date(now.getTime()+600000).toISOString()]},
    ]);
    c.header("Set-Cookie",`${COOKIE}=${browser}; Path=/api/threads/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
    c.header("Cache-Control","no-store");
    const url=new URL("https://threads.net/oauth/authorize");
    url.search=new URLSearchParams({client_id:c.env.THREADS_APP_ID!,redirect_uri:redirect(c.env),scope:THREADS_SCOPES,response_type:"code",state}).toString();
    return c.json(ok({url:url.href}));
  });
  // Same-origin completion restores the Strict session cookie without relaxing session security.
  r.get("/callback", c => {
    const nonce=randomToken();
    const state=c.req.query("state") ?? "", code=c.req.query("code") ?? "";
    const payload=JSON.stringify({state:state.slice(0,200),code:code.slice(0,4096)}).replace(/</g,"\\u003c");
    c.header("Content-Security-Policy",`default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
    c.header("Cache-Control","no-store");c.header("Referrer-Policy","no-referrer");
    return c.html(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>Threads連携</title><p id="message">Threadsとの連携を確認しています…</p><script nonce="${nonce}">
      const payload=${payload}; history.replaceState(null,'','/api/threads/oauth/callback');
      fetch('/api/threads/oauth/complete',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Requested-With':'fetch'},body:JSON.stringify(payload)})
      .then(async r=>{const data=await r.json(); if(r.ok && data.data?.account?.id) {location.replace('/connect?connected='+encodeURIComponent(data.data.account.id));} else {location.replace('/connect?threads=failed');}})
      .catch(()=>{document.getElementById('message').textContent='連携できませんでした。接続画面からやり直してください。';});
      </script><noscript>JavaScriptを有効にし、接続画面からやり直してください。</noscript></html>`);
  });
  r.post("/complete", async c => {
    if (!configured(c.env)) return fail("NOT_CONFIGURED","Threads連携は未設定です",503);
    const input=z.object({state:z.string().min(20).max(200),code:z.string().min(1).max(4096)}).safeParse(await c.req.json().catch(()=>null));
    if (!input.success) return fail("OAUTH_INVALID","接続を開始し直してください",400);
    const browser=readCookie(c.req.raw,COOKIE);
    if (!browser) return fail("OAUTH_INVALID","接続を開始したブラウザでお試しください",400);
    const consumed=await c.get("db").first<{id:string}>("DELETE FROM threads_oauth_states WHERE id=? AND user_id=? AND session_id=? AND browser_hash=? AND expires_at>? RETURNING id",await sha256Hex(input.data.state),c.get("userId"),c.get("sessionId"),await sha256Hex(browser),new Date().toISOString());
    if (!consumed) return fail("OAUTH_INVALID","接続を開始し直してください",400);
    c.header("Set-Cookie",`${COOKIE}=; Path=/api/threads/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    c.header("Cache-Control","no-store");
    let stage:OAuthStage="short_exchange";
    let upstreamStatus:number|undefined;
    try {
      c.get("budget").subrequests.use();
      const response=await fetch("https://graph.threads.net/oauth/access_token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:c.env.THREADS_APP_ID!,client_secret:c.env.THREADS_APP_SECRET!,redirect_uri:redirect(c.env),code:input.data.code,grant_type:"authorization_code"}),signal:AbortSignal.timeout(15000)});
      upstreamStatus=response.status;
      const short=await response.json() as {access_token?:unknown;error?:{code?:unknown;error_subcode?:unknown}}|null;
      if (!response.ok || typeof short?.access_token!=="string" || !short.access_token) {
        const providerCode=safeInteger(short?.error?.code);
        const providerSubcode=safeInteger(short?.error?.error_subcode);
        const error=providerCode===undefined ? new OAuthResponseError() : new ThreadsApiError({code:providerCode,subcode:providerSubcode,message:"OAuth response rejected",raw:""});
        logOAuthFailure(stage,error,upstreamStatus);
        return fail(FAILURE_CODE[stage],"Threadsの認証をやり直してください",400);
      }
      stage="long_exchange"; upstreamStatus=undefined;
      const long=await exchangeToken(short.access_token,c.env.THREADS_APP_SECRET!,{env:c.env,budget:c.get("budget")});
      if (typeof long?.access_token!=="string" || !long.access_token) {
        logOAuthFailure(stage,new OAuthResponseError());
        return fail(FAILURE_CODE[stage],"長期トークンに交換できませんでした",400);
      }
      stage="profile_save";
      const connected=await connectThreadsAccount(c,long.access_token,undefined,true);
      if (!connected.ok) logOAuthFailure(stage,new OAuthResponseError(),connected.status);
      return connected;
    } catch (error) {
      logOAuthFailure(stage,error,upstreamStatus);
      return fail(FAILURE_CODE[stage],"Threadsに接続できませんでした。権限を確認してやり直してください",502);
    }
  });
  return r;
}
