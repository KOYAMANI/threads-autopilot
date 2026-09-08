import { usePublishingCapability } from "../api/publishing";
import { useEnvironment } from "../api/environment";

export default function EnvironmentNotice() {
  const { data } = useEnvironment();
  const capability = usePublishingCapability();
  if (data?.environment !== "staging") return null;
  return <aside className="environment-notice" role="status"><strong>STAGING · 検証環境</strong><span>{capability.data?.review ? "審査用 · 接続したサブアカウントへの手動投稿・予約が有効（メール停止中）" : "実投稿・予約実行・メール送信は停止中"}</span></aside>;
}
