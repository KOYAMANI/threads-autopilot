import type { PostSummary } from "@tap/shared";
import Sheet from "./Sheet";

export default function PostReadSheet({ post, onClose }: { post: PostSummary | null; onClose: () => void }) {
  return <Sheet open={post !== null} onClose={onClose} title="投稿の全文">
    {post && <div className="post-read">{[post.text, ...post.children.map(child => child.text)].map((text, index) => <section key={index}><h3>{index === 0 ? "1投稿目" : `${index + 1}投稿目 · 本人の続き`}</h3><p>{text || "（本文なし）"}</p></section>)}{post.permalink && <a className="btn-quiet" href={post.permalink} target="_blank" rel="noreferrer">Threadsで開く ↗</a>}</div>}
  </Sheet>;
}
