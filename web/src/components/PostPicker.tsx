/**
 * 自分の過去投稿から見本を選ぶ一覧（SPEC §7.3）。
 *
 * 通常: 検索・並べ替え・5件ずつのページ送り。行を押すと選択を切り替える。
 * minimal（作る画面の「投稿を選ぶ」手順、DECISIONS 2026-10-19 4回目）:
 *   表示回数の多い順だけ。「もっと見る」で次の5件を下に足す。
 *   行を押すと全文を読む画面を開き（`onOpen`）、選ぶのはその画面の下の帯で行う。
 */
import { useState } from "react";
import type { AiPickMode, PostSummary } from "@tap/shared";
import { usePostPicker, type PostSort } from "../api/ai";
import { fmtN, md } from "../lib/format";
import Skeleton from "./Skeleton";

const SORTS: Array<{ key: PostSort; label: string }> = [
  { key: "views", label: "表示回数" }, { key: "likes", label: "いいね" },
  { key: "clicks", label: "クリック" }, { key: "new", label: "新しい順" },
];

function postNote(p: PostSummary, tz: string): string {
  return `${md(p.postedAt, tz)} ・ 表示 ${fmtN(p.views)} ・ いいね ${fmtN(p.likes)}${p.children.length > 0 ? ` ・ 続き${p.children.length}件` : ""}`;
}

/** minimal の1ページ分（5件）。最後のページだけ「もっと見る」を持つ。 */
function MinimalPage({ accountId, tz, cursor, picks, last, first, onOpen, onMore }: {
  accountId: string | null; tz: string; cursor: string; picks: string[]; last: boolean; first: boolean;
  onOpen: (post: PostSummary) => void; onMore: (cursor: string) => void;
}) {
  const list = usePostPicker(accountId, { q: "", sort: "views", cursor });
  const posts = list.data?.posts ?? [];
  if (list.isPending) return first ? <Skeleton lines={5} label="投稿を読み込んでいます" /> : <p className="pick-more"><button type="button" className="btn-link" aria-busy="true" disabled>読み込んでいます…</button></p>;
  if (list.isError) return <p className="msg msg-warn">投稿を読み込めませんでした。<button type="button" className="btn-quiet" onClick={() => void list.refetch()}>再読み込み</button></p>;
  if (first && !posts.length) return <p className="muted">投稿が見つかりませんでした。下の「他人の投稿を貼り付ける」から始めることもできます。</p>;
  return <>
    {posts.map(p => {
      const picked = picks.includes(p.id);
      return <button key={p.id} type="button" className="choice post-choice pick-row" role="checkbox" aria-checked={picked} aria-haspopup="dialog" onClick={() => onOpen(p)}>
        <span className="choice-title">{p.text.slice(0, 100) || "（本文なし）"}</span>
        <span className="choice-note">{postNote(p, tz)}</span>
        {picked && <span className="tag pick-tag">選択中</span>}
      </button>;
    })}
    {last && list.data?.cursor && <p className="pick-more"><button type="button" className="btn-link" onClick={() => onMore(list.data!.cursor!)}>もっと見る</button></p>}
  </>;
}

function MinimalPicker({ accountId, tz, picks, onOpen }: {
  accountId: string | null; tz: string; picks: string[]; onOpen: (post: PostSummary) => void;
}) {
  const [cursors, setCursors] = useState<string[]>([""]);
  return <div className="choices pick-list" data-testid="post-picker-list">
    {cursors.map((c, i) => <MinimalPage key={c || "first"} accountId={accountId} tz={tz} cursor={c} picks={picks} first={i === 0} last={i === cursors.length - 1} onOpen={onOpen} onMore={next => setCursors(p => p.includes(next) ? p : [...p, next])} />)}
  </div>;
}

