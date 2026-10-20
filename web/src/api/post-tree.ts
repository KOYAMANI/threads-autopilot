import type { PostSummary } from "@tap/shared";
import { api } from "./client";
export type TreeResult = {post:PostSummary;excludedReplies:number;pending:boolean};
export async function loadPostTree(accountId:string, postId:string, kind:"tree"|"reference"="tree", signal?:AbortSignal):Promise<TreeResult> {
  while (!signal?.aborted) {
    const result=await api.get<TreeResult>(`/accounts/${accountId}/posts/${postId}/${kind}`,signal);
    if (!result.pending) return result;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error("取得を中止しました");
}
