/** Only follow a continuous chain authored by this account. Never bridge an unknown/other author. */
export function ownThread<T extends {id:string; reply_to_id?:string|null}>(rootId:string, replies:T[]):T[] {
  const out:T[]=[];
  const seen=new Set([rootId]);
  let parent=rootId;
  while (true) {
    const next=replies.find(reply=>reply.reply_to_id===parent && !seen.has(reply.id));
    if (!next) break;
    out.push(next);seen.add(next.id);parent=next.id;
  }
  return out;
}


import type { ThreadsMedia, ThreadsPage, CallOptions } from "./threads";
import { call } from "./threads";
import type { Db } from "./db";
import { accountToken, type AccountRow } from "./accounts";

export type OwnTree = {
  chain: ThreadsMedia[];
  parent: string;
  after?: string;
  best?: ThreadsMedia;
  complete: boolean;
  checkedAt: number;
};
export function readOwnTree(json?: string | null): OwnTree | null {
  try {
    const value = JSON.parse(json ?? "null") as OwnTree | null;
    return value && Array.isArray(value.chain) && typeof value.parent === "string" ? value : null;
  } catch { return null; }
}

/** Process every page of direct replies before choosing the earliest self reply. */
export function advanceOwnTree(state: OwnTree, page: ThreadsPage, username: string): OwnTree {
  if (!Array.isArray(page.data)) throw new Error("返信の応答を確認できませんでした");
  const next = { ...state, chain: [...state.chain] };
  for (const reply of page.data) {
    // Explicit false always wins. Missing ownership may be verified by username.
    const own = reply.is_reply_owned_by_me === true ||
      (reply.is_reply_owned_by_me !== false && !!username && reply.username?.toLowerCase() === username.toLowerCase());
    if (!own || !reply.id || (reply.replied_to?.id && reply.replied_to.id !== state.parent)) continue;
    if (!reply.timestamp || !Number.isFinite(Date.parse(reply.timestamp))) throw new Error("返信の投稿日時を確認できませんでした");
    if (!next.best || Date.parse(reply.timestamp) < Date.parse(next.best.timestamp!) ||
      (reply.timestamp === next.best.timestamp && reply.id < next.best.id)) next.best = reply;
  }
  if (page.paging?.next) {
    const after = page.paging.cursors?.after;
    if (!after || after === state.after) throw new Error("返信の次ページを確認できませんでした");
    next.after = after;
    return next;
  }
  delete next.after;
  if (!next.best) {
    next.complete = true;
    next.checkedAt = Date.now();
    return next;
  }
  if (next.best.id === state.parent || next.chain.some(p => p.id === next.best!.id)) throw new Error("返信のつながりを確認できませんでした");
  next.chain.push(next.best);
  next.parent = next.best.id;
  delete next.best;
  return next;
}

/** One page per request, persisted so long trees resume without truncation. */
export async function resolveOwnTree(db: Db, account: AccountRow, root: {id:string;own_thread_json?:string|null}, options: CallOptions): Promise<OwnTree> {
  const cached = readOwnTree(root.own_thread_json);
  if (cached?.complete && Date.now() - cached.checkedAt < 3600_000) return cached;
  const state: OwnTree = cached && !cached.complete ? cached : {chain:[],parent:root.id,complete:false,checkedAt:0};
  const token = await accountToken(options.env, account);
  const page = await call(token, "GET", `/${encodeURIComponent(state.parent)}/replies`, {
    fields: "id,text,timestamp,username,is_reply_owned_by_me,replied_to,permalink,media_type,media_url,link_attachment_url",
    limit: 100, reverse: false, after: state.after,
  }, options) as ThreadsPage;
  const next = advanceOwnTree(state, page, account.username);
  const json = JSON.stringify(next);
  // Compare-and-swap prevents a slower parallel request from overwriting newer progress.
  const saved = await db.run("UPDATE posts SET own_thread_json=? WHERE account_id=? AND id=? AND own_thread_json IS ?", json, account.id, root.id, root.own_thread_json ?? null);
  if (!saved.changes) {
    const current = await db.first<{own_thread_json:string}>("SELECT own_thread_json FROM posts WHERE account_id=? AND id=?",account.id,root.id);
    return readOwnTree(current?.own_thread_json) ?? next;
  }
  return next;
}
