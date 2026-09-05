import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

// isolatedStorage の外側（beforeAll）で流すので、各テストはマイグレーション済みの空DBから始まる。
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
