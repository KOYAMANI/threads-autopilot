import { useState } from "react";

export function usePagination<T>(items: T[], scope: string) {
  const [size, setSize] = useState(5);
  const [position, setPosition] = useState({ scope, page: 0 });
  const pages = Math.max(1, Math.ceil(items.length / size));
  const page = position.scope === scope ? Math.min(position.page, pages - 1) : 0;
  const setPage = (next: number) => setPosition({ scope, page: Math.max(0, Math.min(next, pages - 1)) });
  return { items: items.slice(page * size, (page + 1) * size), page, pages, size, total: items.length,
    setPage, setSize: (next: number) => { setSize(next); setPage(0); } };
}

export default function Pagination({ label, paging }: { label: string; paging: ReturnType<typeof usePagination> }) {
  return <nav className="table-pagination" aria-label={`${label}のページ切替`}>
    <span className="muted">{paging.total ? `${paging.page * paging.size + 1}–${Math.min((paging.page + 1) * paging.size, paging.total)}` : "0"} / {paging.total}件</span>
    <label className="page-size">表示件数 <select aria-label={`${label}の表示件数`} value={paging.size} onChange={e => paging.setSize(Number(e.target.value))}><option value={5}>5件</option><option value={10}>10件</option></select></label>
    <button className="btn btn-sub btn-fit" disabled={paging.page === 0} onClick={() => paging.setPage(paging.page - 1)}>前へ</button>
    <span className="muted page-number">{paging.page + 1} / {paging.pages}</span>
    <button className="btn btn-sub btn-fit" disabled={paging.page + 1 >= paging.pages} onClick={() => paging.setPage(paging.page + 1)}>次へ</button>
  </nav>;
}
