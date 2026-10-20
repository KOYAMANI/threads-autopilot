import { useQuery } from "@tanstack/react-query";

/** `/api/health` の environment。staging 以外は null 扱いで何も出さない */
export function useEnvironment(): string | null {
  const { data } = useQuery({
    queryKey: ["environment"],
    staleTime: Infinity,
    queryFn: async () => {
      const response = await fetch("/api/health");
      if (!response.ok) throw new Error("Environment check failed");
      return response.json() as Promise<{ environment?: string }>;
    },
  });
  return data?.environment ?? null;
}

/**
 * 枠の中に置く小さな札。PC はサイドバーの下（Tabs）、スマホは上のバー（TopBar）に差し込む。
 * 中身の上に浮かべないので、作る画面の帯やボタンと重ならない（2026-10-20）。
 */
export function EnvChip({ label = "検証環境" }: { label?: string }) {
  const env = useEnvironment();
  if (env !== "staging") return null;
  return <span className="env-chip" role="status">{label}</span>;
}

/** 枠の無いページ（ログインなど）用の固定表示。アプリの枠の中では CSS で隠す */
export default function EnvironmentNotice() {
  const env = useEnvironment();
  if (env !== "staging") return null;
  return <aside className="environment-notice" role="status"><strong>STAGING · 検証環境</strong><span>実投稿・メール送信は停止中</span></aside>;
}