export default function PostPicker({ accountId, tz, picks, pickMode, onChange, minimal = false, onOpen }: {
  accountId: string | null; tz: string; picks: string[]; pickMode: AiPickMode;
  onChange: (next: { picks: string[]; pickMode: AiPickMode }) => void;
  /** 見出し・検索・並べ替え・ページ送りを出さず、「もっと見る」で足していく形にする */
  minimal?: boolean;
  /** minimal で行を押したとき（選択はせず、全文を開く） */
  onOpen?: (post: PostSummary) => void;
}) {
  if (minimal) return <MinimalPicker accountId={accountId} tz={tz} picks={picks} onOpen={onOpen ?? (() => {})} />;
  return <FullPicker accountId={accountId} tz={tz} picks={picks} pickMode={pickMode} onChange={onChange} />;
}

function FullPicker({ accountId, tz, picks, pickMode, onChange }: {
  accountId: string | null; tz: string; picks: string[]; pickMode: AiPickMode;
  onChange: (next: { picks: string[]; pickMode: AiPickMode }) => void;
}) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<PostSort>("views");
  const [pages, setPages] = useState<string[]>([""]);
  const list = usePostPicker(accountId, { q, sort, cursor: pages.at(-1) });
  const posts = list.data?.posts ?? [];
  function toggle(id: string) {
    if (pickMode !== "rewrite" && picks.length >= 3 && !picks.includes(id)) return;
    const next = pickMode === "rewrite" ? (picks[0] === id ? [] : [id])
      : picks.includes(id) ? picks.filter(x => x !== id) : [...picks, id].slice(-3);
    onChange({ pickMode, picks: next });
  }
  return <section className="post-picker" aria-label="自分の参考投稿">
    <div className="section-head"><h3>自分の投稿から選ぶ</h3><span className="muted">{picks.length ? `${picks.length}本を選択中` : "未選択"}</span></div>
    <p className="muted picker-help">表示回数の上位5件から表示。本人の続きも含めて使います。{pickMode === "rewrite" ? "1本を選択。" : "最大3本。最初の投稿を主な型にします。"}</p>
    <label className="field" htmlFor="picker-q"><span>本文で探す</span><input id="picker-q" className="input" value={q} placeholder="キーワード" onChange={e => { setQ(e.target.value); setPages([""]); }} /></label>
    <div className="chips section" role="group" aria-label="並べ替え">{SORTS.map(s => <button key={s.key} type="button" className="chip" aria-pressed={sort === s.key} onClick={() => { setSort(s.key); setPages([""]); }}>{s.label}</button>)}</div>
    {list.isPending && <p className="muted section">読み込んでいます…</p>}
    {list.isError && <p className="msg msg-warn section">投稿を読み込めませんでした。<button type="button" className="btn-quiet" onClick={() => void list.refetch()}>再読み込み</button></p>}
    {!list.isPending && !list.isError && !posts.length && <p className="muted section">投稿が見つかりませんでした。</p>}
    <div className="choices section" data-testid="post-picker-list">{posts.map(p => <button key={p.id} type="button" className="choice post-choice" role="checkbox" aria-checked={picks.includes(p.id)} disabled={pickMode !== "rewrite" && picks.length >= 3 && !picks.includes(p.id)} onClick={() => toggle(p.id)}>
      <span className="choice-title">{p.text.slice(0, 100) || "（本文なし）"}</span>
      <span className="choice-note">{postNote(p, tz)}</span>
    </button>)}</div>
    <div className="picker-pagination"><button type="button" className="btn-quiet" disabled={pages.length === 1 || list.isFetching} onClick={() => setPages(p => p.slice(0, -1))}>前の5件</button><span className="muted">{pages.length}ページ</span><button type="button" className="btn-quiet" disabled={!list.data?.cursor || list.isFetching} onClick={() => { if (list.data?.cursor) setPages(p => [...p, list.data!.cursor!]); }}>次の5件</button></div>
    {picks.length > 0 && <button type="button" className="btn-quiet" onClick={() => onChange({ picks: [], pickMode })}>選択を解除</button>}
  </section>;
}
