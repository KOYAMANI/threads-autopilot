/** 認証まわりの React Query フック（SPEC §12.2）。 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MeResponse, RegisterRequest, LoginRequest } from "@tap/shared";
import { api, ApiError } from "./client";

export const meKey = ["me"] as const;

/** 未ログインは null を返す（401 をエラー扱いにしない）。 */
export function useMe() {
  return useQuery({
    queryKey: meKey,
    retry: false,
    staleTime: 30_000,
    queryFn: async (): Promise<MeResponse | null> => {
      try {
        return await api.get<MeResponse>("/auth/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequest) => api.post("/auth/login", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: meKey }),
  });
}

export function useRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RegisterRequest) => api.post("/auth/register", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: meKey }),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post("/auth/logout"),
    onSuccess: () => qc.setQueryData(meKey, null),
  });
}

export function useForgot() {
  return useMutation({
    mutationFn: (email: string) => api.post("/auth/forgot", { email }),
  });
}

export function useReset() {
  return useMutation({
    mutationFn: (body: { token: string; password: string }) => api.post("/auth/reset", body),
  });
}
