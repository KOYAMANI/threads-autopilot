import type { AiCandidate, PostSummary } from "@tap/shared";
import PostReadSheet from "../components/PostReadSheet";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDashboard } from "../api/accounts";
import { useNotifications, usePutNotifications } from "../api/autopilot";
import { useQueue } from "../api/queue";
import { useShell } from "../components/Shell";
import { useToast } from "../components/Toast";
import { fmtN } from "../lib/format";
import { useCreateSessionState } from "../lib/create-session";
import { cancelGenerationTask, useGenerationTask } from "../lib/generation-task";
import { pushSupported, subscribePush } from "../lib/push";

export type CreatePreset = { mode: "template" | "rewrite"; postId: string; text: string };

export default function Home() {
  const { account } = useShell();
  const navigate = useNavigate();
  const [reading, setReading] = useState<PostSummary | null>(null);
  useEffect(() => setReading(null), [account?.id]);
  const toast = useToast();
  const dashboard = useDashboard(account?.id ?? null, 7);
  const scheduled = useQueue(account?.id ?? null, "scheduled");
  const notifications = useNotifications();
  const putNotifications = usePutNotifications();
  const generation = useGenerationTask();
  const [savedCandidates] = useCreateSessionState<AiCandidate[]>(account?.id ?? null, "candidates", []);
  const [submittedCandidates] = useCreateSessionState<Record<string, unknown>>(account?.id ?? null, "submitted", {});
  const remaining = savedCandidates.filter(candidate => !submittedCandidates[candidate.key]).length;
  const [now, setNow] = useState(Date.now());
  const [pushOffer, setPushOffer] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  useEffect(() => {
    if (generation.status !== "running") return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [generation.status]);
  useEffect(() => {
    if (generation.status !== "done" || notifications.data?.notifications.pushEnabled || !notifications.data?.vapidPublicKey || !pushSupported()) return;
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const standalone = window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    if (ios && !standalone) return; // 「ホーム画面に追加」の導線はREADMEで未設計。
    const key = "tap:push-offer-after-first-generation";
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, "1");
    } catch { /* The offer can still be shown for this page view. */ }
    setPushOffer(true);
  }, [generation.status, notifications.data]);

  async function enablePush() {
    const vapid = notifications.data?.vapidPublicKey;
    if (!vapid || pushBusy) return;
    setPushBusy(true);
    try {
      const result = await subscribePush(vapid);
      if (!result.ok) { toast.show(result.message, "bad"); return; }
      await putNotifications.mutateAsync({ pushEnabled: true });
      setPushOffer(false);
      toast.show("次回から生成完了をこの端末に通知します", "ok");
    } catch {
      toast.show("通知を登録できませんでした", "bad");
    } finally {
      setPushBusy(false);
    }
  }

  if (!account) return <div className="onboarding"><p className="eyebrow">WELCOME</p><h1>ここから、あなたのThreadsを。</h1><p className="muted">アカウントを接続して、投稿と数字をひとつの場所に。</p><div className="onboarding-grid"><section className="card"><span className="step-number">01</span><h2>Threadsを接続</h2><p>投稿と分析データを取り込みます。</p><button className="btn" onClick={() => navigate("/connect")}>Threadsをつなぐ</button></section><section className="card"><span className="step-number">02</span><h2>投稿環境を整える</h2><p>AIキーと通知を設定します。</p><button className="btn btn-sub" onClick={() => navigate("/app/settings")}>設定を開く</button></section></div></div>;

  const posts = [...(dashboard.data?.posts ?? [])].sort((a, b) => b.views - a.views).slice(0, 3);
  const approvals = scheduled.data?.filter(item => item.status === "pending_approval") ?? [];

  function createFrom(post: (typeof posts)[number]) {
    const preset: CreatePreset = { mode: "template", postId: post.id, text: post.text };
    navigate("/app/create", { state: { preset } });
  }

  return <div className="mobile-home">
    <div className="home-title-row"><div><p className="eyebrow">HOME</p><h1>ホーム</h1><p className="muted">@{account.username} の次の一手。</p></div><button className="btn btn-sub btn-fit desktop-only" onClick={() => navigate("/app/analytics")}>分析を見る</button></div>

    {generation.status !== "idle" && generation.accountId === account.id && <section className={`home-generation-card is-${generation.status}`}><div><strong>{generation.status === "running" ? "3案を作っています" : generation.status === "done" ? "3案できました" : "作れませんでした"}</strong>{generation.status === "running" && <span className="num">{Math.floor((now-generation.startedAt)/1000)}秒</span>}</div><p>{generation.status === "running" ? "できたらこのカードでお知らせします。別の画面を見ていて大丈夫です。" : generation.status === "done" ? "選んだ参考投稿とテーマから3案を作成しました。" : "選んだ参考投稿とテーマは残っています。"}</p><div className="home-generation-actions">{generation.status === "running" ? <button className="btn btn-sub" onClick={cancelGenerationTask}>やめる</button> : <><button className="btn" onClick={() => navigate("/app/create")}>{generation.status === "done" ? "3案を見る" : "入力に戻る"}</button>{generation.status === "done" && pushOffer && <button className="btn btn-sub" disabled={pushBusy} onClick={() => void enablePush()}>{pushBusy ? "通知を設定中…" : "次回は完了を通知"}</button>}</>}</div></section>}
    {generation.status === "idle" && savedCandidates.length > 0 && <section className="home-generation-card"><strong>作成した投稿案</strong><p>{remaining ? `キューに保存していない案が${remaining}件あります。` : "すべての案をキューに保存しました。"}</p><button className="btn" onClick={() => navigate("/app/create")}>投稿案に戻る</button></section>}
    {approvals.length > 0 && <button className="approval-callout" onClick={() => navigate("/app/queue", { state: { approveId: approvals[0]!.id } })}><span><strong>承認待ち {approvals.length}件</strong><small>承認するまで投稿されません。</small></span><span aria-hidden="true">→</span></button>}

    <section className="home-autopilot-card"><div><span className="status-dot" /><strong>オートパイロットは開発中です</strong></div><p>自動生成・自動予約は現在利用できません。準備ができ次第、この画面でお知らせします。</p></section>

    <div className="section-head home-section-head"><div><h2>この7日で伸びた投稿</h2><p className="muted">表示回数の上位3件</p></div><button className="btn-quiet" onClick={() => navigate("/app/analytics")}>すべて見る</button></div>
    {dashboard.isPending && <p className="muted section">投稿を読み込んでいます…</p>}
    {!dashboard.isPending && posts.length === 0 && <section className="card home-empty"><p>同期すると、伸びた投稿がここに表示されます。</p><button className="btn btn-sub" onClick={() => navigate("/app/analytics")}>分析を開く</button></section>}
    <div className="home-posts">
      {posts.map((post, index) => <article className="home-post-card" key={post.id}>
        <button className="home-post-main" onClick={() => setReading(post)}><span className="home-post-rank num">{index + 1}位</span><p>{post.text}</p><span className="post-read-link">全文を読む →</span>{post.children.length > 0 && <small>本人の続き {post.children.length}件</small>}</button>
        <div className="home-post-stats"><span><b>{fmtN(post.views)}</b><small>表示</small></span><span><b>{fmtN(post.likes)}</b><small>いいね</small></span></div><button className="home-create-link" onClick={() => createFrom(post)}>この投稿を参考に作る <span>→</span></button>
      </article>)}
    </div>
    <PostReadSheet post={reading} onClose={() => setReading(null)} />
  </div>;
}
