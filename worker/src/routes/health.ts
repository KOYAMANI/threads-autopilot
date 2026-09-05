/** GET /api/health → {ok, version, mock}（SPEC §7.8 / §11）。 */
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { APP_VERSION } from "../env";
import { mockAvailable } from "../lib/threads";

export function healthRoutes() {
  const r = new Hono<AppEnv>();

  r.get("/", (c) =>
    c.json({
      ok: true as const,
      version: APP_VERSION,
      // THREADS_MOCK=1 かつモック実装がバンドルにあるときだけ true。本番は常に false。
      mock: mockAvailable(c.env),
    }),
  );

  return r;
}
