import { ApiError } from "../api/client";
export default function AiErrorNotice({error}: {error: unknown}) {
  if (!error) return null;
  const e = error instanceof ApiError ? error : null;
  const detail = e?.detail && typeof e.detail === "object" ? e.detail as Record<string, unknown> : {};
  const diagnostic = JSON.stringify({code: e?.code ?? "UNKNOWN", status: e?.status, ...Object.fromEntries(["requestId", "category", "reason", "upstreamStatus", "retryable"].filter(k => ["string", "number", "boolean"].includes(typeof detail[k])).map(k => [k, detail[k]]))}, null, 2);
  return <div role="alert" className="msg msg-bad section"><p>{error instanceof Error ? error.message : "処理に失敗しました"}</p><details><summary>診断情報（運営への共有用）</summary><pre style={{whiteSpace:"pre-wrap", overflowWrap:"anywhere"}}>{diagnostic}</pre></details></div>;
}
