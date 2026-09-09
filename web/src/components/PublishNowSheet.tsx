import { useEnvironment } from "../api/environment";
import { usePublishingCapability } from "../api/publishing";
import Sheet from "./Sheet";

/** 即時公開は予約と分離し、対象アカウントと全ツリーを確認してから送信する。 */
export default function PublishNowSheet({
  open, onClose, onConfirm, username, body, comments, canPublish, busy = false, resume = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  username: string;
  body: string;
  comments: string[];
  canPublish: boolean;
  busy?: boolean;
  resume?: boolean;
}) {
  const environment = useEnvironment();
  const capability = usePublishingCapability();
  const staging = environment.data?.environment === "staging" && capability.isSuccess && !capability.data?.enabled;
  const enabled = canPublish && environment.isSuccess && capability.data?.enabled === true && !busy;
  return <Sheet open={open} onClose={() => { if (!busy) onClose(); }} title="今すぐ投稿の確認">
    <p><strong>@{username}</strong> に投稿します。</p>
    <div className="publish-preview section">
      {[body, ...comments.filter(comment => comment.trim() !== "")].map((text, index) => <div className="card" key={index}>
        <p className="muted">{index + 1}投稿目</p><p className="publish-preview-text">{text}</p>
      </div>)}
    </div>
    {capability.isPending ? <p className="muted section" role="status">投稿権限を確認しています…</p>
      : capability.isError ? <p className="msg msg-bad section" role="alert">投稿権限を確認できません。<button type="button" className="btn btn-sub" onClick={() => void capability.refetch()}>再確認する</button></p>
      : staging ? <p className="msg msg-warn section" role="status">この検証用ログインでは実投稿・予約実行を停止しています。下書きとして保存してください。</p>
      : environment.isError ? <p className="msg msg-bad section" role="alert">環境を確認できないため投稿できません。<button type="button" className="btn btn-sub section" onClick={() => void environment.refetch()}>再確認する</button></p>
      : environment.isPending ? <p className="muted section" role="status">投稿環境を確認しています…</p>
      : <p className="muted section">確定すると、予約時刻を待たずに投稿処理を開始します。反映まで少し時間がかかることがあります。{resume && "すでに公開済みの部分は残し、続きから再開します。"}</p>}
    {!canPublish && <p className="msg msg-warn section">設定でThreads APIを連携してください。</p>}
    <div className="publish-actions section">
      <button type="button" className="btn btn-sub" disabled={busy} onClick={onClose}>戻る</button>
      <button type="button" className="btn" disabled={!enabled} onClick={() => { if (enabled) onConfirm(); }}>{busy ? "送信しています…" : staging ? "このログインには投稿権限がありません" : "この内容で今すぐ投稿"}</button>
    </div>
  </Sheet>;
}
