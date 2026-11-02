/**
 * 投稿に付ける画像のアップロード（DECISIONS 2026-10-30）。
 *
 * Threads が受け付けるのは JPEG / PNG・8MB まで・幅1440pxまで（超えると Threads 側で縮む）。
 * ここで横幅1440pxまで縮め、JPEG にしてから送る。WebP や HEIC（Safari）もこれで出せる。
 * 画像変換の依存は足さず、ブラウザの canvas で行う。
 */
import { MAX_MEDIA_BYTES } from "@tap/shared";
import { ApiError } from "./client";

export const ACCEPT_IMAGES = "image/jpeg,image/png,image/webp,image/heic,image/heif";
const MAX_WIDTH = 1440;
/** Threads の縦横比の上限（10:1） */
const MAX_RATIO = 10;

export function isAcceptedImage(file: File): boolean {
  return /^image\/(jpeg|png|webp|heic|heif)$/.test(file.type) || /\.(heic|heif)$/i.test(file.name);
}

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; done: () => void }> {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, done: () => bitmap.close() };
  } catch {
    // createImageBitmap が読めない形式（Safari の HEIC など）は <img> に読ませる
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } catch {
      URL.revokeObjectURL(url);
      throw new ApiError("BAD_IMAGE", "この画像は読み込めませんでした。JPEG か PNG で保存し直してください", 0);
    }
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
  }
}

/** 横幅1440pxまで縮めた JPEG にする。 */
export async function prepareImage(file: Blob): Promise<Blob> {
  const image = await decode(file);
  try {
    const { width, height } = image;
    if (Math.max(width, height) / Math.max(1, Math.min(width, height)) > MAX_RATIO) {
      throw new ApiError("BAD_IMAGE", "縦横の比が10:1より細長い画像は付けられません", 0);
    }
    const scale = Math.min(1, MAX_WIDTH / width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const g = canvas.getContext("2d")!;
    // 透過は白で埋める（JPEG は透過を持てない）
    g.fillStyle = "#fff";
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(image.source, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.88, 0.75, 0.6]) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.size <= MAX_MEDIA_BYTES) return blob;
    }
    throw new ApiError("BAD_IMAGE", "画像が大きすぎます（8MBまで）", 0);
  } finally {
    image.done();
  }
}

/** 縮めて送り、Threads が取りに来る公開 URL を返す。 */
export async function uploadImage(accountId: string, file: Blob): Promise<string> {
  const body = await prepareImage(file);
  let res: Response;
  try {
    res = await fetch(`/api/accounts/${accountId}/media`, {
      method: "POST",
      headers: { "X-Requested-With": "fetch", "Content-Type": body.type },
      credentials: "include",
      body,
    });
  } catch {
    throw new ApiError("NETWORK", "通信に失敗しました。電波の状況をご確認ください", 0);
  }
  const json = (await res.json().catch(() => null)) as
    | { ok: true; data: { url: string } }
    | { ok: false; error: { code: string; message: string } }
    | null;
  if (!json) throw new ApiError("INTERNAL", "サーバーの応答を読めませんでした", res.status);
  if (!json.ok) throw new ApiError(json.error.code, json.error.message, res.status);
  return json.data.url;
}
