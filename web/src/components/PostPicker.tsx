import { useState } from "react";
import type { AiPickMode } from "@tap/shared";
import { usePostPicker, type PostSort } from "../api/ai";
import { fmtN, md } from "../lib/format";

const SORTS: Array<{ key: PostSort; label: string }> = [
  { key: "views", label: "表示回数" }, { key: "likes", label: "いいね" },
  { key: "clicks", label: "クリック" }, { key: "new", label: "新しい順" },
];

export default function PostPicker({ accountId, tz, picks, pickMode, onChange }: {
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
      <span className="choice-note">{md(p.postedAt, tz)} ・ 表示 {fmtN(p.views)} ・ いいね {fmtN(p.likes)}{p.children.length > 0 ? ` ・ 続き${p.children.length}件` : ""}</span>
    </button>)}</div>
    <div className="picker-pagination"><button type="button" className="btn-quiet" disabled={pages.length === 1 || list.isFetching} onClick={() => setPages(p => p.slice(0, -1))}>前の5件</button><span className="muted">{pages.length}ページ</span><button type="button" className="btn-quiet" disabled={!list.data?.cursor || list.isFetching} onClick={() => { if (list.data?.cursor) setPages(p => [...p, list.data!.cursor!]); }}>次の5件</button></div>
    {picks.length > 0 && <button type="button" className="btn-quiet" onClick={() => onChange({ picks: [], pickMode })}>選択を解除</button>}
  </section>;
}
