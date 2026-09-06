#!/usr/bin/env bash
#
# 本番バンドルにモック（worker/src/mock/*）が入っていないことを確かめる（SPEC §11）。
# 対象は Threads のモック（mock/threads.ts）と AI のモック（mock/ai.ts、M5）の両方。
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
# mock/ai.ts にしか無い識別子（M5）
MARKERS+=(MOCK_BODIES MOCK_COMMENTS MOCK_HOOKS aiMockCall requestedCount sourceTitle instructionOf stripMockNote "mock/ai")

# env の名前（THREADS_MOCK / AI_MOCK）はマーカーに入れない。
# `shouldUseMock()` `mockAvailable()`（/api/health の表示用）は `DEV` 経由で書いてあり、
# 本番バンドルにも関数ごと残る。残るのは **名前と false 判定だけ** で mock/ の中身ではない。
# ここで見たいのは「モックの実装が入っていないこと」なので、判定は mock/*.ts にしか
# 無い識別子で行う（上の2行）。env 名を足すと、この正常な残りで必ず落ちる。

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

  # call() / callAi() が実際にバンドルへ入っていること（＝到達可能な状態で検査できていること）
  if ! grep -q 'graph.threads.net' "$bundle"; then
    echo "✗ call() がバンドルに入っていません。この検査は無意味なので中止します"
    return 1
  fi
  echo "  call() は到達可能（graph.threads.net あり）"
  if ! grep -q 'generativelanguage.googleapis.com' "$bundle"; then
    echo "✗ lib/ai.ts がバンドルに入っていません。この検査は無意味なので中止します"
    return 1
  fi
  echo "  callAi() は到達可能（generativelanguage.googleapis.com あり）"

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
  echo "✗ NG: モックが本番バンドルに入っています（lib/threads.ts と lib/ai.ts の分岐に __DEV__ を直接書くこと）"
  exit 1
fi

# 2. call() を直接叩くだけの一時エントリ
cat > "$ROOT/$PROBE" <<'PROBE_EOF'
// 一時ファイル。scripts/check-bundle.sh が生成し、実行後に削除する。
// lib/threads.ts の call() をエントリから到達可能にした状態でバンドルし、
// __DEV__=false のとき mock/ が消えることを確かめるためだけに存在する。
import { createBudget } from "./lib/budget";
import { call } from "./lib/threads";
import { generateRaw } from "./lib/ai";
import type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const token = new URL(request.url).searchParams.get("t") ?? "";
    const budget = createBudget({});
    const data = await call(token, "GET", "/me", { fields: "id" }, { budget, env });
    const text = await generateRaw(
      env,
      {
        provider: "gemini",
        model: "gemini-2.5-flash",
        apiKey: token,
        system: "s",
        user: "u",
        appOrigin: env.APP_ORIGIN,
      },
      { budget },
    );
    return Response.json({ data, text });
  },
};
PROBE_EOF

mkdir -p "$OUT/probe"
if ! check_entry "一時エントリ ($PROBE)" "$PROBE" "$OUT/probe"; then
  echo "✗ NG: モックが本番バンドルに入っています（lib/threads.ts と lib/ai.ts の分岐に __DEV__ を直接書くこと）"
  exit 1
fi

echo "✓ OK: モックは本番バンドルに含まれていません（本番エントリ・一時エントリの両方）"
