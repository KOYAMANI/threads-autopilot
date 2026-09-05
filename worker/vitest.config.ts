import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

const dir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => {
  // マイグレーションを読み、setup で各テストの D1 に流し込む（SPEC §14）
  const migrations = await readD1Migrations(path.join(dir, "migrations"));

  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          compatibilityDate: "2026-08-01",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: { DB: "test-db" },
          bindings: {
            TEST_MIGRATIONS: migrations,
            APP_ORIGIN: "http://localhost:5173",
            DEFAULT_TZ: "Asia/Tokyo",
            MAX_SUBREQUESTS: "300",
            MAX_DB_QUERIES: "800",
            JOB_TIME_BUDGET_MS: "20000",
            THREADS_MOCK: "1",
            REPLY_TWO_STEP: "0",
            // テスト専用のダミー値。実鍵ではない
            ENC_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
            SESSION_SECRET: "test-session-secret-test-session-secret-0123",
            ADMIN_SECRET: "test-admin-secret",
          },
        },
      }),
    ],
    // wrangler.toml の [define] と同じ役割。テストではモックを有効にする（SPEC §11）
    define: { __DEV__: "true" },
    resolve: {
      alias: {
        "@tap/shared": path.join(dir, "../shared/src/index.ts"),
      },
    },
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
