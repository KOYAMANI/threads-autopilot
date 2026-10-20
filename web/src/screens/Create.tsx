import AutoTextarea from "../components/AutoTextarea";
/**
 * 作る（SPEC §12.3 Create / design-v0.2 §3-4）。
 *
 *   箱1  自分の投稿から（型として使う / リライト元にする）   … components/PostPicker
 *   箱2  参考情報（テキスト / YouTube / ファイル / 記事URL） … components/SourceAdder
 *   指示 → [生成する（3案）] → 結果タブ 案A/B/C
 *   1投稿目とコメントを編集 →「指示で直す」（会話履歴を保持）
 *   [下書き保存] [予約・キューに追加] [今すぐ投稿 ▸ 確認]
 *
 * キー未設定なら生成ボタンの代わりに設定への誘導を出す（design-v0.2 §3-4）。
 * AI credentials are resolved server-side; never load keys from browser storage.
 */
import { useEffect, useMemo, useState, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { AiCandidate, AiHistoryTurn, AiPickMode, AiGenerationContext, BuzzDiagnosisResponse, PostPurpose } from "@tap/shared";
import { AI_GENERATION_TIMEOUT_MS, replaceFirstContentLine } from "@tap/shared";
import { useCreateQueue } from "../api/queue";
import { loadPostTree } from "../api/post-tree";
import { ApiError } from "../api/client";
import { useAiSettings, useAiCapabilities, useBuzzDiagnosis, useGenerate, useRevise, withClientKey } from "../api/ai";
import PostFields, {
  draftIssue,
  emptyDraft,
  trimComments,
  type PostDraft,
} from "../components/PostFields";
import AiErrorNotice from "../components/AiErrorNotice";
import GenerationChat from "../components/GenerationChat";
import PostPicker from "../components/PostPicker";
import ScheduleSheet, { type SchedulePick } from "../components/ScheduleSheet";
import PublishNowSheet from "../components/PublishNowSheet";
import Sheet from "../components/Sheet";
import SourceAdder from "../components/SourceAdder";
import { useShell } from "../components/Shell";
import { useToast } from "../components/Toast";
import type { CreatePreset } from "./Home";
import { useCreateSessionState } from "../lib/create-session";
import { clearGenerationTask, cancelGenerationTask, useGenerationTask } from "../lib/generation-task";
import { ImageIcon } from "../components/Icons";
import { uploadPostMedia } from "../api/media";

type DraftMedia = { id: string; name: string; file: File; previewUrl: string; uploadedUrl?: string };

const MAX_MEDIA = 5;
const MAX_MEDIA_BYTES = 8_000_000;

/** 生成する案の数（SPEC §7.6）。 */
const N_CANDIDATES = 3;

const PURPOSES: Array<{ id: PostPurpose; label: string; guidance: string }> = [
  { id: "awareness", label: "知ってもらう", guidance: "初見でも伝わる1行目と、覚えてほしい要点を優先します。" },
  { id: "trust", label: "信頼を育てる", guidance: "経験・理由・具体例を中心に、納得できる本文を優先します。" },
  { id: "action", label: "行動につなぐ", guidance: "読後にしてほしい行動を一つに絞り、自然な締めを作ります。" },
];

function draftOf(c: AiCandidate): PostDraft {
  const comments = [...c.comments, "", "", ""].slice(0, 3);
  return { body: c.body, comments };
}

export default function Create() {
  const { account } = useShell();
  const accountId = account?.id ?? null;
  const task = useGenerationTask();
  const toast = useToast();
  const navigate = useNavigate();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const location = useLocation();
  const [appliedPresetKey, setAppliedPresetKey] = useCreateSessionState<string | null>(accountId, "appliedPresetKey", null);
  const preset = (location.state as { preset?: CreatePreset } | null)?.preset ?? null;

  const settings = useAiSettings();
  const capabilities = useAiCapabilities(settings.data?.provider, settings.data?.model ?? undefined);
  const [manualEditing, setManualEditing] = useCreateSessionState(accountId, "manualEditing", false);
  const [thinking, setThinking] = useState("");
  const thinkingStorageKey = `tap:thinking:${capabilities.data?.provider}:${capabilities.data?.model}`;
  useEffect(() => {
    const caps = capabilities.data;
    if (!caps) return;
    let saved: string | null = null;
    try { saved = localStorage.getItem(thinkingStorageKey); } catch { /* Storage is optional. */ }
    setThinking(caps.options.some(option => option.id === saved) ? saved! : caps.defaultId);
  }, [capabilities.data, thinkingStorageKey]);
  const generate = useGenerate();
  const revise = useRevise();
  const diagnose = useBuzzDiagnosis();
  const create = useCreateQueue(account?.id ?? null);

  const [picks, setPicks] = useCreateSessionState<string[]>(accountId, "picks", []);
  const [pickMode, setPickMode] = useCreateSessionState<AiPickMode>(accountId, "pickMode", "template");
  const [referenceOrigin, setReferenceOrigin] = useCreateSessionState<"own" | "paste">(accountId, "referenceOrigin", "own");
  const [ownPostCount, setOwnPostCount] = useState<number | null>(null);
  const [referenceText, setReferenceText] = useCreateSessionState(accountId, "referenceText", "");
  const [analysis, setAnalysis] = useCreateSessionState(accountId, "analysis", "");
  const [generationContext, setGenerationContext] = useCreateSessionState<AiGenerationContext | undefined>(accountId, "generationContext", undefined);
  const [sourceIds, setSourceIds] = useCreateSessionState<string[]>(accountId, "sourceIds", []);
  const [instruction, setInstruction] = useCreateSessionState(accountId, "instruction", "");
  const [generationMode, setGenerationMode] = useCreateSessionState<"delegate" | "ask">(accountId, "generationMode", "delegate");
  const [fidelity, setFidelity] = useCreateSessionState(accountId, "fidelity", 70);

  const [candidates, setCandidates] = useCreateSessionState<AiCandidate[]>(accountId, "candidates", []);
  const [notes, setNotes] = useCreateSessionState<string[]>(accountId, "notes", []);
  const [conversation, setConversation] = useCreateSessionState<AiHistoryTurn[]>(accountId, "conversation", []);
  const [checkingReference, setCheckingReference] = useState(false);
  const referenceCheck = useRef<AbortController | null>(null);
  const [operation, setOperation] = useState<{kind: "generate" | "revise"; startedAt: number} | null>(null);
  const [submitted, setSubmitted] = useCreateSessionState<Record<string, { id: string; status: string }>>(accountId, "submitted", {});
  const submissionLock = useRef(false);
  const [submitting, setSubmitting] = useCreateSessionState(accountId, "submitting", false);
  const [queueAttempts, setQueueAttempts] = useCreateSessionState<Record<string, { signature: string; key: string }>>(accountId, "queueAttempts", {});
  const displayOperation = operation ?? (task.status === "running" && task.accountId === accountId ? { kind: "generate" as const, startedAt: task.startedAt } : null);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!displayOperation) return;
    const update = () => setElapsed(Math.floor((Date.now() - displayOperation.startedAt) / 1000));
    update();
    const interval = window.setInterval(update, 1000);
    return () => window.clearInterval(interval);
  }, [displayOperation?.kind, displayOperation?.startedAt]);
  // 画面移動では止めない。明示的な「やめる」か入力条件の変更だけが中止する。
  // 生成はサーバージョブなので、Create のアンマウント後も Home から追跡できる。
  const [failure, setFailure] = useCreateSessionState<unknown>(accountId, "failure", null);
  const [question, setQuestion] = useCreateSessionState(accountId, "question", "");
  const generationSequence = useRef(0);
  const inputsSignature = JSON.stringify([accountId, pickMode, referenceOrigin, referenceText, instruction, generationMode, fidelity, picks, sourceIds]);
  const previousInputs = useRef(inputsSignature);
  useEffect(() => {
    if (previousInputs.current === inputsSignature) return;
    previousInputs.current = inputsSignature;
    generationSequence.current++;
    referenceCheck.current?.abort();
    setOperation(null);
    setCheckingReference(false);
    setConversation([]); setQuestion(""); setNotes([]);
  }, [account?.id, pickMode, referenceOrigin, referenceText, instruction, generationMode, fidelity, picks.join("|"), sourceIds.join("|")]);
  const [active, setActive] = useCreateSessionState(accountId, "active", 0);
  const [draft, setDraft] = useCreateSessionState<PostDraft>(accountId, "draft", emptyDraft);
  const [reviseText, setReviseText] = useCreateSessionState(accountId, "reviseText", "");
  /** 案ごとの会話履歴（SPEC §12.3「指示で直す（会話履歴保持）」）。 */
  const [history, setHistory] = useCreateSessionState<Record<string, AiHistoryTurn[]>>(accountId, "history", {});
  const [sheet, setSheet] = useState(false);
  const [showPublishNow, setShowPublishNow] = useState(false);
  const [detailSheet, setDetailSheet] = useState(false);
  const [moreActions, setMoreActions] = useState(false);
  const [purpose, setPurpose] = useCreateSessionState<PostPurpose>(accountId, "purpose", "trust");
  const [media, setMedia] = useCreateSessionState<DraftMedia[]>(accountId, "media", []);
  const [mediaUploading, setMediaUploading] = useState(false);
  const mediaRef = useRef<DraftMedia[]>([]);
  const mediaInput = useRef<HTMLInputElement | null>(null);
  const [buzzStage, setBuzzStage] = useState<"closed" | "confirm" | "running" | "result" | "rewrite">("closed");
  const [buzzResult, setBuzzResult] = useCreateSessionState<BuzzDiagnosisResponse | null>(accountId, "buzzResult", null);
  const [buzzSignature, setBuzzSignature] = useCreateSessionState<string | null>(accountId, "buzzSignature", null);

  useEffect(() => { mediaRef.current = media; }, [media]);
  // Session memory owns object URLs until account change or logout.

  useEffect(() => { setOwnPostCount(null); }, [accountId]);

  useEffect(() => {
    if (ownPostCount === 0 && referenceOrigin === "own") setReferenceOrigin("paste");
  }, [ownPostCount, referenceOrigin]);

  useEffect(() => {
    if (!account || task.status === "idle" || task.accountId !== account.id || task.status === "running") return;
    const context = task.context;
    // Restore only completed/failed task input; polls must not reset an editor in use.
    setPickMode(context.pickMode ?? "template"); setPicks(context.picks ?? []);
    setReferenceText(context.referenceText ?? ""); setReferenceOrigin(context.referenceText ? "paste" : "own");
    setSourceIds(context.sourceIds ?? []); setInstruction(context.instruction ?? ""); setFidelity(context.fidelity ?? 70);
    if (context.purpose) setPurpose(context.purpose);
    if (context.thinking) setThinking(context.thinking);
    previousInputs.current = JSON.stringify([accountId, context.pickMode ?? "template", context.referenceText ? "paste" : "own", context.referenceText ?? "", context.instruction ?? "", generationMode, context.fidelity ?? 70, context.picks ?? [], context.sourceIds ?? []]);
    if (task.status === "done") {
      const result = task.result;
      setNotes(result.notes ?? []); setFailure(null);
      if (result.candidates.length) {
        setGenerationContext(context); setAnalysis(result.analysis ?? ""); setCandidates(result.candidates);
        setHistory({}); setSubmitted({}); setQueueAttempts({}); setActive(0);
        setDraft(draftOf(result.candidates[0]!)); setQuestion("");
      } else {
        const nextQuestion = result.clarification?.question ?? result.notes?.[0] ?? "どんな投稿にしたいですか？";
        setQuestion(nextQuestion);
        setConversation([...(context.conversation ?? []), { role: "assistant" as const, text: nextQuestion }].slice(-8));
      }
    } else setFailure(task.error);
    clearGenerationTask();
  }, [task, accountId]);

  /**
   * ホーム・キューからの下敷き（SPEC §12.3 の `location.state.preset`）。
   * `rewrite` は本文に流し込み、picker のモードと選択にもそのまま反映する。
   * `template` は文体の見本として picker に渡す（本文には入れない）。
   */
  useEffect(() => {
    if (!preset || appliedPresetKey === location.key) return;
    setAppliedPresetKey(location.key);
    setPickMode(preset.mode === "rewrite" ? "template" : preset.mode);
    if (preset.postId && preset.mode !== "rewrite") setPicks([preset.postId]);
    if (preset.mode === "rewrite") {
      setManualEditing(true);
      setDraft({ body: preset.text, comments: [] });
    }
  }, [preset, location.key, appliedPresetKey]);

  const keyReady = useMemo(() => {
    const s = settings.data;
    if (!s || !s.provider) return false;
    return s.storeOnServer && s.hasKey && s.dataPolicyAccepted;
  }, [settings.data]);

  if (!account) return <p className="muted">アカウントがありません。</p>;

  const tz = account.timezone ?? "Asia/Tokyo";
  const busy = displayOperation !== null || create.isPending || mediaUploading || submitting;
  const currentCandidateKey = manualEditing ? undefined : candidates[active]?.key;
  const savedCandidate = currentCandidateKey ? submitted[currentCandidateKey] : undefined;

  function beginOperation(kind: "generate" | "revise") {
    const controller = new AbortController();
    referenceCheck.current?.abort();
    referenceCheck.current = controller;
    const sequence = ++generationSequence.current;
    setOperation({ kind, startedAt: Date.now() });
    setFailure(null);
    // Background generation owns its lifecycle on the server and may survive page moves.
    // Only the synchronous revision request needs a browser-side deadline.
    const timer = kind === "revise" ? window.setTimeout(() => {
      if (referenceCheck.current !== controller) return;
      generationSequence.current++;
      controller.abort();
      setOperation(null); setCheckingReference(false);
      toast.show("生成に5分以上かかったため停止しました。入力と完成済みの候補は保持しています。", "bad");
    }, AI_GENERATION_TIMEOUT_MS) : null;
    return {
      signal: controller.signal,
      current: () => mounted.current && !controller.signal.aborted && sequence === generationSequence.current,
      finish: () => {
        if (timer !== null) window.clearTimeout(timer);
        if (referenceCheck.current === controller && mounted.current) {
          referenceCheck.current = null;
          setOperation(null); setCheckingReference(false);
        }
      },
    };
  }

  function cancelOperation() {
    generationSequence.current++;
    referenceCheck.current?.abort();
    referenceCheck.current = null;
    setOperation(null); setCheckingReference(false);
    cancelGenerationTask();
    toast.show("停止しました。入力と完成済みの候補は保持しています。", "ok");
  }

  function fail(e: unknown, fallback: string) {
    setFailure(e);
    toast.show(e instanceof ApiError ? e.message : fallback, "bad");
  }

  async function pasteReference() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) { toast.show("クリップボードに文章がありません", "bad"); return; }
      setReferenceText(text.slice(0, 20_000));
    } catch {
      toast.show("貼り付けを許可できませんでした。入力欄を長押しして貼り付けてください", "bad");
    }
  }

  function pickCandidate(index: number) {
    if (index === active) return;
    const c = candidates[index];
    if (!c) return;
    setCandidates(list => list.map((item, i) => i === active ? { ...item, body: draft.body, comments: trimComments(draft.comments) } : item));
    setActive(index);
    setDraft(draftOf(c));
    setReviseText("");
  }

  async function runGenerate(followup?: {answer:string; delegate:boolean}) {
    if (busy || !capabilities.data || !thinking) return;
    const run = beginOperation("generate");
    const nextConversation: AiHistoryTurn[] = followup ? [...conversation, {role:"user" as const, text: followup.answer || "残りは全部任せます"}].slice(-8) : [];
    setConversation(nextConversation);
    if (!followup) { setQuestion(""); setNotes([]); }
    const context: AiGenerationContext = {
      pickMode, picks: pickMode !== "information" && referenceOrigin === "own" ? picks : [],
      referenceText: pickMode !== "information" && referenceOrigin === "paste" ? referenceText : undefined,
      sourceIds, instruction, purpose, fidelity, thinking, conversation: nextConversation,
      clarificationMode: followup ? "delegate" : generationMode,
    };
    try {
      if (context.picks?.length) {
        setCheckingReference(true);
        for (const id of context.picks) await loadPostTree(account!.id, id, "reference", run.signal);
        if (!run.current()) return;
        setCheckingReference(false);
      }
      await generate.mutateAsync(withClientKey(settings.data, {
        accountId: account!.id, ...context, n: N_CANDIDATES, signal: run.signal,
      }));
      // The task subscription receives results even after navigating away.
    } catch (error) {
      if (run.current()) fail(error, "生成できませんでした");
    } finally { run.finish(); }
  }

  async function runRevise() {
    const current = candidates[active];
    if (busy || !current || !reviseText.trim() || !thinking) return;
    const run = beginOperation("revise");
    const base: AiCandidate = { ...current, body: draft.body, comments: trimComments(draft.comments) };
    const turns = history[current.key] ?? [];
    try {
      const r = await revise.mutateAsync(withClientKey(settings.data, {
        accountId: account!.id, candidate: base, instruction: reviseText,
        history: turns, context: generationContext, thinking, signal: run.signal,
      }));
      if (!run.current()) return;
      const next = r.candidate;
      setCandidates(list => list.map((c, i) => i === active ? next : c));
      setNotes(r.notes ?? []);
      setDraft(draftOf(next));
      setHistory(h => ({ ...h, [current.key]: [...turns,
        { role: "user", text: reviseText }, { role: "assistant", text: next.body },
      ] }));
      setReviseText("");
      toast.show("直しました", "ok");
    } catch (error) {
      if (run.current()) fail(error, "直せませんでした");
    } finally { run.finish(); }
  }

  function guard(): boolean {
    const issue = draftIssue(draft);
    if (issue) {
      toast.show(issue, "bad");
      return false;
    }
    return true;
  }

  function addMedia(files: FileList | null) {
    if (!files?.length) return;
    const supported = [...files].filter(file => ["image/jpeg", "image/png"].includes(file.type));
    if (supported.length !== files.length) toast.show("JPEG・PNGの画像を選んでください", "bad");
    const images = supported.filter(file => file.size <= MAX_MEDIA_BYTES);
    if (images.length !== supported.length) toast.show("画像は1枚8MBまでです", "bad");
    const room = Math.max(0, MAX_MEDIA - media.length);
    if (images.length > room) toast.show(`カルーセルは${MAX_MEDIA}枚までです`, "bad");
    const next = images.slice(0, room).map(file => ({ id: crypto.randomUUID(), name: file.name, file, previewUrl: URL.createObjectURL(file) }));
    setMedia(current => [...current, ...next]);
    if (mediaInput.current) mediaInput.current.value = "";
  }

  function removeMedia(id: string) {
    setMedia(current => {
      const found = current.find(item => item.id === id);
      if (found) URL.revokeObjectURL(found.previewUrl);
      return current.filter(item => item.id !== id);
    });
  }

  async function ensureMediaUploaded(): Promise<string[]> {
    if (mediaRef.current.length === 0) return [];
    setMediaUploading(true);
    const working = mediaRef.current.map(item => ({ ...item }));
    try {
      for (let index = 0; index < working.length; index++) {
        const item = working[index]!;
        if (item.uploadedUrl) continue;
        const uploaded = await uploadPostMedia(account!.id, item.file);
        working[index] = { ...item, uploadedUrl: uploaded.url };
        mediaRef.current = working;
        setMedia([...working]);
      }
      return working.map(item => item.uploadedUrl!).filter(Boolean);
    } finally {
      if (mounted.current) setMediaUploading(false);
    }
  }

  async function runBuzzDiagnosis() {
    if (!guard() || diagnose.isPending) return;
    setBuzzStage("running");
    try {
      const result = await diagnose.mutateAsync({ accountId: account!.id, body: draft.body, purpose, hasMedia: media.length > 0, mediaCount: media.length });
      setBuzzResult(result);
      setBuzzSignature(JSON.stringify([draft.body, purpose, media.length]));
      setBuzzStage("result");
    } catch (reason) {
      setBuzzStage("confirm");
      fail(reason, "診断できませんでした");
    }
  }

  function useHookSuggestion(text: string) {
    setDraft({ ...draft, body: replaceFirstContentLine(draft.body, text) });
    setBuzzStage("closed");
    toast.show("1行目を置き換えました", "ok");
  }

  function openPriorityFix(priority: BuzzDiagnosisResponse["priority"]) {
    if (priority === "hook") {
      setBuzzStage("rewrite");
      return;
    }
    setBuzzStage("closed");
    window.setTimeout(() => {
      const editor = document.querySelector<HTMLTextAreaElement>("#create-body");
      if (!editor) return;
      editor.focus();
      if (priority === "cta") editor.setSelectionRange(editor.value.length, editor.value.length);
    }, 0);
    toast.show(priority === "body" ? "本文のフィードバックを見ながら修正できます" : "文末に締めを追加してください", "ok");
  }

  /**
   * 生成に使った材料を、あとで辿れるようにキューへ持たせる（SPEC §7.4）。
   * `originPostId` は選んだ投稿の先頭（オートパイロットの §9.4-5「文体見本の先頭」と同じ）。
   * 型・リライトのどちらでも同じ意味で入れる。
   */
  function provenance() {
    return { originPostId: generationContext?.picks?.[0] ?? null, sourceIds: generationContext?.sourceIds ?? sourceIds };
  }

  function submissionKey(payload: unknown) {
    const candidateKey = currentCandidateKey ?? "manual";
    const signature = JSON.stringify(payload);
    const previous = queueAttempts[candidateKey];
    if (previous?.signature === signature) return previous.key;
    const key = crypto.randomUUID();
    setQueueAttempts(list => ({ ...list, [candidateKey]: { signature, key } }));
    return key;
  }

  function submittedCandidate(item: { id: string; status: string }) {
    if (!currentCandidateKey) return;
    setCandidates(list => list.map(c => c.key === currentCandidateKey ? { ...c, body: draft.body, comments: trimComments(draft.comments) } : c));
    setSubmitted(list => ({ ...list, [currentCandidateKey]: { id: item.id, status: item.status } }));
    const next = candidates.findIndex(c => c.key !== currentCandidateKey && !submitted[c.key]);
    if (next >= 0) { setActive(next); setDraft(draftOf(candidates[next]!)); }
  }

  async function saveDraft() {
    if (busy || submissionLock.current || savedCandidate || !guard()) return;
    submissionLock.current = true;
    setSubmitting(true);
    try {
      const mediaUrls = await ensureMediaUploaded();
      const payload = {
        status: "draft" as const,
        body: draft.body,
        comments: trimComments(draft.comments),
        mediaUrls,
        ...provenance(),
      };
      const item = await create.mutateAsync({ ...payload, idempotencyKey: submissionKey(payload) });
      submittedCandidate(item);
      if (!mounted.current) return;
      toast.show("下書きに保存しました", "ok");
      navigate("/app/queue");
    } catch (error) {
      if (mounted.current) fail(error, "保存できませんでした");
    } finally { submissionLock.current = false; setSubmitting(false); }
  }

  async function enqueue(pick: SchedulePick | { kind: "now" }) {
    if (!account?.canPublish) { toast.show("設定でThreads APIを連携してください", "bad"); return; }
    if (busy || submissionLock.current || savedCandidate || !guard()) return;
    submissionLock.current = true;
    setSubmitting(true);
    try {
      const mediaUrls = await ensureMediaUploaded();
      const common = {
        body: draft.body,
        comments: trimComments(draft.comments),
        mediaUrls,
        ...provenance(),
      };
      const payload = pick.kind === "now"
        ? { status: "now" as const, ...common }
        : pick.kind === "next_slot"
          ? { status: "next_slot" as const, ...common }
          : { status: "scheduled" as const, scheduledAt: pick.at ?? undefined, ...common };
      const item = await create.mutateAsync({ ...payload, idempotencyKey: submissionKey(payload) });
      submittedCandidate(item);
      if (!mounted.current) return;
      setSheet(false);
      setShowPublishNow(false);
      toast.show(pick.kind === "now" ? "投稿を受け付けました。下書き・予約で進行状況を確認できます" : "予約しました", "ok");
      navigate("/app/queue");
    } catch (error) {
      if (mounted.current) fail(error, "キューに入れられませんでした");
    } finally { submissionLock.current = false; setSubmitting(false); }
  }

  const turns = candidates[active] ? (history[candidates[active]!.key] ?? []) : [];

  const canGenerate = !busy && Boolean(capabilities.data && thinking) && (pickMode === "information" ? Boolean(instruction.trim() || sourceIds.length) : referenceOrigin === "own" ? (pickMode === "rewrite" ? picks.length === 1 : picks.length > 0) : Boolean(referenceText.trim()));

  return (
    <div className={`create-page${candidates.length ? " has-candidates" : ""}${manualEditing ? " is-manual" : ""}${failure ? " has-failure" : ""}`}>
      <div className="create-heading"><div><p className="eyebrow">POST STUDIO</p><h1>投稿を作る</h1><p className="muted">投稿先 @{account.username}</p></div><div className="create-heading-actions"><button type="button" className="btn btn-sub btn-fit" disabled={busy || Boolean(savedCandidate)} onClick={() => void saveDraft()}>{mediaUploading ? "画像を保存中…" : "下書きに保存"}</button><button type="button" className="btn btn-fit" disabled={busy || Boolean(savedCandidate) || !account.canPublish} onClick={() => { if (guard()) setSheet(true); }}>投稿・予約へ</button></div></div>

      <div className="create-mode" role="group" aria-label="投稿の作り方"><span>作り方</span><button type="button" aria-pressed={!manualEditing} onClick={() => setManualEditing(false)}>AIで3案を作る</button><button type="button" aria-pressed={manualEditing} onClick={() => setManualEditing(true)}>自分で投稿を作る</button></div>

      <div className="purpose-row" role="group" aria-label="投稿の目的"><span>投稿の目的</span>{PURPOSES.map(item => <button key={item.id} type="button" aria-pressed={purpose === item.id} onClick={() => setPurpose(item.id)}>{item.label}</button>)}</div>
      <p className="purpose-guidance" aria-live="polite"><strong>{manualEditing ? "執筆ガイドとバズ診断" : "AI生成とバズ診断"}に反映</strong>{PURPOSES.find(item => item.id === purpose)?.guidance}</p>
      {displayOperation && <div className="generation-progress card section"><div role="status"><span className="generation-spinner" aria-hidden="true" /><strong>{checkingReference ? "本人のツリーを確認中" : displayOperation.kind === "revise" ? "投稿を修正中" : "3案を作っています"}</strong></div><span className="num">{Math.floor(elapsed / 60).toString().padStart(2,"0")}:{(elapsed % 60).toString().padStart(2,"0")} ・ 最大約5分</span><div className="generation-progress-bar"><span /></div><p className="muted">{task.status === "running" && task.reconnecting ? "通信を確認しています。生成処理はサーバーで続いています。" : "別の画面に移っても、生成処理は続きます。"}</p><button type="button" className="btn btn-sub btn-fit" onClick={cancelOperation}>やめる</button></div>}

      <fieldset disabled={busy} className="create-workspace">
        <div className="create-inputs">
          {pickMode !== "information" && <section className="card reference-card">
            {checkingReference && <p role="status">本人のツリーを確認しています…</p>}
            <div className="reference-origin" role="group" aria-label="参考投稿の入力方法"><button type="button" disabled={ownPostCount === 0} aria-pressed={referenceOrigin === "own"} onClick={() => setReferenceOrigin("own")}><strong>自分の投稿</strong><small>{ownPostCount === null ? "確認中" : `${ownPostCount.toLocaleString()}件`}</small></button><button type="button" aria-pressed={referenceOrigin === "paste"} onClick={() => setReferenceOrigin("paste")}><strong>他人の投稿</strong><small>貼り付け</small></button></div>
            {ownPostCount === 0 && <p className="empty-own-message">同期できる自分の投稿がまだありません。参考にしたい他人の投稿を貼り付けて始めます。</p>}
            <div className="reference-content">{referenceOrigin === "own" ? <PostPicker accountId={account.id} tz={tz} picks={picks} pickMode={pickMode} onTotal={setOwnPostCount} onChange={next => setPicks(next.picks)} /> : <div className="field paste-reference"><label htmlFor="reference-post">1投稿目から続きまで、まとめて貼り付け</label><AutoTextarea id="reference-post" className="input reference-input auto-textarea-bounded" rows={8} maxLength={20000} value={referenceText} onChange={e => setReferenceText(e.target.value)} placeholder={"【1投稿目】\n…\n\n【続き】\n…"} /><div className="paste-reference-meta"><span className="muted num">{referenceText.length.toLocaleString()} / 20,000</span><button type="button" className="btn-quiet" onClick={() => void pasteReference()}>クリップボードから貼り付け</button></div></div>}</div>
          </section>}

          <section className="card theme-card"><h2>今回のテーマ <span>（任意）</span></h2><label className="field" htmlFor="create-instruction"><AutoTextarea id="create-instruction" className="input" rows={1} value={instruction} placeholder={pickMode === "rewrite" ? "例：評価や数字は残して、読みやすく" : "例：仕事の振り返りにAIを使う方法"} onChange={(e) => setInstruction(e.target.value)} /></label></section>
      {!manualEditing && <div className="mobile-create-actions"><button type="button" className="btn" disabled={!keyReady || !canGenerate} onClick={() => runGenerate()}>3案を作る</button><button type="button" className="btn-quiet" onClick={() => setDetailSheet(true)}>資料・再現度・追加指示⌃</button>{keyReady && !canGenerate && <small className="create-action-hint">{referenceOrigin === "paste" ? "参考投稿を貼り付けると押せます" : "参考にする投稿を選ぶと押せます"}</small>}</div>}
          <div className="desktop-source"><SourceAdder selected={sourceIds} onChange={setSourceIds} /></div>
          <div className="desktop-generate"><button type="button" className="btn" disabled={!keyReady || !canGenerate} onClick={() => runGenerate()}>{operation?.kind === "generate" ? "3案を作っています…" : "3案を作る"}</button><button type="button" className="btn-quiet" onClick={() => setDetailSheet(true)}>資料・再現度・追加指示</button></div>
          {!keyReady && !settings.isPending && <div className="msg msg-warn"><p>{settings.data?.hasKey ? "AI設定の確認が必要です。" : "AIキーがまだ設定されていません。"}</p><button type="button" className="btn btn-sub section" onClick={() => navigate("/app/settings")}>AI設定を確認する</button></div>}
          {failure !== null && <div className="generation-failure"><strong>作れませんでした</strong><p>選んだ参考投稿とテーマは残っています。</p><button className="btn" type="button" disabled={!canGenerate} onClick={() => runGenerate()}>再試行</button><button className="btn btn-sub" type="button" onClick={() => navigate("/app/settings")}>設定でモデルを変更</button><AiErrorNotice error={failure} /></div>}
          {question && <GenerationChat messages={conversation} busy={busy} onContinue={(answer, delegate) => runGenerate({answer,delegate})} />}
          {notes.map(n => <p className="msg msg-warn" key={n} role="status">{n}</p>)}
        </div>

        <div className="create-output">
          <div className="candidate-shells" role="group" aria-label="見る案">{candidates.length ? candidates.map((c, i) => <button key={c.key} type="button" className="candidate-option" aria-pressed={i === active} onClick={() => pickCandidate(i)}><span className="num">{c.key}案 ・ {submitted[c.key] ? "キューに保存済み" : c.angle || c.hook}</span><strong>{c.body}</strong><small>{c.comments.length ? `続きの投稿 ${c.comments.length}件` : "1投稿"}{sourceIds.length ? ` ・ 資料 ${sourceIds.length}件` : ""}</small></button>) : ["A","B","C"].map(key => <div className="candidate-option is-empty" key={key}><span className="num">{key}案</span><strong>生成すると、ここに案が並びます。</strong></div>)}</div>
          {candidates.length > 0 && <div className="candidate-dots" aria-hidden="true">{candidates.map((c,i)=><span key={c.key} className={i===active ? "is-active" : ""} />)}</div>}

      {candidates.length > 0 && !manualEditing && <div className="mobile-candidate-actions"><button type="button" className="btn" onClick={() => document.querySelector<HTMLTextAreaElement>("#create-body")?.focus()}>{candidates[active]?.key}案を編集する</button><button type="button" className="icon-btn" aria-label="保存と投稿の操作" onClick={() => setMoreActions(true)}>⋯</button></div>}
          {savedCandidate && <p className="msg msg-warn">この案はキューに保存済みです。変更はキューから行えます。</p>}
          <section className="card candidate-editor"><div className="section-head"><h2>{candidates.length ? `${candidates[active]?.key}案を編集` : "投稿を編集"}</h2><span className="muted">{candidates[active]?.hook}</span></div><PostFields draft={draft} onChange={setDraft} idPrefix="create" compact />
            <div className="media-composer"><input ref={mediaInput} className="sr-only" type="file" accept="image/jpeg,image/png" multiple onChange={event => addMedia(event.target.files)} /><button type="button" className="media-add" onClick={() => mediaInput.current?.click()} disabled={media.length >= MAX_MEDIA} aria-label="画像を追加"><ImageIcon size={21} /><span>{media.length ? `カルーセル ${media.length} / ${MAX_MEDIA}` : "画像を追加"}</span></button><small>選択した順で投稿 · 最大{MAX_MEDIA}枚 · 1枚8MBまで</small></div>
            {media.length > 0 && <><div className="media-strip" aria-label={`選択した画像 ${media.length}枚`}>{media.map((item,index) => <figure className="media-thumb" key={item.id}><img src={item.previewUrl} alt={`${index + 1}枚目 ${item.name}`} /><figcaption>{index + 1}</figcaption><button type="button" aria-label={`${index + 1}枚目を削除`} onClick={() => removeMedia(item.id)}>×</button></figure>)}{media.length < MAX_MEDIA && <button type="button" className="media-more" onClick={() => mediaInput.current?.click()} aria-label="画像を追加">＋</button>}</div><p className="media-storage-note">{mediaUploading ? "画像を安全な一時保存先へ保存しています…" : "投稿に必要な間だけ一時保存し、期限後に自動削除します"}</p></>}
            <div className="buzz-entry"><button type="button" className="btn btn-sub" disabled={!draft.body.trim() || busy} onClick={() => setBuzzStage(buzzResult && buzzSignature === JSON.stringify([draft.body, purpose, media.length]) ? "result" : "confirm")}>バズ診断</button><p>Gemini APIを1回使用します。画像の内容は送信・分析しません。</p></div>
            <div className="revise-row"><label className="field" htmlFor="create-revise"><span>指示で直す{turns.length > 0 ? `（${turns.length / 2}回目）` : ""}</span><AutoTextarea id="create-revise" className="input" rows={2} value={reviseText} placeholder="例：冒頭を短く。具体例は残す" onChange={(e) => setReviseText(e.target.value)} /></label><button type="button" className="btn btn-revise" disabled={busy || !candidates.length || reviseText.trim() === ""} onClick={runRevise}>{revise.isPending ? "直しています…" : "直す"}</button></div>{analysis && <details className="analysis-card"><summary>構成の分析・使った情報を見る</summary><p>{analysis}</p></details>}</section>

          <div className="create-publish-actions"><button type="button" className="btn btn-sub" disabled={busy || Boolean(savedCandidate)} onClick={() => void saveDraft()}>{mediaUploading ? "画像を保存中…" : "下書き保存"}</button><button type="button" className="btn" disabled={busy || Boolean(savedCandidate) || !account.canPublish} onClick={() => { if (guard()) setSheet(true); }}>予約・キューに追加</button><button type="button" className="btn btn-sub" disabled={busy || Boolean(savedCandidate) || !account.canPublish} onClick={() => { if (guard()) setShowPublishNow(true); }}>今すぐ投稿</button></div>
        </div>
      </fieldset>


      <Sheet open={detailSheet} onClose={() => setDetailSheet(false)} title="詳しく決める"><p className="muted">参考投稿の内容ではなく、構成と文体を新しいテーマへ応用します。</p><label className="field fidelity-field" htmlFor="detail-fidelity"><span>参考投稿の再現度 <strong>{fidelity}%</strong></span><input id="detail-fidelity" type="range" min="50" max="90" step="10" value={fidelity} onChange={e=>setFidelity(Number(e.target.value))} /><small>{fidelity <= 50 ? "大まかな流れだけ参考にします" : fidelity >= 90 ? "投稿数・順番・文章のリズムまで近づけます" : "構成と情報を出す順番を参考にします"}。文章の丸写しはしません。</small></label><SourceAdder selected={sourceIds} onChange={setSourceIds} /><label className="field" htmlFor="detail-instruction"><span>追加の指示</span><AutoTextarea id="detail-instruction" className="input" rows={3} value={instruction} placeholder="例：冒頭を短く。具体例は残す" onChange={e=>setInstruction(e.target.value)} /></label>{capabilities.data?.supported && <label className="field"><span>思考量</span><select className="input" value={thinking} onChange={e=>setThinking(e.target.value)}>{capabilities.data.options.map(option=><option value={option.id} key={option.id}>{option.label}</option>)}</select></label>}<button className="btn section" type="button" disabled={!keyReady || !canGenerate} onClick={() => {setDetailSheet(false);void runGenerate();}}>この設定で3案を作る</button></Sheet>

      <Sheet open={moreActions} onClose={() => setMoreActions(false)} title="保存と投稿"><div className="menu-list"><button className="menu-item" disabled={busy || Boolean(savedCandidate)} onClick={() => { setMoreActions(false); void saveDraft(); }}>下書き保存</button><button className="menu-item" disabled={busy || Boolean(savedCandidate) || !account.canPublish} onClick={() => {setMoreActions(false);if(guard())setSheet(true);}}>予約・キューに追加</button><button className="menu-item" disabled={busy || Boolean(savedCandidate) || !account.canPublish} onClick={() => {setMoreActions(false);if(guard())setShowPublishNow(true);}}>今すぐ投稿</button></div></Sheet>
      <PublishNowSheet
        open={showPublishNow}
        onClose={() => setShowPublishNow(false)}
        onConfirm={() => void enqueue({ kind: "now" })}
        username={account.username}
        body={draft.body}
        comments={trimComments(draft.comments)}
        canPublish={account.canPublish === true}
        busy={create.isPending || mediaUploading}
      />
      <ScheduleSheet
        open={sheet}
        onClose={() => setSheet(false)}
        onPick={(pick) => void enqueue(pick)}
        accountId={account.id}
        tz={tz}
        confirmLabel="この時間で予約する"
        busy={create.isPending || mediaUploading}
      />
      <Sheet open={buzzStage !== "closed"} onClose={() => !diagnose.isPending && setBuzzStage("closed")} title={buzzStage === "rewrite" ? "1行目の修正案" : buzzStage === "result" ? `バズ診断　${buzzResult?.score ?? 0} / 100` : buzzStage === "running" ? "バズ診断中…" : "バズ診断を始めます"}>
        {buzzStage === "confirm" && <div className="buzz-confirm"><p><strong>投稿本文と目的をGeminiへ送ります。</strong></p><p className="muted">画像そのもの・画像内の文章は送りません。</p><div className="buzz-api-notice"><strong>Gemini APIを1回使用</strong><p>同じ原稿の結果はこの画面で保持します。結果を見るだけでは再使用しません。</p></div>{media.length > 0 && <p className="muted">カルーセル{media.length}枚ありとして、文章だけを診断します。</p>}<button className="btn" type="button" onClick={() => void runBuzzDiagnosis()}>診断する</button><button className="btn btn-sub" type="button" onClick={() => setBuzzStage("closed")}>キャンセル</button></div>}
        {buzzStage === "running" && <div className="buzz-running" role="status"><span className="generation-spinner" /><strong>1行目・本文・締めを確認しています</strong><div className="generation-progress-bar"><span /></div><p className="muted">画像は送信・分析していません。この画面を閉じずにお待ちください。</p></div>}
        {buzzStage === "result" && buzzResult && <div className="buzz-result"><p className="buzz-priority">まず直すなら「{buzzResult.sections.find(section => section.key === buzzResult.priority)?.label}」</p><div className="buzz-scores">{buzzResult.sections.map(section => <article key={section.key} className={section.key === buzzResult.priority ? "is-priority" : ""}><div><strong>{section.label}</strong><span>{section.score} / {section.maxScore}</span></div><p>{section.feedback}</p></article>)}</div>{media.length > 0 && <p className="muted buzz-media-note">画像内容は送信・分析していません。</p>}<button className="btn" type="button" onClick={() => openPriorityFix(buzzResult.priority)}>{buzzResult.priority === "hook" ? "1行目の修正案を見る" : buzzResult.priority === "body" ? "本文を編集する" : "締めを編集する"}</button><small className="buzz-saved">保存済みの結果 · 開き直しではAPIを使用しません</small></div>}
        {buzzStage === "rewrite" && buzzResult && <div className="buzz-rewrite"><p className="muted">原文と比べて、使いたい案を選びます。</p>{buzzResult.hookSuggestions.map((suggestion,index) => <button type="button" key={suggestion} onClick={() => useHookSuggestion(suggestion)}><span>{String.fromCharCode(65 + index)}案</span><strong>{suggestion}</strong></button>)}<button type="button" className="btn btn-sub" onClick={() => setBuzzStage("result")}>診断結果へ戻る</button></div>}
      </Sheet>
    </div>
  );
}
