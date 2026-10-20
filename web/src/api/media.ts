import type { MediaUploadResponse } from "@tap/shared";
import { api } from "./client";

export function uploadPostMedia(accountId: string, file: File, signal?: AbortSignal): Promise<MediaUploadResponse> {
  return api.upload<MediaUploadResponse>(`/media?accountId=${encodeURIComponent(accountId)}`, file, signal);
}
