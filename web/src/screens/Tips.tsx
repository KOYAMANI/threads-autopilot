import type { PostSummary, UserGoal } from "@tap/shared";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMe } from "../api/auth";
import { useDashboard } from "../api/accounts";
import { useShell } from "../components/Shell";
import PostReadSheet from "../components/PostReadSheet";
import { ChevronIcon, LightbulbIcon, PenIcon, StackIcon, PlaneIcon } from "../components/Icons";

type Tip = {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  example: string;
  tone: "amber" | "mint" | "blue" | "rose";
  action?: "create" | "reference";
  post?: PostSummary;
};

const GOAL_TIPS: Record<NonNullable<UserGoal>, Tip> = {
  monetize: {
    id: "monetize-value",
    eyebrow: "収益化",
    tone: "mint",
    title: "売る前に、変化を1つ見せる",
    body: "誰が・何に困り・どう変わったかを、実際の体験から書いてみましょう。最後にお願いすることは1つに絞ります。",
    example: "例：毎日2時間かかっていた作業が、朝15分で終わるようになった手順を3つに分けます。",
    action: "create",
  },
  shop: {
    id: "shop-scene",
    eyebrow: "店舗・サービス",
    tone: "mint",
    title: "商品説明より、使う場面を書く",
    body: "特徴の羅列ではなく、お客さまが困る瞬間から始めると自分ごととして読まれます。写真がある場合は本文を短くしても構いません。",
    example: "例：雨の日でも崩れにくい。朝セットする時間がない人向けのスタイルです。",
    action: "create",
  },
  awareness: {
    id: "awareness-opinion",
    eyebrow: "認知・採用",
    tone: "blue",
    title: "一般論に、自分の判断を1つ足す",
    body: "役立つ情報だけで終わらせず、『自分はこう考える』を入れると、人柄と仕事の基準が伝わります。",
    example: "例：効率だけならA。でも長く続けるチームなら、私はBを選びます。",
    action: "create",
  },
};

const LIBRARY: Tip[] = [
  {
    id: "hook-specific",
    eyebrow: "1行目",
    tone: "amber",
    title: "抽象語を、場面か数字に置き換える",
    body: "『おすすめ』『すごい』だけでは続きを読む理由が弱くなります。誰の、いつの、何が変わる話かを先に置きます。",
    example: "例：発信が苦手な人へ → 1投稿に40分かかる人へ",
  },
  {
    id: "one-message",
    eyebrow: "本文",
    tone: "blue",
    title: "1投稿で伝えることは1つにする",
    body: "結論を増やすほど記憶に残りにくくなります。補足は削るか、続きの投稿に分けます。",
    example: "チェック：読後に『つまり何？』へ1文で答えられるか。",
  },
  {
    id: "cta-one",
    eyebrow: "締め",
    tone: "mint",
    title: "最後のお願いは1つだけ",
    body: "フォロー、保存、リンク確認を同時に求めず、その投稿で一番自然な行動を1つ選びます。",
    example: "例：あとで試すなら保存しておいてください。",
  },
  {
    id: "experience",
    eyebrow: "信頼",
    tone: "rose",
    title: "小さな体験を1行入れる",
    body: "正しい説明だけより、失敗・迷い・発見の1行がある方が、その人から読む理由になります。",
    example: "例：自分も最初の30投稿は、ほとんど反応がありませんでした。",
  },
];

function daysSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

function personalizedTips(posts: PostSummary[], goal: UserGoal | null): Tip[] {
  const result: Tip[] = [];
  if (posts.length === 0) {
    result.push({
      id: "first-post",
      eyebrow: "最初の1本",
      tone: "amber",
      title: "自己紹介より、相手の悩みから始める",
      body: "最初から自分を詳しく説明する必要はありません。これから誰に何を届けるかが伝わる1本を作ります。",
      example: "例：Threadsを始めたけれど、何を書けばいいか止まっている人へ。",
      action: "create",
    });
  } else {
    const sorted = [...posts].sort((a, b) => b.views - a.views);
    const latest = [...posts].sort((a, b) => +new Date(b.postedAt) - +new Date(a.postedAt))[0]!;
    const median = sorted[Math.floor(sorted.length / 2)]?.views ?? 0;
    if (daysSince(latest.postedAt) >= 3) {
      result.push({
        id: "restart",
        eyebrow: "継続",
        tone: "amber",
        title: "今日は短い1本で再開する",
        body: "空いた日数を取り戻そうとせず、最近気づいたことを結論から書きます。画像で内容を補足するなら、本文が短くても問題ありません。",
        example: "例：最近やめて楽になったことを、理由と一緒に1つ。",
        action: "create",
      });
    }
    if (sorted[0] && sorted.length >= 3 && sorted[0].views >= Math.max(300, median * 1.8)) {
      result.push({
        id: "reuse-winner",
        eyebrow: "反応のよかった投稿から",
        tone: "blue",
        title: "よく読まれた話題で、もう1本書く",
        body: "この投稿でまだ書いていない具体例や、その後に気づいたことを続編にしてみましょう。",
        example: sorted[0].text,
        action: "reference",
        post: sorted[0],
      });
    }
  }
  if (result.length < 2 && goal) result.push(GOAL_TIPS[goal]);
  if (result.length < 2) result.push({ ...LIBRARY[0]!, action: "create" });
  return result.slice(0, 2);
}

