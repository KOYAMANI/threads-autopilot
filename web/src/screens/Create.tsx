/**
 * 作る（SPEC §12.3 Create / design-v0.2 §3-4）。
 *
 *   箱1  自分の投稿から（型として使う / リライト元にする）   … components/PostPicker
 *   箱2  参考情報（テキスト / YouTube / ファイル / 記事URL） … components/SourceAdder
 *   指示 → [生成する（3案）] → 結果タブ 案A/B/C
 *   1投稿目とコメントを編集 →「指示で直す」（会話履歴を保持）
 *   [下書き保存] [キューに入れる ▸ 今すぐ / 日時指定 / おすすめ枠]
 *
 * キー未設定なら生成ボタンの代わりに設定への誘導を出す（design-v0.2 §3-4）。
 * 端末保存モードのときは `localStorage.aiKey` を `clientKey` として送る（SPEC §12.3）。
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { AiCandidate, AiHistoryTurn, AiPickMode } from "@tap/shared";
import { useCreateQueue } from "../api/queue";
import { ApiError } from "../api/client";
import { readClientKey, useAiSettings, useGenerate, useRevise, withClientKey } from "../api/ai";
import PostFields, {
  draftIssue,
  emptyDraft,
  trimComments,
  type PostDraft,
} from "../components/PostFields";
import PostPicker from "../components/PostPicker";
import ScheduleSheet, { type SchedulePick } from "../components/ScheduleSheet";
import SourceAdder from "../components/SourceAdder";
import { useShell } from "../components/Shell";
import { useToast } from "../components/Toast";
import type { CreatePreset } from "./Home";

/** 生成する案の数（SPEC §7.6）。 */
const N_CANDIDATES = 3;

function draftOf(c: AiCandidate): PostDraft {
  const comments = [...c.comments, "", "", ""].slice(0, 3);
  return { body: c.body, comments };
}

