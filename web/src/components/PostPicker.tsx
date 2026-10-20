import { useEffect, useRef, useState } from "react";
import { loadPostTree } from "../api/post-tree";
import type { PostSummary } from "@tap/shared";
import type { AiPickMode } from "@tap/shared";
import { usePostPicker, type PostSort } from "../api/ai";
import { fmtN, md } from "../lib/format";

const SORTS: Array<{ key: PostSort; label: string }> = [
  { key: "views", label: "表示回数" }, { key: "likes", label: "いいね" },
  { key: "new", label: "新しい順" },
];

export default function PostPicker({ accountId, tz, picks, pickMode, onTotal, onChange }: {
  accountId: string | null; tz: string; picks: string[]; pickMode: AiPickMode;
  onTotal?: (total: number) => void;
  onChange: (next: { picks: string[]; pickMode: AiPickMode }) => void;
}) {
  const revision=useRef(0);
  useEffect(()=>{revision.current++;setPreviews({});setError("");return ()=>{revision.current++;};},[accountId,pickMode]);
  const [browse, setBrowse] = useState(false);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<PostSort>("views");
  const [pages, setPages] = useState<string[]>([""]);
  const list = usePostPicker(accountId, { q, sort, cursor: pages.at(-1) });
  const posts = list.data?.posts ?? [];
  const [resolving,setResolving]=useState(false);
  const [error,setError]=useState("");
  const [previews,setPreviews]=useState<Record<string,{post:PostSummary;excludedReplies:number}>>({});
  useEffect(() => {
    if (q === "" && pages.length === 1 && list.data) onTotal?.(list.data.total);
  }, [list.data, onTotal, pages.length, q]);
  useEffect(() => {
    if (!accountId) return;
    const controller = new AbortController();
    const missing = picks.filter(id => !previews[id]);
    if (!missing.length) return;
    setResolving(true);
    void (async () => {
      try {
        for (const id of missing) {
          const result = await loadPostTree(accountId,id,"reference",controller.signal);
          if (!controller.signal.aborted) setPreviews(prev=>({...prev,[id]:result}));
        }
      } catch(e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "参考投稿を取得できませんでした"); }
      finally { if (!controller.signal.aborted) setResolving(false); }
    })();
    return () => controller.abort();
  }, [accountId, picks.join(",")]);
  async function toggle(id: string) {
    const version=revision.current;
    if (resolving) return;
    if (pickMode !== "rewrite" && picks.length >= 3 && !picks.includes(id)) return;
    const next = pickMode === "rewrite" ? (picks[0] === id ? [] : [id])
      : picks.includes(id) ? picks.filter(x => x !== id) : [...picks, id].slice(-3);
    if (!picks.includes(id)) {
      setResolving(true);setError("");
      try {
        const result=await loadPostTree(accountId!,id,"reference");
        if (version!==revision.current) return;
        setPreviews(prev=>({...prev,[id]:result}));
      } catch(e) {if(version!==revision.current)return;setError(e instanceof Error ? e.message : "参考投稿を取得できませんでした");return;}
      finally {setResolving(false);}
    }
    if(version===revision.current) onChange({ pickMode, picks: next });
  }
  const focusedId = picks.at(-1);
  const focused = focusedId ? previews[focusedId] : undefined;
  return <section className={`post-picker ${browse ? "is-browsing" : ""}`} aria-label="自分の参考投稿">
    <button type="button" className="picker-browse btn-quiet" aria-expanded={browse} onClick={() => setBrowse(!browse)}>{browse ? "一覧を閉じる" : "ほかの投稿を探す・並べ替える"}</button>
    <div className="section-head picker-heading"><h3>自分の投稿から選ぶ</h3><span className="muted">{picks.length ? `${picks.length}本を選択中` : "未選択"}</span></div>
    <p className="muted picker-help">表示回数の上位5件から表示。本人が連続してつないだ投稿を使い、他人への返信は除きます。{pickMode === "rewrite" ? "1本を選択。" : "最大3本。最初の投稿を主な型にします。"}</p>
    <label className="field picker-search" htmlFor="picker-q"><span>本文で探す</span><input id="picker-q" className="input" value={q} placeholder="キーワード" onChange={e => { setQ(e.target.value); setPages([""]); }} /></label>
    <div className="chips section picker-sorts" role="group" aria-label="並べ替え">{SORTS.map(s => <button key={s.key} type="button" className="chip" aria-pressed={sort === s.key} onClick={() => { setSort(s.key); setPages([""]); }}>{s.label}</button>)}</div>
    {list.isPending && <p className="muted section">読み込んでいます…</p>}
    {list.isError && <p className="msg msg-warn section">投稿を読み込めませんでした。<button type="button" className="btn-quiet" onClick={() => void list.refetch()}>再読み込み</button></p>}
    {!list.isPending && !list.isError && !posts.length && <p className="muted section">投稿が見つかりませんでした。</p>}
    <div className="choices section" data-testid="post-picker-list">{posts.map(p => <button key={p.id} type="button" className="choice post-choice" role="checkbox" aria-checked={picks.includes(p.id)} disabled={resolving || (pickMode !== "rewrite" && picks.length >= 3 && !picks.includes(p.id))} onClick={() => toggle(p.id)}>
      <span className="choice-title">{p.text.slice(0, 100) || "（本文なし）"}</span>
      <span className="choice-note">{md(p.postedAt, tz)} ・ 表示 {fmtN(p.views)} ・ いいね {fmtN(p.likes)}{p.children.length > 0 ? ` ・ 本人の続き${p.children.length}投稿` : ""}</span>
      {focusedId === p.id && <span className="post-choice-more">全文を見る ↓</span>}
    </button>)}</div>
    {resolving && <p role="status">本人のツリーを確認しています…</p>}
    {error && <p role="alert" className="msg msg-bad">{error}</p>}
    {focused && <details className="section post-choice-preview"><summary>全文を見る{focused.excludedReplies ? `（会話の返信${focused.excludedReplies}件を除外）` : ""}</summary>{[focused.post.text,...focused.post.children.map(c=>c.text)].map((text,i)=><p key={i} style={{whiteSpace:"pre-wrap"}}>{text}</p>)}</details>}
    <div className="picker-pagination"><button type="button" className="btn-quiet" disabled={pages.length === 1 || list.isFetching} onClick={() => setPages(p => p.slice(0, -1))}>前の5件</button><span className="muted">{pages.length}ページ</span><button type="button" className="btn-quiet" disabled={!list.data?.cursor || list.isFetching} onClick={() => { if (list.data?.cursor) setPages(p => [...p, list.data!.cursor!]); }}>次の5件</button></div>
    {picks.length > 0 && <button type="button" className="btn-quiet" onClick={() => onChange({ picks: [], pickMode })}>選択を解除</button>}
  </section>;
}
