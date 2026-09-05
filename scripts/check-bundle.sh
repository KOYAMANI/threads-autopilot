#!/usr/bin/env bash
#
# 本番バンドルに Threads モック（worker/src/mock/*）が入っていないことを確かめる（SPEC §11）。
#
#   ./scripts/check-bundle.sh
#
# 2つのエントリで見る:
#   1. 本番エントリ（wrangler.toml の main = worker/src/index.ts）
#      M2 でジョブが `call()` を呼ぶようになったので、これが本番そのものの確認になる
#   2. 一時エントリ（call() を直接叩くだけ。このスクリプトが作って必ず消す）
#      本番エントリから call() への到達経路が将来切れても、ガードの効きを測り続けるための保険
#
# どちらも「call() がバンドルに入っている（＝検査が意味を持つ）」ことを先に確かめ、
# そのうえでモック由来の識別子が0件であることを見る。
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

# mock/threads.ts にしか無い識別子
MARKERS=(SEED_TEXTS "Unsupported mock path" MockThreadsError mockCall callMock seedStore storeFor metricsFor resetMock "mock/threads")

# $1=ラベル $2=エントリ（空なら wrangler.toml の main） $3=出力ディレクトリ
check_entry() {
  local label="$1" entry="$2" dir="$3"
  echo "▸ $label で本番ビルド（__DEV__ は wrangler.toml の false）"
  if [ -n "$entry" ]; then
    npx wrangler deploy --dry-run --outdir "$dir" "$entry" > "$dir/build.log" 2>&1 || {
      echo "✗ ビルドに失敗しました"; cat "$dir/build.log"; return 1
    }
  else
    npx wrangler deploy --dry-run --outdir "$dir" > "$dir/build.log" 2>&1 || {
      echo "✗ ビルドに失敗しました"; cat "$dir/build.log"; return 1
    }
  fi

  local bundle
  bundle="$(find "$dir" -maxdepth 1 -name '*.js' | head -1)"
  if [ ! -f "$bundle" ]; then
    echo "✗ 出力バンドルが見つかりません"; ls -la "$dir"; return 1
  fi
  echo "  バンドル: $(basename "$bundle") ($(wc -c < "$bundle" | tr -d ' ') bytes)"

  # call() が実際にバンドルへ入っていること（＝到達可能な状態で検査できていること）
  if ! grep -q 'graph.threads.net' "$bundle"; then
    echo "✗ call() がバンドルに入っていません。この検査は無意味なので中止します"
    return 1
  fi
  echo "  call() は到達可能（graph.threads.net あり）"

  local found=0 n
  for m in "${MARKERS[@]}"; do
    n="$(grep -c -- "$m" "$bundle" || true)"
    printf '  %-24s %s件\n' "$m" "$n"
    [ "$n" -eq 0 ] || found=1
  done
  [ "$found" -eq 0 ] || return 1
  return 0
}

# 1. 本番エントリ（wrangler.toml の main）
mkdir -p "$OUT/main"
if ! check_entry "本番エントリ (worker/src/index.ts)" "" "$OUT/main"; then
  echo "✗ NG: モックが本番バンドルに入っています（lib/threads.ts の分岐に __DEV__ を直接書くこと）"
  exit 1
fi

# 2. call() を直接叩くだけの一時エントリ
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

mkdir -p "$OUT/probe"
if ! check_entry "一時エントリ ($PROBE)" "$PROBE" "$OUT/probe"; then
  echo "✗ NG: モックが本番バンドルに入っています（lib/threads.ts の分岐に __DEV__ を直接書くこと）"
  exit 1
fi

echo "✓ OK: モックは本番バンドルに含まれていません（本番エントリ・一時エントリの両方）"
