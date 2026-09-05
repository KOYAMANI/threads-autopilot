/**
 * ビルド時に esbuild の define で置き換わる定数（SPEC §11）。
 *
 * - `wrangler.toml` の `[define] __DEV__ = "false"`（本番安全側の既定）
 * - `npm run dev:worker` = `wrangler dev --define __DEV__:true`
 * - `worker/vitest.config.ts` の `define: { __DEV__: "true" }`
 *
 * **`if (__DEV__ && ...)` の形でこの識別子を直接書くこと。**
 * 別モジュールの定数（`env.ts` の `DEV`）や関数（`shouldUseMock()`）を経由すると
 * esbuild のデッドコード除去が効かず、`mock/` が本番バンドルに残る。
 * 回帰確認は `scripts/check-bundle.sh`。
 */
declare const __DEV__: boolean;
