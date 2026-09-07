/**
 * Connect（SPEC §12.1 `/connect`、design-v0.2 §3-1）。
 *
 * Metaアプリでトークンを作る手順 → トークン貼付 → サーバー側で `/me` 検証
 * → App Secret があれば60日トークンへ交換 → 初回同期の進捗バー → ホームへ。
 * `?add=1` のときは「戻る」を出す（初回はアカウント0件なので戻り先が無い）。
 */
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { motion } from "motion/react";
import { useConnectAccount, useSyncStatus } from "../api/accounts";
import { ApiError, api } from "../api/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { activeAccountStorageKey } from "../lib/active-account";
import { useToast } from "../components/Toast";
import { CROSSFADE, SPRING, useReducedMotion } from "../lib/motion";

const STEPS = [
  "developers.facebook.com でアプリを作り、「Threads API」を追加します",
  "アクセス許可に threads_basic / threads_content_publish / threads_manage_insights / threads_read_replies / threads_manage_replies を入れます",
  "「Threads API」のツールでご自身のアカウントを選び、アクセストークンを発行します",
  "発行されたトークン（THAA… で始まる長い文字列）をコピーして、下に貼り付けます",
];

export default function Connect() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const reduced = useReducedMotion();

  const isAdd = params.get("add") === "1";
  const [token, setToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectedId, setConnectedId] = useState<string | null>(params.get("connected"));

  const oauth = useQuery({queryKey:["threads-oauth"],queryFn:()=>api.get<{configured:boolean}>("/threads/oauth/status")});
  const startOAuth = useMutation({mutationFn:()=>api.post<{url:string}>("/threads/oauth/start"),onSuccess:({url})=>{window.location.assign(url);},onError:(e)=>setError(e instanceof ApiError ? e.message : "接続を開始できませんでした")});
  useEffect(()=>{if (connectedId) {try {localStorage.setItem(activeAccountStorageKey,connectedId);} catch {}}},[connectedId]);

  const connect = useConnectAccount();
  const sync = useSyncStatus(connectedId, connectedId !== null);

  // 同期が終わったらホームへ（進捗バーを一瞬でも見せるため、終わってから送り出す）
  useEffect(() => {
    if (!connectedId || sync.data?.status !== "done") return;
    const t = setTimeout(() => navigate("/app/home", { replace: true }), 600);
    return () => clearTimeout(t);
  }, [connectedId, sync.data, navigate]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await connect.mutateAsync({
        token: token.trim(),
        ...(appSecret.trim() ? { app_secret: appSecret.trim() } : {}),
      });
      setToken(""); setAppSecret("");
      setConnectedId(res.account.id);
      if (res.secretIgnored) {
        toast.show("App Secret で長期トークンに交換できませんでした。短期のまま保存しています", "bad");
      } else if (res.longLived) {
        toast.show("60日の長期トークンに交換しました", "ok");
      }
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "つなげませんでした";
      setError(message);
      toast.show(message, "bad");
    }
  }

  if (connectedId) {
    const total = sync.data?.total ?? 30;
    const progress = sync.data?.progress ?? 0;
    const ratio = Math.max(0.02, Math.min(1, progress / Math.max(1, total)));
    const done = sync.data?.status === "done";

    return (
      <main className="screen-plain">
        <h1>つながりました</h1>
        <p className="muted" style={{ marginTop: "0.375rem", marginBottom: "calc(var(--sp) * 3)" }}>
          {done
            ? "取り込みが終わりました。ホームに移ります"
            : "これまでの投稿と数字は裏で取り込みます。先にホームへ進んでも大丈夫です"}
        </p>
        <div className="card">
          <div className="bar">
            <motion.i
              initial={{ scaleX: 0 }}
              animate={{ scaleX: ratio }}
              transition={reduced ? CROSSFADE : SPRING}
              style={{ width: "100%" }}
            />
          </div>
          <p className="muted" style={{ marginTop: "var(--sp)" }}>
            {sync.data?.status === "failed" ? sync.data.message : `投稿の取り込み ${Math.round(progress / total * 100)}% · 保存済み ${sync.data?.posts ?? 0}件（続いて分析データを取得します）`}
          </p>
          {/* 取り込みは5分ごとのジョブで進む（SPEC §8.2）。終わるまで足止めしない */}
          <div style={{ marginTop: "calc(var(--sp) * 2)" }}>
            <button
              className="btn"
              type="button"
              onClick={() => navigate("/app/home", { replace: true })}
            >
              ホームへ
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="screen-plain">
      <div className="connect-heading"><span className="eyebrow">CONNECT YOUR ACCOUNT</span><button className="btn-quiet" onClick={() => navigate("/app/settings")}>設定・パスワード変更 →</button></div><h1>Threads をつなぐ</h1>
      <p className="muted" style={{ marginTop: "0.375rem", marginBottom: "calc(var(--sp) * 3)" }}>
        ご自身の Meta アプリで作ったトークンを貼り付けます。パスワードは預かりません。
      </p>

      <div className="card" style={{marginBottom:"1.5rem"}}><h2>Threadsでかんたん接続</h2><p className="muted" style={{margin:"1rem 0"}}>Threadsの画面で許可するだけ。トークンの取得・長期化・更新はアプリが行います。</p><button className="btn" disabled={!oauth.data?.configured || startOAuth.isPending} onClick={()=>startOAuth.mutate()}>{startOAuth.isPending ? "Threadsへ移動中…" : "Threadsで接続する"}</button>{!oauth.data?.configured && <p className="muted" style={{marginTop:".75rem"}}>管理者のMetaアプリ設定が済むまで、下のトークン接続を使えます。</p>}{params.get("threads") === "failed" && <p className="msg msg-bad" role="alert">Threadsに接続できませんでした。許可する権限とアプリ設定を確認して、接続をやり直してください。</p>}</div>
      <h2 style={{marginBottom:"1rem"}}>アクセストークンで接続</h2>
      <div className="card">
        <ol className="steps">
          {STEPS.map((s) => (
            <li key={s}>
              <span>{s}</span>
            </li>
          ))}
        </ol>
      </div>

      <form onSubmit={onSubmit} noValidate style={{ marginTop: "calc(var(--sp) * 2)" }}>
        <div className="card">
          <label className="field" style={{ marginTop: 0 }}>
            <span>アクセストークン</span>
            <textarea
              className="input"
              name="token"
              autoComplete="off"
              spellCheck={false}
              required
              placeholder="THAA…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>

          <button
            className="btn btn-quiet"
            type="button"
            onClick={() => setShowSecret((v) => !v)}
            aria-expanded={showSecret}
          >
            {showSecret ? "App Secret を閉じる" : "App Secret を入れる（任意）"}
          </button>

          {showSecret && (
            <label className="field" style={{ marginTop: "var(--sp)" }}>
              <span>App Secret（60日トークンへの交換にだけ使い、保存しません）</span>
              <input
                className="input"
                type="password"
                name="app_secret"
                autoComplete="off"
                spellCheck={false}
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
              />
            </label>
          )}

          {error && (
            <p className="msg msg-bad" role="alert">
              {error}
            </p>
          )}

          <div style={{ marginTop: "calc(var(--sp) * 3)" }}>
            <button className="btn" type="submit" disabled={connect.isPending || token.trim().length < 10}>
              {connect.isPending ? "確認しています…" : "つなぐ"}
            </button>
          </div>

          {isAdd && (
            <div style={{ marginTop: "var(--sp)", textAlign: "center" }}>
              <button className="btn btn-quiet" type="button" onClick={() => navigate(-1)}>
                戻る
              </button>
            </div>
          )}
        </div>
      </form>
    </main>
  );
}
