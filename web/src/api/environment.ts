import { useQuery } from "@tanstack/react-query";

export function useEnvironment() {
  return useQuery({
    queryKey: ["environment"],
    staleTime: Infinity,
    queryFn: async () => {
      const response = await fetch("/api/health");
      if (!response.ok) throw new Error("Environment check failed");
      const data = await response.json() as { environment?: string };
      if (!["local", "staging", "production"].includes(data.environment ?? "")) {
        throw new Error("Unknown environment");
      }
      return data;
    },
  });
}
