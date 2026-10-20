/**
 * AI 呼び出しのモック（SPEC §11 と同じ形。`AI_MOCK=1` かつ DEV ビルドのときだけ）。
 *
 * `lib/ai.ts` の DEV ガードの内側から動的 import される。本番ビルド（`__DEV__=false`）
 * ではデッドコード除去でバンドルから消える（`scripts/check-bundle.sh` が識別子を数える）。
 *
 * 返すのは固定の JSON 文字列。プロンプトの中身によって決まる決定的な値で、乱数は使わない。
 * ブラウザでの確認とテストのためのものなので、実際のモデルの挙動は真似ない。
 */

/** プロンプトから「型を変えて3案」「この型で1案」の数を読む。 */
function mockRequestedCount(user: string): number {
  const m = /型を変えて(\d+)案/.exec(user) ?? /この型で(\d+)案/.exec(user);
  const n = m ? Number.parseInt(m[1] ?? "3", 10) : 3;
  return Math.min(5, Math.max(1, Number.isFinite(n) ? n : 3));
}

/** オートパイロットの生成（SPEC §10.3）は型が1つに固定されている。その型名を読む。 */
function mockFixedHookOf(user: string): string | null {
  return /型は「(.+?)」に固定/.exec(user)?.[1] ?? null;
}

function mockFirstSection(user: string, heading: string): string {
  const re = new RegExp(`# ${heading}\\n([\\s\\S]*?)(?:\\n\\n# |$)`);
  return (re.exec(user)?.[1] ?? "").trim();
}

/**
 * 指示だけを取る。`buildRevisePrompt` は `# 指示` の後ろに見出しなしの一文
 * （「この1案だけを直して…」）を足すので、空行までで切る。
 */
function mockInstructionOf(user: string): string {
  return mockFirstSection(user, "指示").split("\n\n")[0]!.trim();
}

