import { useState } from "react";
import type { AccountSummary } from "@tap/shared";
export default function AccountAvatar({account}: {account: AccountSummary | null}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = account?.avatarUrl;
  return <span className="account-avatar" aria-hidden="true">{url && url !== failedUrl ? <img src={url} alt="" referrerPolicy="no-referrer" onError={()=>setFailedUrl(url)} /> : account?.username.slice(0,1).toUpperCase() ?? "+"}</span>;
}
