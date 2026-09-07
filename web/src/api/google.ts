import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
export type GoogleStatus = {
  configured: boolean;
  connected: boolean;
  status: string;
  spreadsheetUrl: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
};
export function useGoogleStatus() {
  return useQuery({
    queryKey: ["google", "status"],
    queryFn: () => api.get<GoogleStatus>("/google/status"),
    refetchInterval: 15000,
  });
}
export function useGoogleConnect() {
  return useMutation({
    mutationFn: () => api.post<{ url: string }>("/google/start"),
    onSuccess: (r) => window.location.assign(r.url),
  });
}
export function useGoogleSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/google/sync"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["google"] }),
  });
}
export function useGoogleDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del("/google/connection"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["google"] }),
  });
}

export function useGoogleRepair() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/google/repair"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["google"] }),
  });
}
