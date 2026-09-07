import { useEnvironment } from "../api/environment";

export default function EnvironmentNotice() {
  const { data } = useEnvironment();
  if (data?.environment !== "staging") return null;
  return <aside className="environment-notice" role="status"><strong>STAGING · 検証環境</strong><span>実投稿・メール送信は停止中</span></aside>;
}
