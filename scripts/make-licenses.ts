/**
 * ライセンスキーの発行（SPEC §5.4）。管理APIを叩くだけ。
 *
 * 使い方:
 *   ADMIN_SECRET=... npm run licenses -- --count 10 --note "2026-09 販売分"
 *   ADMIN_SECRET=... npm run licenses -- --count 5 --origin https://threads-autopilot.example.workers.dev
 *   ADMIN_SECRET=... npm run licenses -- --revoke <license-id>
 *
 * ADMIN_SECRET は環境変数から読む（コマンドラインに書かない・ログに出さない）。
 * 未指定なら .dev.vars を見る。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function devVar(name: string): string | undefined {
  const file = path.join(ROOT, ".dev.vars");
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`).exec(line);
    if (m) return m[1]!.trim().replace(/^["']|["']$/g, "") || undefined;
  }
  return undefined;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallback;
}

function usage(): never {
  console.log(
    [
      "使い方:",
      "  ADMIN_SECRET=... npm run licenses -- --count 10 [--note メモ] [--origin URL]",
      "  ADMIN_SECRET=... npm run licenses -- --revoke <license-id> [--origin URL]",
      "",
      "  --origin の既定は http://127.0.0.1:8787（wrangler dev）",
      "  ADMIN_SECRET は環境変数か .dev.vars から読む",
    ].join("\n"),
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const secret = process.env.ADMIN_SECRET ?? devVar("ADMIN_SECRET");
  if (!secret) {
    console.error("ADMIN_SECRET が見つかりません（環境変数か .dev.vars に入れてください）");
    process.exit(1);
  }
  const origin = arg("origin", "http://127.0.0.1:8787")!;
  const revokeId = arg("revoke");

  const headers = {
    "Content-Type": "application/json",
    "X-Requested-With": "fetch",
    "X-Admin-Secret": secret,
  };

  if (revokeId) {
    const res = await fetch(`${origin}/api/admin/licenses/${encodeURIComponent(revokeId)}/revoke`, {
      method: "POST",
      headers,
    });
    const json = (await res.json()) as { ok: boolean; data?: unknown; error?: { message: string } };
    if (!json.ok) {
      console.error(`失効に失敗しました: ${json.error?.message ?? res.status}`);
      process.exit(1);
    }
    console.log(`失効しました: ${revokeId}`);
    return;
  }

  const count = Number.parseInt(arg("count", "") ?? "", 10);
  if (!Number.isFinite(count) || count < 1) usage();
  const note = arg("note");

  const res = await fetch(`${origin}/api/admin/licenses`, {
    method: "POST",
    headers,
    body: JSON.stringify(note ? { count, note } : { count }),
  });
  const json = (await res.json()) as {
    ok: boolean;
    data?: { keys: Array<{ id: string; key: string }> };
    error?: { message: string };
  };
  if (!json.ok || !json.data) {
    console.error(`発行に失敗しました: ${json.error?.message ?? res.status}`);
    process.exit(1);
  }
  console.log("id,key");
  for (const k of json.data.keys) console.log(`${k.id},${k.key}`);
}

void main();
