import { useQuery } from "@tanstack/react-query";

export default function EnvironmentNotice() {
  const {data} = useQuery({queryKey:["environment"],staleTime:Infinity,queryFn:async () => {
    const response=await fetch("/api/health");
    if (!response.ok) throw new Error("Environment check failed");
    return response.json() as Promise<{environment?:string}>;
  }});
  if (data?.environment !== "staging") return null;
  return <aside className="environment-notice" role="status"><strong>STAGING · 検証環境</strong><span>実投稿・メール送信は停止中</span></aside>;
}
