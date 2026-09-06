// 一時ファイル（独立検証用）。RFC 8291 §5 の公式テストベクタで decryptPayload を検証する。
import { describe, expect, it } from "vitest";
import { base64UrlToBytes } from "../src/lib/crypto";
import { decryptPayload, encryptPayload } from "../src/lib/webpush";

const UA_PRIVATE_D = "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94";
const UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH_SECRET = "BTBZMqHH6r4Tts7J_aSIgg";
const BODY =
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
  "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
  "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";
const b64u = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("RFC 8291 §5 の公式テストベクタ", () => {
  const pub = base64UrlToBytes(UA_PUBLIC);
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: UA_PRIVATE_D,
    x: b64u(pub.slice(1, 33)),
    y: b64u(pub.slice(33, 65)),
    ext: true,
  };

  it("RFC の暗号文が『When I grow up, I want to be a watermelon』に復号できる", async () => {
    const plain = await decryptPayload(
      base64UrlToBytes(BODY),
      jwk,
      base64UrlToBytes(AUTH_SECRET),
    );
    expect(plain).toBe("When I grow up, I want to be a watermelon");
  });

  it("自前の encryptPayload の出力も、同じ受信鍵で復号できる（往復）", async () => {
    const body = await encryptPayload(
      { endpoint: "https://x.example/y", keys: { p256dh: UA_PUBLIC, auth: AUTH_SECRET } },
      "往復",
    );
    expect(await decryptPayload(body, jwk, base64UrlToBytes(AUTH_SECRET))).toBe("往復");
  });
});
