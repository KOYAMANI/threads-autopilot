/**
 * 画面のスクリーンショットを撮る（`docs/qa.md` の手動確認に添える用）。
 *
 *   npm run dev            # worker(8787) と web(5173) を先に起動しておく
 *   node scripts/shots.mjs m6            # docs/screenshots/m6-*.png
 *   node scripts/shots.mjs m6 --url http://localhost:5173
 *
 * ヘッドレス Chrome を CDP で直接動かす（puppeteer / playwright を依存に足さないため）。
 * ログインはページ内の `fetch` で済ませる — セッション Cookie は `SameSite=Strict` かつ
 * HttpOnly なので、外から注入するより同一オリジンで取らせるほうが確実（SPEC §5.1）。
 *
 * デモアカウント: `demo@example.com` / `password1234`（`npm run seed:demo`）。
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs/screenshots");
const CHROME =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const prefix = process.argv[2] ?? "shot";
const baseUrl = argValue("--url") ?? "http://localhost:5173";
const email = argValue("--email") ?? "demo@example.com";
const password = argValue("--password") ?? "password1234";

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 撮る画面。`before` はページ内で走らせる下ごしらえ（await できる）。 */
const M6_SHOTS = [
  { name: "autopilot", path: "/app/autopilot", full: true },
  {
    name: "autopilot-learning",
    path: "/app/autopilot",
    before: `
      const h = [...document.querySelectorAll('h2')].find((x) => x.textContent.includes('分かったこと'));
      h?.scrollIntoView({ block: 'start' });
      await new Promise((r) => setTimeout(r, 400));
    `,
  },
  { name: "queue", path: "/app/queue", full: true },
  { name: "settings-notifications", path: "/app/settings", full: true },
];

/** ページ内で「見出しの文字で探して押す」小道具。文言が変わったら気づけるよう例外にする。 */
const clickByText = `
  const clickText = (sel, text) => {
    const el = [...document.querySelectorAll(sel)].find((x) => (x.textContent ?? '').includes(text));
    if (!el) throw new Error('見つかりません: ' + text);
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  };
`;

/** M7（SPEC §13 M7）。設定の全部と、アカウント切替。 */
const M7_SHOTS = [
  { name: "settings-accounts", path: "/app/settings", full: true },
  {
    name: "settings-diagnose",
    path: "/app/settings",
    before: `${clickByText} clickText('button', '診断'); await new Promise((r) => setTimeout(r, 1500));`,
  },
  {
    name: "settings-license-export",
    path: "/app/settings",
    before: `
      const h = [...document.querySelectorAll('h2')].find((x) => x.textContent.includes('ライセンス'));
      h?.scrollIntoView({ block: 'start' });
      await new Promise((r) => setTimeout(r, 500));
    `,
  },
  {
    name: "settings-delete",
    path: "/app/settings",
    before: `${clickByText} clickText('button', '退会する'); await new Promise((r) => setTimeout(r, 800));`,
  },
  {
    // ドロワーのアカウント切替（3件が並ぶ）
    name: "drawer",
    path: "/app/home",
    before: `
      document.querySelector('button[aria-label="メニューを開く"]').click();
      await new Promise((r) => setTimeout(r, 700));
    `,
  },
];

const SHOTS = prefix.startsWith("m7") ? M7_SHOTS : M6_SHOTS;

/* ── CDP の最小クライアント ─────────────────────────── */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  return new Cdp(ws);
}

async function waitForJson(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      // まだ起動していない
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`起動を待てませんでした: ${url}`);
}

/* ── 本体 ───────────────────────────────────────────── */

const profile = mkdtempSync(join(tmpdir(), "tap-shots-"));
const port = 9333 + Math.floor(Math.random() * 200);
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
    "--window-size=390,844",
    "about:blank",
  ],
  { stdio: "ignore" },
);

let exitCode = 0;
try {
  const version = await waitForJson(`http://127.0.0.1:${port}/json/version`);
  const cdp = await connect(version.webSocketDebuggerUrl);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

  const call = (m, p = {}) => cdp.send(m, p, sessionId);
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });

  const evaluate = async (expression) => {
    const res = await call("Runtime.evaluate", {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? "評価に失敗しました");
    }
    return res.result.value;
  };

  const goto = async (url) => {
    await call("Page.navigate", { url });
    await new Promise((r) => setTimeout(r, 1800));
  };

  // ログイン（同一オリジンの fetch で Cookie を取る）
  await goto(`${baseUrl}/login`);
  const login = await evaluate(`
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      credentials: 'include',
      body: JSON.stringify({ email: ${JSON.stringify(email)}, password: ${JSON.stringify(password)} }),
    });
    return { status: res.status, body: await res.text() };
  `);
  if (login.status !== 200) {
    throw new Error(`ログインに失敗しました (${login.status}): ${login.body.slice(0, 200)}`);
  }

  mkdirSync(OUT, { recursive: true });
  for (const shot of SHOTS) {
    await goto(`${baseUrl}${shot.path}`);
    await evaluate("await new Promise((r) => setTimeout(r, 1200));");
    if (shot.before) await evaluate(shot.before);

    const params = { format: "png" };
    if (shot.full) {
      const metrics = await call("Page.getLayoutMetrics");
      const h = Math.min(6000, Math.ceil(metrics.cssContentSize.height));
      params.clip = { x: 0, y: 0, width: 390, height: h, scale: 1 };
      params.captureBeyondViewport = true;
    }
    const { data } = await call("Page.captureScreenshot", params);
    const file = join(OUT, `${prefix}-${shot.name}.png`);
    writeFileSync(file, Buffer.from(data, "base64"));
    console.log(`wrote ${file}`);
  }
} catch (e) {
  console.error(String(e instanceof Error ? e.message : e));
  exitCode = 1;
} finally {
  chrome.kill();
  // Chrome が畳むまで少し待ってから消す（すぐ消すと ENOTEMPTY になる）
  await new Promise((r) => setTimeout(r, 500));
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // 消せなくてもテンポラリなので放っておく
  }
}
process.exit(exitCode);