export default function Create() {
  const { account } = useShell();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const preset = (location.state as { preset?: CreatePreset } | null)?.preset ?? null;

  const settings = useAiSettings();
  const generate = useGenerate();
  const revise = useRevise();
  const create = useCreateQueue(account?.id ?? null);

  const [picks, setPicks] = useState<string[]>([]);
  const [pickMode, setPickMode] = useState<AiPickMode>("template");
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [instruction, setInstruction] = useState("");

  const [candidates, setCandidates] = useState<AiCandidate[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const [draft, setDraft] = useState<PostDraft>(emptyDraft);
  const [reviseText, setReviseText] = useState("");
  /** 案ごとの会話履歴（SPEC §12.3「指示で直す（会話履歴保持）」）。 */
  const [history, setHistory] = useState<Record<string, AiHistoryTurn[]>>({});
  const [sheet, setSheet] = useState(false);

  /**
   * ホーム・キューからの下敷き（SPEC §12.3 の `location.state.preset`）。
   * `rewrite` は本文に流し込み、picker のモードと選択にもそのまま反映する。
   * `template` は文体の見本として picker に渡す（本文には入れない）。
   */
  useEffect(() => {
    if (!preset) return;
    setPickMode(preset.mode);
    if (preset.postId) setPicks([preset.postId]);
    if (preset.mode === "rewrite") {
      setDraft((d) => (d.body === "" ? { ...d, body: preset.text } : d));
    }
  }, [preset]);

  const keyReady = useMemo(() => {
    const s = settings.data;
    if (!s || !s.provider) return false;
    return s.storeOnServer ? s.hasKey : readClientKey() !== null;
  }, [settings.data]);

  if (!account) return <p className="muted">アカウントがありません。</p>;

  const tz = account.timezone ?? "Asia/Tokyo";
  const busy = generate.isPending || revise.isPending || create.isPending;

  function fail(e: unknown, fallback: string) {
    toast.show(e instanceof ApiError ? e.message : fallback, "bad");
  }

  function pickCandidate(index: number) {
    const c = candidates[index];
    if (!c) return;
    setActive(index);
    setDraft(draftOf(c));
    setReviseText("");
  }

  function runGenerate() {
    generate.mutate(
      withClientKey(settings.data, {
        accountId: account!.id,
        picks,
        pickMode,
        sourceIds,
        instruction,
        n: N_CANDIDATES,
      }),
      {
        onSuccess: (r) => {
          setCandidates(r.candidates);
          setNotes(r.notes ?? []);
          setHistory({});
          setActive(0);
          if (r.candidates[0]) setDraft(draftOf(r.candidates[0]));
          toast.show(`${r.candidates.length}案できました`, "ok");
        },
        onError: (e) => fail(e, "生成できませんでした"),
      },
    );
  }

  function runRevise() {
    const current = candidates[active];
    if (!current || reviseText.trim() === "") return;
    // 画面で直した本文をそのまま渡す（AI に「いまの姿」を見せる）
    const base: AiCandidate = {
      ...current,
      body: draft.body,
      comments: trimComments(draft.comments),
    };
    const turns = history[current.key] ?? [];

    revise.mutate(
      withClientKey(settings.data, {
        accountId: account!.id,
        candidate: base,
        instruction: reviseText,
        history: turns,
      }),
      {
        onSuccess: (r) => {
          const next = r.candidate;
          setCandidates((list) => list.map((c, i) => (i === active ? next : c)));
          setDraft(draftOf(next));
          setHistory((h) => ({
            ...h,
            [current.key]: [
              ...turns,
              { role: "user", text: reviseText },
              { role: "assistant", text: next.body },
            ],
          }));
          setReviseText("");
          toast.show("直しました", "ok");
        },
        onError: (e) => fail(e, "直せませんでした"),
      },
    );
  }

  function guard(): boolean {
    const issue = draftIssue(draft);
    if (issue) {
      toast.show(issue, "bad");
      return false;
    }
    return true;
  }

  /** 生成に使った材料を、あとで辿れるようにキューへ持たせる（SPEC §7.4）。 */
  function provenance() {
    return {
      originPostId: pickMode === "rewrite" ? (picks[0] ?? null) : (picks[0] ?? null),
      sourceIds,
    };
  }

  function saveDraft() {
    if (!guard()) return;
    create.mutate(
      {
        status: "draft",
        body: draft.body,
        comments: trimComments(draft.comments),
        ...provenance(),
      },
      {
        onSuccess: () => {
          toast.show("下書きに保存しました", "ok");
          navigate("/app/queue");
        },
        onError: (e) => fail(e, "保存できませんでした"),
      },
    );
  }

  function enqueue(pick: SchedulePick) {
    if (!guard()) return;
    const common = {
      body: draft.body,
      comments: trimComments(draft.comments),
      ...provenance(),
    };
    create.mutate(
      pick.kind === "now"
        ? { status: "now", ...common }
        : { status: "scheduled", scheduledAt: pick.at ?? undefined, ...common },
      {
        onSuccess: () => {
          setSheet(false);
          toast.show(pick.kind === "now" ? "次の実行で出します" : "予約しました", "ok");
          navigate("/app/queue");
        },
        onError: (e) => fail(e, "キューに入れられませんでした"),
      },
    );
  }

  const turns = candidates[active] ? (history[candidates[active]!.key] ?? []) : [];

  return (
    <>
      <h1>作る</h1>
      <p className="muted" style={{ marginTop: "0.125rem" }}>
        過去投稿と参考情報から3案つくって、直してから出します
      </p>

      <PostPicker
        accountId={account.id}
        tz={tz}
        picks={picks}
        pickMode={pickMode}
        onChange={(next) => {
          setPicks(next.picks);
          setPickMode(next.pickMode);
        }}
      />

      <SourceAdder selected={sourceIds} onChange={setSourceIds} />

      <section className="card section">
        <h2>指示</h2>
        <label className="field" htmlFor="create-instruction">
          <span>どう書くか</span>
          <textarea
            id="create-instruction"
            className="input"
            rows={3}
            value={instruction}
            placeholder="例: 箱1の型で、箱2の内容を初心者向けに。コメントにLINE誘導"
            onChange={(e) => setInstruction(e.target.value)}
          />
        </label>

        {settings.isPending ? (
          <p className="muted section">読み込んでいます…</p>
        ) : keyReady ? (
          <button
            type="button"
            className="btn section"
            disabled={busy}
            onClick={runGenerate}
          >
            {generate.isPending ? "書いています…" : `生成する（${N_CANDIDATES}案）`}
          </button>
        ) : (
          <div className="msg msg-warn section" role="status">
            <p>AIキーがまだ設定されていません。</p>
            <button
              type="button"
              className="btn section"
              onClick={() => navigate("/app/settings")}
            >
              設定でキーを登録する
            </button>
          </div>
        )}

        {notes.map((n) => (
          <p className="msg msg-warn section" key={n} role="status">
            {n}
          </p>
        ))}
      </section>

      {candidates.length > 0 && (
        <section className="card section">
          <div className="section-head">
            <h2>結果</h2>
            <span className="muted">{candidates[active]?.hook}</span>
          </div>

          <div className="chips" style={{ marginTop: "var(--sp)" }}>
            {candidates.map((c, i) => (
              <button
                key={c.key}
                type="button"
                className="chip"
                aria-pressed={i === active}
                onClick={() => pickCandidate(i)}
              >
                案{c.key}
              </button>
            ))}
          </div>

          {candidates[active]?.basis && (
            <p className="muted section">根拠: {candidates[active]!.basis}</p>
          )}

          <PostFields draft={draft} onChange={setDraft} idPrefix="create" />

          <label className="field" htmlFor="create-revise">
            <span>指示で直す{turns.length > 0 ? `（${turns.length / 2}回目）` : ""}</span>
            <textarea
              id="create-revise"
              className="input"
              rows={2}
              value={reviseText}
              placeholder="例: 1行目をもっと短く。数字を入れる"
              onChange={(e) => setReviseText(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn btn-sub section"
            disabled={busy || reviseText.trim() === ""}
            onClick={runRevise}
          >
            {revise.isPending ? "直しています…" : "この指示で直す"}
          </button>
        </section>
      )}

      {candidates.length === 0 && (
        <section className="card section">
          <h2>自分で書く</h2>
          <p className="muted" style={{ marginTop: "0.25rem" }}>
            生成せずに、そのまま書いて出すこともできます。
          </p>
          <PostFields draft={draft} onChange={setDraft} idPrefix="create" />
        </section>
      )}

      <div className="section" style={{ display: "grid", gap: "calc(var(--sp) * 1.5)" }}>
        <button type="button" className="btn" disabled={busy} onClick={() => setSheet(true)}>
          キューに入れる
        </button>
        <button type="button" className="btn btn-sub" disabled={busy} onClick={saveDraft}>
          {create.isPending ? "保存しています…" : "下書きに保存"}
        </button>
      </div>

      <ScheduleSheet
        open={sheet}
        onClose={() => setSheet(false)}
        onPick={enqueue}
        accountId={account.id}
        tz={tz}
        confirmLabel="この日時で予約する"
        busy={create.isPending}
      />
    </>
  );
}
