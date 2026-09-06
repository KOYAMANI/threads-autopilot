/**
 * AI 呼び出しのモック（SPEC §11 と同じ形。`AI_MOCK=1` かつ DEV ビルドのときだけ）。
 *
 * `lib/ai.ts` の DEV ガードの内側から動的 import される。本番ビルド（`__DEV__=false`）
 * ではデッドコード除去でバンドルから消える（`scripts/check-bundle.sh` が識別子を数える）。
 *
 * 返すのは固定の JSON 文字列。プロンプトの中身によって決まる決定的な値で、乱数は使わない。
 * ブラウザでの確認とテストのためのものなので、実際のモデルの挙動は真似ない。
 */

/** プロンプトから「型を変えて3案」の 3 を読む。 */
function requestedCount(user: string): number {
  const m = /型を変えて(\d+)案/.exec(user);
  const n = m ? Number.parseInt(m[1] ?? "3", 10) : 3;
  return Math.min(5, Math.max(1, Number.isFinite(n) ? n : 3));
}

function firstSection(user: string, heading: string): string {
  const re = new RegExp(`# ${heading}\\n([\\s\\S]*?)(?:\\n\\n# |$)`);
  return (re.exec(user)?.[1] ?? "").trim();
}

/** 参考情報の見出し（`## タイトル`）を1つ拾って basis に使う。 */
function sourceTitle(user: string): string {
  const block = firstSection(user, "参考情報（ここに無いことを事実として書かない）");
  const m = /^## (.+)$/m.exec(block);
  return m?.[1]?.trim() ?? "指示";
}

const MOCK_HOOKS = ["呼びかけ型", "警告型", "数字型", "意外性型", "疑問型"];

const MOCK_BODIES = [
  "毎朝の30分が消えている人へ。\n\n下書きを1本ためるだけで、翌朝の迷いが消えます。\n夜のうちに書くのは1行目だけでいい。",
  "下書きをためないまま朝を迎えると、たいてい投稿できません。\n\n決めるのは順番だけ。\n1行目、数字、締め。この3つを夜に置いておく。",
  "3日分の下書きがあると、投稿は続きます。\n\n1日目に型を決める。\n2日目に数字を入れる。\n3日目に締めを直す。",
  "書けない日は、書くことがないのではなく決まっていないだけ。\n\n1行目を先に決めると、残りは埋まります。",
  "投稿が止まるのは、やる気ではなく在庫の問題です。\n\n下書きを3本持つところから始める。",
];

const MOCK_COMMENTS = [
  ["続きはこちらにまとめました。", "気になったら覗いてみてください。"],
  ["やり方はここに置いています。"],
  ["この順番でやると迷いません。", "詰まったら1行目に戻る。"],
  ["まとめはこちら。"],
  ["補足はこちらです。"],
];

export type MockAiInput = { system: string; user: string; provider: string };

/** 生成の生応答（JSON 文字列）を返す。`lib/ai.ts` の `generateRaw` から呼ばれる。 */
export default function aiMockCall(input: MockAiInput): string {
  // revise は1案だけ返す（直前の案の本文の先頭に指示を織り込んだ体で差し替える）
  const isRevise = input.user.includes("# 直前の案");
  if (isRevise) {
    const instruction = firstSection(input.user, "指示");
    let prev: { hook?: string; body?: string; comments?: string[] } = {};
    const block = /# 直前の案\n([\s\S]*?)(?:\n\n# |$)/.exec(input.user)?.[1] ?? "";
    try {
      prev = JSON.parse(block) as typeof prev;
    } catch {
      prev = {};
    }
    return JSON.stringify({
      candidates: [
        {
          hook: prev.hook ?? "呼びかけ型",
          body: `${(prev.body ?? MOCK_BODIES[0]!).split("\n")[0]}\n\n（${instruction || "指示なし"}を反映しました）\n${(prev.body ?? MOCK_BODIES[0]!).split("\n").slice(1).join("\n")}`.trim(),
          comments: prev.comments ?? MOCK_COMMENTS[0]!,
          basis: "直前の案を指示どおりに直しました",
        },
      ],
    });
  }

  const n = requestedCount(input.user);
  const basisFrom = sourceTitle(input.user);
  const candidates = Array.from({ length: n }, (_, i) => ({
    hook: MOCK_HOOKS[i % MOCK_HOOKS.length]!,
    body: MOCK_BODIES[i % MOCK_BODIES.length]!,
    comments: MOCK_COMMENTS[i % MOCK_COMMENTS.length]!,
    basis: `「${basisFrom}」の内容を使いました`,
  }));
  return JSON.stringify({ candidates });
}
