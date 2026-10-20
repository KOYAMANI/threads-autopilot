import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { UserGoal } from "@tap/shared";
import { useMe, useSaveProfile } from "../api/auth";
import { ApiError } from "../api/client";

const GOALS: Array<{ id: UserGoal; title: string; detail: string; activity: string }> = [
  { id: "monetize", title: "発信を収益化したい", detail: "アフィリエイト・コンテンツ・講座販売", activity: "コンテンツ販売" },
  { id: "shop", title: "お店・サービスに集客したい", detail: "店舗・サロン・相談・予約", activity: "店舗・サービス" },
  { id: "awareness", title: "認知・採用につなげたい", detail: "個人発信・経営者・企業広報・採用", activity: "認知・採用" },
];

export default function Onboarding() {
  const navigate = useNavigate();
  const me = useMe();
  const save = useSaveProfile();
  const [goal, setGoal] = useState<UserGoal | null>(null);
  const [activity, setActivity] = useState("");
  const [audience, setAudience] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me.data?.profile) return;
    setGoal(me.data.profile.goal);
    setActivity(me.data.profile.activity);
    setAudience(me.data.profile.audience);
  }, [me.data?.profile]);

  function pickGoal(next: UserGoal) {
    setGoal(next);
    if (!activity.trim()) setActivity(GOALS.find(item => item.id === next)?.activity ?? "");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!goal) return;
    setError(null);
    try {
      await save.mutateAsync({ goal, activity, audience, onboardingCompleted: false });
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "保存できませんでした");
    }
  }

  if (me.isPending) return <main className="onboarding-page"><p className="muted">読み込んでいます…</p></main>;
  if (!me.data) return null;
  const profileDone = Boolean(me.data.profile.goal) || save.isSuccess;
  const threadsDone = me.data.accounts.length > 0;
  const geminiDone = me.data.ai.hasKey;

  return (
    <main className="onboarding-page">
      <header className="onboarding-header"><div className="brand"><span className="brand-symbol">a</span><span>autopilot<span className="brand-sub">for Threads</span></span></div><span className="plan-chip">{me.data.entitlement.plan === "academy" ? "講座生" : me.data.entitlement.plan === "pro" ? "Pro" : "Free"}</span></header>
      <section className="onboarding-content">
        <p className="eyebrow">WELCOME</p>
        <h1>まず、発信の目標を教えてください。</h1>
        <p className="muted">投稿のヒントとAIの提案を、あなたの目的に合わせます。設定からいつでも見直せます。</p>

        <form onSubmit={submit} className="onboarding-form">
          <div className="goal-grid" role="radiogroup" aria-label="発信の目標">
            {GOALS.map(item => <button key={item.id} type="button" role="radio" aria-checked={goal === item.id} className="goal-card" onClick={() => pickGoal(item.id)}><strong>{item.title}</strong><span>{item.detail}</span></button>)}
          </div>
          {goal && <div className="profile-fields card">
            <label className="field"><span>取り組んでいること</span><input className="input" value={activity} onChange={event => setActivity(event.target.value)} placeholder="例：AI活用の講座販売" maxLength={200} /></label>
            <label className="field"><span>どんな人に、何を届けたい？</span><textarea className="input" rows={3} value={audience} onChange={event => setAudience(event.target.value)} placeholder="例：副業を始めたい人へ、最初の一歩を届けたい" maxLength={300} /></label>
            {error && <p className="msg msg-bad" role="alert">{error}</p>}
            <button className="btn" type="submit" disabled={save.isPending}>{save.isPending ? "保存中…" : profileDone ? "プロフィールを更新" : "保存して次へ"}</button>
          </div>}
        </form>

        {profileDone && <section className="connection-steps" aria-label="連携設定">
          <article className="connection-card"><span className={threadsDone ? "step-check is-done" : "step-check"}>{threadsDone ? "✓" : "2"}</span><div><h2>Threadsを接続</h2><p>{threadsDone ? `@${me.data.accounts[0]?.username} を接続済み` : "投稿と分析データを読み込みます。"}</p></div><button className="btn btn-sub btn-fit" onClick={() => navigate("/connect")}>{threadsDone ? "確認" : "接続する"}</button></article>
          <article className="connection-card"><span className={geminiDone ? "step-check is-done" : "step-check"}>{geminiDone ? "✓" : "3"}</span><div><h2>Geminiを接続 <small className="muted">任意</small></h2><p>{geminiDone ? "自分のAPIキーを接続済み" : "β版では自分のAPIキーを使います。後からでも設定できます。"}</p></div><button className="btn btn-sub btn-fit" onClick={() => navigate("/app/settings?tab=connections")}>{geminiDone ? "確認" : "設定する"}</button></article>
          <article className="platform-ai-card" aria-disabled="true"><div><strong>運営提供のAI枠</strong><span>準備中</span></div><p>現在は利用できません。運営側の設定で、あとから解放できる設計です。</p></article>
          <button className="btn onboarding-finish" disabled={!threadsDone || save.isPending} onClick={async () => {
            if (!goal) return;
            setError(null);
            try {
              await save.mutateAsync({ goal, activity, audience, onboardingCompleted: true });
              navigate("/app/create");
            } catch (reason) {
              setError(reason instanceof ApiError ? reason.message : "保存できませんでした");
            }
          }}>{save.isPending ? "保存中…" : "設定を完了して投稿を作る"}</button>
          {!threadsDone && <p className="muted onboarding-note">Threadsを接続すると投稿作成へ進めます。</p>}
        </section>}
      </section>
    </main>
  );
}
