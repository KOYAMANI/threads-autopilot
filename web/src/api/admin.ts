import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AdminLicensesResponse,
  IssueLicensesRequest,
  IssueLicensesResponse,
  SetUserPlanRequest,
  SetUserPlanResponse,
} from "@tap/shared";
import { api } from "./client";
import { meKey } from "./auth";

export function useIssueLicenses() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: IssueLicensesRequest) =>
      api.post<IssueLicensesResponse>("/admin/licenses", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "licenses"] }),
  });
}

export function useAdminLicenses() {
  return useQuery({
    queryKey: ["admin", "licenses"],
    queryFn: () => api.get<AdminLicensesResponse>("/admin/licenses"),
    staleTime: 15_000,
    retry: false,
  });
}

export function useSetUserPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SetUserPlanRequest) =>
      api.put<SetUserPlanResponse>("/admin/plans", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: meKey }),
  });
}
