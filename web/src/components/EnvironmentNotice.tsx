import { usePublishingCapability } from "../api/publishing";
import { useEnvironment } from "../api/environment";

export default function EnvironmentNotice() {
  const { data } = useEnvironment();
  const capability = usePublishingCapability();
  if (data?.environment !== "staging") return null;
  return <aside className="environment-notice" role="status"><strong>STAGING · 検証環境</strong><span>{capability.isPending ? "投稿権限を確認しています…" : capability.isError ? "投稿権限を確認できません。再読み込みしてください" : capability.data?.enabled ? capability.data.review ? "審査用 · サブアカウントへの手動投稿・予約が有効（メール停止中）" : "生徒ベータ · 許可アカウントへの手動投稿・予約が有効。実際に公開されます（自動投稿・メール停止中）" : "このログインには実投稿・予約の権限がありません。許可済みの生徒ログインでは投稿できます（メール停止中）"}</span></aside>;
}