/** 前回のモック注記を消す。何度直しても本文が積み上がらないようにする。 */
function mockStripNote(body: string): string {
  return body
    .split("\n")
    .filter((line) => !/^（.*を反映しました）$/.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 参考情報の見出し（`## タイトル`）を1つ拾って basis に使う。
 *
 * 名前は `mock` 始まりで揃えてある。`scripts/check-bundle.sh` はこの識別子が本番バンドルに
 * 0件であることでモックの混入を見るので、本番コード側と名前がぶつかると検査が壊れる
 * （実際、`jobs/plan.ts` の `sourceTitle` とぶつかって誤検知した）。
 */
function mockSourceTitle(user: string): string {
  const block = mockFirstSection(user, "参考情報（ここに無いことを事実として書かない）");
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
  // The composition protocol is mocked explicitly; never call real providers in tests.
  if (input.user.startsWith("{")) {
    const request = JSON.parse(input.user);
    if (request.task === "buzz-diagnosis") {
      const body = String(request.body ?? "");
      const hasMedia = request.hasMedia === true;
      const firstLine = body.split(/\r?\n/).find((line: string) => line.trim())?.trim() ?? "";
      const hookScore = firstLine.length >= 12 && firstLine.length <= 55 ? 38 : 29;
      const bodyScore = body.length >= 120 ? 30 : hasMedia ? 27 : 22;
      const ctaScore = /ください|どうですか|試して|見て|教えて|保存/.test(body) ? 12 : 9;
      return JSON.stringify({
        score: hookScore + bodyScore + ctaScore,
        priority: hookScore < 35 ? "hook" : bodyScore < 27 ? "body" : "cta",
        sections: [
          { key: "hook", label: "1行目", score: hookScore, maxScore: 50, feedback: hookScore < 35 ? "読む人の場面が浮かぶ具体語を入れてみましょう。" : "内容と読む理由が最初に伝わります。" },
          { key: "body", label: "本文", score: bodyScore, maxScore: 35, feedback: body.length < 120 && hasMedia ? "本文は短めですが、画像で補足されているなら問題ありません。" : body.length < 120 ? "体験か具体例を一つ足すと伝わりやすくなります。" : "体験と具体策の流れが読みやすいです。" },
          { key: "cta", label: "締め", score: ctaScore, maxScore: 15, feedback: ctaScore < 10 ? "読んだ人が次にできる一歩を具体的にしましょう。" : "次の行動が分かる締めです。" },
        ],
        hookSuggestions: [
          "毎日投稿しているのに、反応につながらない人へ。",
          "同じ作業を毎回ゼロから始めていませんか。",
          "続けても結果が変わらなかった理由があります。",
        ],
        mediaAnalyzed: false,
      });
    }
    if(request.task === "abstract-reference") return JSON.stringify({structure:request.posts.map((p:string,i:number)=>`${i+1}投稿目: 導入と${(p.match(/^\s*・/gm)??[]).length}項目。`).join("\n"),tone:"短い口語"});
    if (request.task === "post-edit") return JSON.stringify({preparation:request.preparation ?? "",candidates:request.drafts,notes:[]});
    if (request.task === "post-compose") {
      const original = request.currentDraft ? [request.currentDraft.body, ...request.currentDraft.comments] : request.reference.posts;
      const offset = [...(request.sources[0]?.title ?? "")].reduce((sum: number, ch: string) => (sum + ch.codePointAt(0)!) % MOCK_BODIES.length, 0);
      return JSON.stringify({ candidates: Array.from({length: request.n}, (_, i) => {
        let posts: string[];
        if (request.operation === "revise") posts = original.map((p: string, index: number) => index ? p : p + "（" + request.request + "）");
        else if (original.length && request.mode !== "information") posts = original.map((p: string, index: number) => index ? p : ["", "うん、", "そう、", "ほんと、", "やっぱり、"][i] + p);
        else posts = Array.from({length:request.resolvedRules.postCount ?? 1},(_,j)=>j ? "続きの説明。" : MOCK_BODIES[(i + offset) % MOCK_BODIES.length]!);
        return {posts};
      }), notes: [] });
    }
  }
  // revise は1案だけ返す（直前の案の本文の先頭に指示を織り込んだ体で差し替える）
  const isRevise = input.user.includes("# 直前の案");
  if (isRevise) {
    const instruction = mockInstructionOf(input.user);
    let prev: { hook?: string; body?: string; comments?: string[] } = {};
    const block = /# 直前の案\n([\s\S]*?)(?:\n\n# |$)/.exec(input.user)?.[1] ?? "";
    try {
      prev = JSON.parse(block) as typeof prev;
    } catch {
      prev = {};
    }
    const lines = mockStripNote(prev.body ?? MOCK_BODIES[0]!).split("\n");
    const head = lines[0] ?? "";
    const rest = lines.slice(1).join("\n").trim();
    return JSON.stringify({
      candidates: [
        {
          hook: prev.hook ?? "呼びかけ型",
          body: `${head}\n\n（${instruction || "指示なし"}を反映しました）\n\n${rest}`.trim(),
          comments: prev.comments ?? MOCK_COMMENTS[0]!,
          basis: "直前の案を指示どおりに直しました",
        },
      ],
    });
  }

  const n = mockRequestedCount(input.user);
  const basisFrom = mockSourceTitle(input.user);
  const fixed = mockFixedHookOf(input.user);
  // オートパイロットは同じ枠に同じ本文が並ぶと重複判定（SPEC §8.3）で全部落ちるので、
  // ネタ源の名前で本文をずらす。乱数は使わない（同じ入力からは同じ本文）。
  const offset = fixed
    ? [...basisFrom].reduce((acc, ch) => (acc + ch.codePointAt(0)!) % MOCK_BODIES.length, 0)
    : 0;
  const candidates = Array.from({ length: n }, (_, i) => ({
    hook: fixed ?? MOCK_HOOKS[i % MOCK_HOOKS.length]!,
    body: MOCK_BODIES[(i + offset) % MOCK_BODIES.length]!,
    comments: MOCK_COMMENTS[(i + offset) % MOCK_COMMENTS.length]!,
    basis: `「${basisFrom}」の内容を使いました`,
  }));
  return JSON.stringify({ candidates });
}