export default function Tips() {
  const { account } = useShell();
  const me = useMe();
  const dashboard = useDashboard(account?.id ?? null, 30);
  const navigate = useNavigate();
  const [reading, setReading] = useState<PostSummary | null>(null);
  useEffect(() => setReading(null), [account?.id]);
  const tips = personalizedTips(dashboard.data?.posts ?? [], me.data?.profile.goal ?? null);

  return <div className="tips-page">
    <div className="page-heading tips-heading"><div><p className="eyebrow">POST TIPS</p><h1>投稿ヒント</h1></div></div>
    <section aria-labelledby="next-actions-title">
      <div className="section-head tips-section-head"><h2 id="next-actions-title">次にやること</h2></div>
      {dashboard.isPending ? <p className="muted section">投稿データを確認しています…</p> : dashboard.isError ? <p className="msg msg-warn">投稿データを読み込めませんでした。<button type="button" className="btn btn-sub btn-fit" onClick={() => void dashboard.refetch()}>もう一度読み込む</button></p> : <div className="tips-primary-grid">{tips.map(tip => <article className={`tip-card tip-card-primary tip-tone-${tip.tone}`} key={tip.id}>
        <div className="tip-card-top"><span className="tip-icon"><TipIcon tone={tip.tone} /></span><span className="tip-category">{tip.eyebrow}</span></div>
        <h3>{tip.title}</h3><p>{tip.body}</p>
        {tip.post ? <button type="button" className="tip-reference" onClick={() => setReading(tip.post!)}><span>反応のよかった投稿</span><p>{tip.example}</p><strong>全文を読む <ChevronIcon size={16} /></strong></button> : <div className="tip-example">{tip.example}</div>}
        {tip.action && <div className="tip-card-actions"><button type="button" className="btn btn-sub btn-fit" onClick={() => navigate("/app/create", tip.post ? { state: { preset: { mode: "template", postId: tip.post.id, text: tip.post.text } } } : undefined)}>{tip.post ? "この投稿を参考に作る" : "投稿を書く"}<ChevronIcon size={16} /></button></div>}
      </article>)}</div>}
    </section>
    <TipLibrary />
    <PostReadSheet post={reading} onClose={() => setReading(null)} />
  </div>;
}

function TipIcon({ tone }: { tone: Tip["tone"] }) {
  const Icon = tone === "amber" ? LightbulbIcon : tone === "blue" ? StackIcon : tone === "mint" ? PlaneIcon : PenIcon;
  return <Icon size={24} />;
}

function TipLibrary() {
  const rail = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  useEffect(() => {
    const element = rail.current;
    if (!element) return;
    const update = () => setEdges({ start: element.scrollLeft <= 2, end: element.scrollLeft + element.clientWidth >= element.scrollWidth - 2 });
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => { observer.disconnect(); element.removeEventListener("scroll", update); };
  }, []);
  const move = (direction: number) => {
    const element = rail.current;
    if (!element) return;
    const card = element.firstElementChild as HTMLElement | null;
    element.scrollBy({ left: direction * ((card?.offsetWidth ?? 280) + 16), behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };
  return <section aria-labelledby="tips-library-title">
    <div className="section-head tips-section-head"><h2 id="tips-library-title">基本のヒント集</h2><div className="tip-rail-controls"><button type="button" className="btn btn-sub tip-rail-prev" aria-label="前のヒント" disabled={edges.start} onClick={() => move(-1)}><ChevronIcon size={18} /></button><button type="button" className="btn btn-sub" aria-label="次のヒント" disabled={edges.end} onClick={() => move(1)}><ChevronIcon size={18} /></button></div></div>
    <div ref={rail} className="tips-library-rail" tabIndex={0} role="region" aria-label="基本のヒント集。横にスクロールできます">{LIBRARY.map(tip => <article className={`tip-card tip-card-library tip-tone-${tip.tone}`} key={tip.id}><div className="tip-card-top"><span className="tip-icon"><TipIcon tone={tip.tone} /></span><span className="tip-category">{tip.eyebrow}</span></div><h3>{tip.title}</h3><p>{tip.body}</p><div className="tip-example">{tip.example}</div></article>)}</div>
  </section>;
}
