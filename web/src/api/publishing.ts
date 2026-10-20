import { useQuery } from "@tanstack/react-query";
import { useMe } from "./auth";
import { api } from "./client";
export function usePublishingCapability() {
  const me = useMe();
  return useQuery({queryKey:["publishing-capability", me.data?.user.id], enabled:!!me.data?.user.id,
    staleTime:15_000, retry:false,
    queryFn:()=>api.get<{enabled:boolean;review:boolean}>("/auth/publishing-capability")});
}
