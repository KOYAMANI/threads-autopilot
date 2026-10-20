/**
 * バズ診断（B 系統の作る画面から。DECISIONS 2026-10-20）。作る画面の「仕上げる」に差し込む。
 *
 *   目的を選ぶ → 診断する（AI を1回使う）→ 1行目・本文・締めの点数 → 1行目の修正案から選ぶ
 *
 * 同じ本文と目的の結果は覚えておき、開き直しでは AI を使わない。画像は送らない。
 */
import { useState } from "react";
import type { BuzzDiagnosisResponse, PostPurpose } from "@tap/shared";
import { replaceFirstContentLine } from "@tap/shared";
import { useBuzzDiagnosis } from "../api/ai";
import { ApiError } from "../api/client";
import Sheet from "./Sheet";
import { useToast } from "./Toast";

const PURPOSES: Array<{ id: PostPurpose; label: string; guidance: string }> = [
  { id: "awareness", label: "知ってもらう", guidance: "初見でも伝わる1行目と、覚えてほしい要点を見ます。" },
  { id: "trust", label: "信頼を育てる", guidance: "経験・理由・具体例で、納得できる本文かを見ます。" },
  { id: "action", label: "行動につなぐ", guidance: "読んだあとにしてほしいことが1つに絞れているかを見ます。" },
];

type Stage = "closed" | "confirm" | "running" | "result" | "rewrite";

export function BuzzDiagnosis({ accountId, body, disabled, onNeedKey, onBody, onEditBody }: {
  accountId: string;
  body: string;
  disabled?: boolean;
  /** AI キーが無いとき、押したら代わりにこれを呼ぶ */
  onNeedKey?: () => void;
  /** 1行目の修正案を選んだときの、置き換えたあとの本文 */
  onBody: (body: string) => void;
  /** 本文や締めを直すとき、本文の欄に移る */
  onEditBody: () => void;
}) {
  const toast = useToast();
  const diagnose = useBuzzDiagnosis();
  const [stage, setStage] = useState<Stage>("closed");
  const [purpose, setPurpose] = useState<PostPurpose>("trust");
  const [result, setResult] = useState<{ signature: string; data: BuzzDiagnosisResponse } | null>(null);
  const signature = JSON.stringify([body, purpose]);
  const data = result?.data ?? null;

  function open() {
    if (onNeedKey) {
      onNeedKey();
      return;
    }
    setStage(result?.signature === signature ? "result" : "confirm");
  }

  async function run() {
    if (diagnose.isPending) return;
    setStage("running");
    try {
      const res = await diagnose.mutateAsync({ accountId, body, purpose, hasMedia: false, mediaCount: 0 });
      setResult({ signature, data: res });
      setStage("result");
    } catch (e) {
      setStage("confirm");
      toast.show(e instanceof ApiError ? e.message : "診断できませんでした", "bad");
    }
  }

  function pickHook(text: string) {
    onBody(replaceFirstContentLine(body, text));
    setStage("closed");
    toast.show("1行目を置き換えました", "ok");
  }

  function fix() {
    if (data?.priority === "hook") {
      setStage("rewrite");
      return;
    }
    setStage("closed");
    onEditBody();
  }

  const title = stage === "rewrite" ? "1行目の修正案" : stage === "result" && data ? `バズ診断　${data.score} / 100` : stage === "running" ? "バズ診断中…" : "バズ診断";
  const priority = data?.sections.find((s) => s.key === data.priority);

  return (
    <>
      <p className="buzz-link">
        <button type="button" className="btn-link" disabled={disabled || !body.trim()} onClick={open}>
          バズ診断
        </button>
        <span className="muted">1行目・本文・締めを100点で見ます</span>
      </p>

      <Sheet open={stage !== "closed"} onClose={() => !diagnose.isPending && setStage("closed")} title={title}>
        {stage === "confirm" && (
          <div className="buzz-confirm">
            <div className="choices" role="radiogroup" aria-label="投稿の目的">
              {PURPOSES.map((p) => (
                <button key={p.id} type="button" className="choice" role="radio" aria-checked={purpose === p.id} onClick={() => setPurpose(p.id)}>
                  <span className="choice-title">{p.label}</span>
                  <span className="choice-note">{p.guidance}</span>
                </button>
              ))}
            </div>
            <p className="muted">本文と目的を AI に送ります（1回分）。画像は送りません。</p>
            <button className="btn" type="button" onClick={() => void run()}>診断する</button>
          </div>
        )}
        {stage === "running" && (
          <div className="buzz-running" role="status">
            <span className="generation-spinner" />
            <strong>1行目・本文・締めを確認しています</strong>
          </div>
        )}
        {stage === "result" && data && (
          <div className="buzz-result">
            {priority && <p className="buzz-priority">まず直すなら「{priority.label}」</p>}
            <div className="buzz-scores">
              {data.sections.map((s) => (
                <article key={s.key} className={s.key === data.priority ? "is-priority" : ""}>
                  <div><strong>{s.label}</strong><span>{s.score} / {s.maxScore}</span></div>
                  <p>{s.feedback}</p>
                </article>
              ))}
            </div>
            <button className="btn" type="button" onClick={fix}>
              {data.priority === "hook" ? "1行目の修正案を見る" : data.priority === "body" ? "本文を直す" : "締めを直す"}
            </button>
            <button className="btn-link" type="button" onClick={() => setStage("confirm")}>目的を変えて診断し直す</button>
          </div>
        )}
        {stage === "rewrite" && data && (
          <div className="buzz-rewrite">
            <p className="muted">使いたい1行目を選ぶと、いまの1行目と置き換わります。</p>
            {data.hookSuggestions.map((s, i) => (
              <button type="button" key={s} onClick={() => pickHook(s)}>
                <span>{String.fromCharCode(65 + i)}案</span>
                <strong>{s}</strong>
              </button>
            ))}
            <button type="button" className="btn btn-sub" onClick={() => setStage("result")}>診断結果へ戻る</button>
          </div>
        )}
      </Sheet>
    </>
  );
}
