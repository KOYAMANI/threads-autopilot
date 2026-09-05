#!/usr/bin/env bash
#
# 本番バンドルに Threads モック（worker/src/mock/*）が入っていないことを確かめる（SPEC §11）。
#
# `lib/threads.ts` の `call()` は M1 時点でどこからも呼ばれていないので、素直に
# `wrangler deploy --dry-run` しても「未使用だから消えている」だけで、DEV ガードが
# 効いているのか区別できない。そこで **`call()` を到達可能にした一時エントリ**を作って
# ビルドし、それでもモックの識別子が0件であることを見る。
#
#   ./scripts/check-bundle.sh
#
# 終了コード 0 = モックなし（OK） / 1 = モックが混入（NG）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT="$(mktemp -d "${TMPDIR:-/tmp}/tap-bundle-XXXXXX")"
PROBE="worker/src/__bundle_probe.ts"

cleanup() {
  rm -f "$ROOT/$PROBE"
  rm -rf "$OUT"
}
trap cleanup EXIT

# call() を到達可能にする一時エントリ（このスクリプトが作って必ず消す）
cat > "$ROOT/$PROBE" <<'PROBE_EOF'
// 一時ファイル。scripts/check-bundle.sh が生成し、実行後に削除する。
// lib/threads.ts の call() をエントリから到達可能にした状態でバンドルし、
// __DEV__=false のとき mock/ が消えることを確かめるためだけに存在する。
import { createBudget } from "./lib/budget";
import { call } from "./lib/threads";
import type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const token = new URL(request.url).searchParams.get("t") ?? "";
    const data = await call(token, "GET", "/me", { fields: "id" }, { budget: createBudget({}), env });
    return Response.json(data);
  },
};
PROBE_EOF

echo "▸ 一時エントリ ($PROBE) で本番ビルド（__DEV__ は wrangler.toml の false）"
npx wrangler deploy --dry-run --outdir "$OUT" "$PROBE" > "$OUT/build.log" 2>&1 || {
  echo "✗ ビルドに失敗しました"
  cat "$OUT/build.log"
  exit 1
}

BUNDLE="$OUT/__bundle_probe.js"
[ -f "$BUNDLE" ] || BUNDLE="$(find "$OUT" -maxdepth 1 -name '*.js' | head -1)"
if [ ! -f "$BUNDLE" ]; then
  echo "✗ 出力バンドルが見つかりません"
  ls -la "$OUT"
  exit 1
fi

echo "▸ バンドル: $(basename "$BUNDLE") ($(wc -c < "$BUNDLE" | tr -d ' ') bytes)"

# call() が実際にバンドルへ入っていること（＝到達可能な状態で検査できていること）
if ! grep -q 'graph.threads.net' "$BUNDLE"; then
  echo "✗ call() がバンドルに入っていません。この検査は無意味なので中止します"
  exit 1
fi
echo "  call() は到達可能（graph.threads.net あり）"

# mock/threads.ts にしか無い識別子
MARKERS=(SEED_TEXTS "Unsupported mock path" MockThreadsError mockCall callMock seedStore storeFor metricsFor resetMock "mock/threads")
FOUND=0
for m in "${MARKERS[@]}"; do
  n="$(grep -c -- "$m" "$BUNDLE" || true)"
  printf '  %-24s %s件\n' "$m" "$n"
  [ "$n" -eq 0 ] || FOUND=1
done

if [ "$FOUND" -ne 0 ]; then
  echo "✗ NG: モックが本番バンドルに入っています（lib/threads.ts の分岐に __DEV__ を直接書くこと）"
  exit 1
fi

echo "✓ OK: モックは本番バンドルに含まれていません"
