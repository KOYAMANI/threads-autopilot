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

function mockNoteOutline(volumeChars: unknown): unknown {
  const total = typeof volumeChars === "number" && volumeChars > 0 ? volumeChars : 25_000;
  const mid = Math.max(600, Math.round((total - 3_000) / 3));
  return {
    status: "ok",
    titles: ["「高いフード＝安心」は間違い。失敗しないごはん選びの教科書", "愛犬の寿命はごはんで変わる。値段に振り回されない基準の作り方", "子犬からシニアまで。ごはん選びで最初に決める3つのこと"],
    chapters: [
      { heading: "はじめに：毎日のごはんが、愛犬の一生を左右する", targetChars: 2_400, sections: [] },
      { heading: "第1章 なぜ「ごはん」にこだわるべきなのか", targetChars: mid, sections: [{ title: "1-1 毎日食べるものが、病気のリスクを左右する" }, { title: "1-2 激安フードが安い理由", caution: "根拠を示しにくい断定は表示の見方として書きます" }] },
      { heading: "第2章 自分だけの基準をつくる", targetChars: mid, sections: [{ title: "2-1 最低ラインの決め方" }, { title: "2-2 原材料表示の見方" }] },
      { heading: "第3章 ライフステージ別の選び方", targetChars: mid, sections: [{ title: "3-1 子犬期" }, { title: "3-2 シニア期" }] },
      { heading: "まとめ：今日からできる3ステップ", targetChars: 600, sections: [] },
    ],
    paywallAfter: 1,
    refProfile: null,
    notes: [],
  };
}

function mockNoteChapter(chapter: { heading?: string; targetChars?: number; sections?: Array<{ title: string }> }, feedback: string | null): unknown {
  const target = typeof chapter?.targetChars === "number" ? chapter.targetChars : 1_000;
  const sections = Array.isArray(chapter?.sections) && chapter.sections.length ? chapter.sections : [{ title: "" }];
  const per = Math.max(120, Math.round(target / sections.length));
  const filler = "毎日のごはんは、人の食事と同じで積み重ねです。1回で体が変わることはありませんが、続いたときの差は小さくありません。あなたの犬に合うかどうかは、原材料と量を自分の目で確かめるところから始まります。";
  const paragraphs = (n: number) => { let out = ""; while (out.length < n) out += (out ? "\n\n" : "") + filler; return out; };
  const body = sections
    .map((s, i) => `${s.title ? `## ${s.title}\n\n` : ""}${paragraphs(per)}${i === 0 ? "\n\n【商品名】を入れると具体的になります。" : ""}`)
    .join("\n\n");
  return { body: feedback ? `（${feedback}）\n\n${body}` : body, summary: `${chapter?.heading ?? "章"}の要約です。`, placeholders: ["商品名"] };
}

export type MockAiInput = { system: string; user: string; provider: string };

/** 生成の生応答（JSON 文字列）を返す。`lib/ai.ts` の `generateRaw` から呼ばれる。 */
export default function aiMockCall(input: MockAiInput): string {
  // The composition protocol is mocked explicitly; never call real providers in tests.
  if (input.user.startsWith("{")) {
    const request = JSON.parse(input.user);
    // 画面の「AI から確認」シートを手元で試すための合図（本番バンドルには入らない）
    if (request.task === "composition-plan" && typeof request.instruction === "string" && request.instruction.includes("質問テスト") && !request.instruction.includes("補足: 答え") && !request.assume) return JSON.stringify({ status: "needs_input", question: "誰に向けた投稿ですか？ 伝えたい要点を1つ教えてください。" });
    if (request.task === "composition-plan") return JSON.stringify({ status: "ok", summary: "投稿を型、参考情報を内容として使用", structure: "導入と続き", style: "短い断定", partCount: 2, anchors: [], variants: Array.from({ length: request.n }, (_, i) => ({ label: `切り口${i + 1}`, approach: `焦点${i + 1}`, blueprint: { posts: ["{{body}}", "{{comment}}"], slots: [{ id: "body", task: "本文", maxChars: 450 }, { id: "comment", task: "続き", maxChars: 450 }] } })) });
    if (request.task === "composition-slots") return JSON.stringify({ slots: { body: MOCK_BODIES[request.index % MOCK_BODIES.length], comment: MOCK_COMMENTS[request.index % MOCK_COMMENTS.length]![0] } });
    // note（長文）。章は targetChars に近い長さで、節の見出しを sections の数だけ付ける
    if (request.task === "note-outline") {
      const asksQuestion = typeof request.memo === "string" && request.memo.includes("質問テスト") && !request.assume;
      const answered = Array.isArray(request.qa) ? request.qa.filter((q: { answer: unknown }) => typeof q.answer === "string" && q.answer !== "").length : 0;
      if (asksQuestion && answered < 3) return JSON.stringify({ status: "needs_input", question: `確認${answered + 1}: 読者は誰ですか？` });
      return JSON.stringify(mockNoteOutline(request.volumeChars));
    }
    if (request.task === "note-write") return JSON.stringify(mockNoteChapter(request.chapter, typeof request.feedback === "string" ? request.feedback : null));
    if (request.task === "note-digest") return JSON.stringify({ digest: `- 「${String(request.title ?? "")}」の要点（モック）\n- 原材料の先頭を見る` });
    if (request.task === "note-revise") return JSON.stringify({ body: `${request.body}\n\n（${request.instruction}を反映しました）`, summary: "直した章の要約" });
    if (request.task === "composition-write") {
      const i = request.index % MOCK_BODIES.length;
      return JSON.stringify({ candidates: [{ hook: MOCK_HOOKS[i], body: MOCK_BODIES[i], comments: [MOCK_COMMENTS[i]![0]], basis: `「${request.sources[0]?.title ?? "指示"}」の内容を使いました` }] });
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
