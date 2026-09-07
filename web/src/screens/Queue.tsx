/**
 * キュー（SPEC §12.3 / §7.4、design-v0.2 §3-5）。
 *
 * タブ「予約 / 下書き / 投稿済 / 失敗」でリストを切り替える。予約タブには7日分の週表示を
 * 出し、日をタップするとその日だけに絞る。
 *
 * 操作（design-v0.2 §3-5）: 編集 / 複製 / 削除 / 今すぐ投稿 / 日時変更。
 * 投稿済からは リライト（作る画面へ）/ リポスト / 数字を見る。
 * 失敗は日本語の理由（`error`）と Threads の返答そのまま（`error_raw`）を出す。
 * `approve_deadline` の残り時間は client 側で数える（SPEC §12.3）。
 *
 * 動きは `lib/motion.ts` のプリセットだけを使い、下からのシートは `components/Sheet.tsx`
 * に任せる（SPEC §12.5 / apple-design）。
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import type { QueueItem, QueueSlotsResponse } from "@tap/shared";
import {
  QUEUE_TABS,
  useQueueSlots,
  useDeleteQueue,
  usePatchQueue,
  useQueue,
  useQueueAction,
  type QueueTabKey,
} from "../api/queue";
import { useRepost } from "../api/accounts";
import { ApiError } from "../api/client";
import { useShell } from "../components/Shell";
import PostFields, { draftIssue, trimComments, type PostDraft } from "../components/PostFields";
import ScheduleSheet, { type SchedulePick } from "../components/ScheduleSheet";
import PublishNowSheet from "../components/PublishNowSheet";
import Sheet from "../components/Sheet";
import PostingScheduleEditor from "../components/PostingScheduleEditor";
import { DotsIcon, PlusIcon } from "../components/Icons";
import { useToast } from "../components/Toast";
import { CROSSFADE, SPRING, useReducedMotion } from "../lib/motion";
import { fmtN, md, mdhm, remaining } from "../lib/format";
import type { CreatePreset } from "./Home";

/* ── 小さな道具 ────────────────────────────────────── */

/** tz での `YYYY-MM-DD`。週表示の日付キーに使う。 */
function dayKey(value: string | number | Date, tz: string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function weekdayLabel(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: tz, weekday: "narrow" }).format(new Date(ms));
}

/** 曜日の下に出す日にち。ja-JP の `day:'numeric'` は「6日」になるので数字だけにする。 */
function dayNumber(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" }).format(new Date(ms));
}

/** 残り時間の表示を一定間隔で描き直すためだけの時計。 */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * `threadsReason()`（SPEC §6.2）は日本語の理由の末尾に「（Threadsからの返答: #code message）」
 * を足す。開いたパネルでは原文を別の行に出すので、ここでその部分を落として二度書きにしない。
 */
function withoutRaw(message: string): string {
  return message.replace(/（Threadsからの返答:[^）]*）\s*$/, "").trim();
}

const STATUS_LABEL: Record<string, string> = {
  draft: "下書き",
  pending_approval: "承認待ち",
  scheduled: "予約",
  publishing: "投稿中",
  done: "投稿済",
  failed: "失敗",
  cancelled: "取消",
};

function draftOf(item: QueueItem): PostDraft {
  const comments = [...item.comments, "", "", ""].slice(0, 3);
  return { body: item.body, comments };
}

/* ── 画面 ──────────────────────────────────────────── */

type SheetKind = "actions" | "edit" | "schedule" | "publish" | null;

export default function Queue() {
  const { account } = useShell();
  const toast = useToast();
  const navigate = useNavigate();
  const now = useNow();

  const tz = account?.timezone ?? "Asia/Tokyo";
  const accountId = account?.id ?? null;
  const canPublish = account?.canPublish === true;

  const [tab, setTab] = useState<QueueTabKey>("scheduled");
  const [day, setDay] = useState<string | null>(() => dayKey(Date.now(), tz));
  const [showSlots, setShowSlots] = useState(false);
  const [pickSlotAt, setPickSlotAt] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [editDraft, setEditDraft] = useState<PostDraft>({ body: "", comments: ["", "", ""] });

  const { data: items, isPending, isError, error } = useQueue(accountId, tab);
  const daily = useQueueSlots(tab === "scheduled" ? accountId : null, day);
  const drafts = useQueue(pickSlotAt ? accountId : null, "draft");
  const patch = usePatchQueue(accountId);
  const duplicate = useQueueAction(accountId, "duplicate");
  const publishNow = useQueueAction(accountId, "publish-now");
  const approve = useQueueAction(accountId, "approve");
  const cancel = useQueueAction(accountId, "cancel");
  const remove = useDeleteQueue(accountId);
  const repost = useRepost(accountId);

  const selected = useMemo(
    () => [...(items ?? []), ...(daily.data?.slots.flatMap(slot => slot.item ? [slot.item] : []) ?? []), ...(daily.data?.unslotted ?? [])].find(i => i.id === selectedId) ?? null,
    [items, daily.data, selectedId],
  );

  // 週表示の7日（今日から6日後まで）。予約タブでだけ出す
  const week = useMemo(() => {
    const base = Date.now();
    return Array.from({ length: 7 }, (_, i) => {
      const ms = base + i * 86_400_000;
      return { key: dayKey(ms, tz), ms };
    });
  }, [tz]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const it of items ?? []) {
      if (!it.scheduledAt) continue;
      const k = dayKey(it.scheduledAt, tz);
      map.set(k, (map.get(k) ?? 0) + 1);
    }
    return map;
  }, [items, tz]);

  const shown = useMemo(() => {
    const list = items ?? [];
    if (tab !== "scheduled" || !day) return list;
    return list.filter((i) => i.scheduledAt && dayKey(i.scheduledAt, tz) === day);
  }, [items, tab, day, tz]);

  if (!account) return <p className="muted">アカウントがありません。</p>;

  function fail(e: unknown, fallback: string) {
    toast.show(e instanceof ApiError ? e.message : fallback, "bad");
  }

  function openSheet(item: QueueItem, kind: SheetKind) {
    setSelectedId(item.id);
    if (kind === "edit") setEditDraft(draftOf(item));
    setSheet(kind);
  }

  function toCreate(item: QueueItem) {
    const preset: CreatePreset = { mode: "rewrite", postId: item.id, text: item.body };
    setSheet(null);
    navigate("/app/create", { state: { preset } });
  }

  function saveEdit() {
    if (!selected) return;
    const issue = draftIssue(editDraft);
    if (issue) {
      toast.show(issue, "bad");
      return;
    }
    patch.mutate(
      { id: selected.id, patch: { body: editDraft.body, comments: trimComments(editDraft.comments) } },
      {
        onSuccess: () => {
          setSheet(null);
          toast.show("保存しました", "ok");
        },
        onError: (e) => fail(e, "保存できませんでした"),
      },
    );
  }

  function reschedule(pick: SchedulePick) {
    if (!selected || !canPublish) return;
    patch.mutate(
      { id: selected.id, patch: pick.kind === "next_slot" ? { status: "next_slot" } : { scheduledAt: pick.at, status: "scheduled" } },
      {
        onSuccess: item => {
          setSheet(null);
          setTab("scheduled");
          if (item.scheduledAt) setDay(dayKey(item.scheduledAt, tz));
          toast.show(item.status === "pending_approval" ? "承認待ちの日時を変更しました。承認するまで投稿されません" : item.scheduledAt ? `${mdhm(item.scheduledAt, tz)} に予約しました` : "予約しました", "ok");
        },
        onError: (e) => fail(e, "予約できませんでした"),
      },
    );
  }

  return (
    <>
      <div className="page-heading queue-heading">
        <div>
          <p className="eyebrow">PLAN YOUR NEXT CHAPTER</p><h1>下書き・予約</h1>
          {!canPublish && <p className="msg msg-warn">設定でThreads APIを連携すると、予約・投稿できるようになります。</p>}
          <p className="muted" style={{ marginTop: "0.125rem" }}>
            @{account.username} の予約と下書き
          </p>
        </div>
        <div className="queue-heading-actions"><button type="button" className="btn btn-sub btn-fit" onClick={() => setShowSlots(true)}>投稿スロット設定</button>
        <button
          type="button"
          className="btn btn-sub"
          style={{ width: "auto", padding: "0.5rem 0.75rem" }}
          onClick={() => navigate("/app/create")}
        >
          <PlusIcon size={16} /> 作る
        </button></div>
      </div>

      <div className="chips" role="group" aria-label="表示する状態">
        {QUEUE_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className="chip"
            aria-pressed={tab === t.key}
            onClick={() => {
              setTab(t.key);
              setDay(t.key === "scheduled" ? dayKey(Date.now(), tz) : null);
              setOpenId(null);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "scheduled" && (
        <section className="queue-calendar section">
        <div className="queue-calendar-toolbar"><div><h2>投稿カレンダー</h2><p className="muted">空き枠に下書きを入れるだけ。{tz}</p></div><div className="queue-date-controls"><input type="date" className="input" aria-label="予定を見る日" value={day ?? ""} onChange={e => setDay(e.target.value || null)} /><button type="button" className="btn btn-sub btn-fit" onClick={() => setDay(null)} aria-pressed={day === null}>すべての予約</button></div></div>
        <div className="week" role="group" aria-label="7日分の予定">
          {week.map((d) => {
            const n = counts.get(d.key) ?? 0;
            return (
              <button
                key={d.key}
                type="button"
                className="week-day"
                aria-pressed={day === d.key}
                onClick={() => setDay(d.key)}
              >
                <span className="w">{weekdayLabel(d.ms, tz)}</span>
                <span className="d num">{dayNumber(d.ms, tz)}</span>
                <span className={`n num${n === 0 ? " n-zero" : ""}`}>{n === 0 ? "・" : n}</span>
              </button>
            );
          })}
        </div></section>
      )}

      {isError && (
        <p className="msg msg-bad" role="alert">
          {error instanceof ApiError ? error.message : "キューを読み込めませんでした"}
        </p>
      )}

      {tab === "scheduled" && day ? <DailySlots
        date={day} data={daily.data} loading={daily.isPending} error={daily.error}
        now={now} tz={tz} canPublish={canPublish} openId={openId}
        onToggle={id => setOpenId(current => current === id ? null : id)}
        onMenu={item => openSheet(item, "actions")} onFill={setPickSlotAt}
        onSettings={() => setShowSlots(true)}
      /> : isPending ? (
        <p className="muted" style={{ marginTop: "calc(var(--sp) * 3)" }}>
          読み込んでいます…
        </p>
      ) : shown.length === 0 ? (
        <div className="card section">
          <p className="muted">
            {tab === "scheduled" && day
              ? "この日の予約はありません。"
              : tab === "scheduled"
                ? "予約はまだありません。「作る」から下書きを作って、日時を決めます。"
                : tab === "draft"
                  ? "下書きはありません。"
                  : tab === "done"
                    ? "投稿済みはまだありません。"
                    : "失敗した投稿はありません。"}
          </p>
        </div>
      ) : (
        <div className="rows section">
          {shown.map((item) => (
            <QueueRow
              key={item.id}
              item={item}
              tz={tz}
              now={now}
              open={openId === item.id}
              onToggle={() => setOpenId((v) => (v === item.id ? null : item.id))}
              onMenu={() => openSheet(item, "actions")}
            />
          ))}
        </div>
      )}

      <Sheet open={showSlots} onClose={() => setShowSlots(false)} title="毎日の投稿スロット"><PostingScheduleEditor key={accountId} accountId={account.id} /></Sheet>
      <Sheet open={Boolean(pickSlotAt)} onClose={() => setPickSlotAt(null)} title="この枠に下書きを入れる">
        {pickSlotAt && <p className="muted">{mdhm(pickSlotAt, tz)} の枠に予約します。</p>}
        {drafts.isPending ? <p className="muted section">下書きを読み込んでいます…</p> : drafts.isError ? <p className="msg msg-bad" role="alert">下書きを読み込めませんでした。</p> : <div className="choices section">{drafts.data?.map(draft => <button type="button" className="choice" key={draft.id} disabled={patch.isPending || !canPublish} onClick={() => patch.mutate({ id: draft.id, patch: { status: "scheduled", scheduledAt: pickSlotAt, reserveSlot: true } }, {
          onSuccess: item => { setPickSlotAt(null); toast.show(item.status === "pending_approval" ? "この枠へ移動しました。承認するまで投稿されません" : "この枠に予約しました", "ok"); },
          onError: error => fail(error, "予約できませんでした"),
        })}><span className="choice-title slot-draft-body">{draft.body || "（本文なし）"}</span><span className="choice-note">{draft.comments.length ? `ツリー ${draft.comments.length + 1}段` : "1投稿"}</span></button>)}</div>}
        {!drafts.isPending && !drafts.isError && !drafts.data?.length && <p className="muted section">まだ下書きがありません。「作る」で投稿を作成して保存してください。</p>}
        <button type="button" className="btn btn-sub section" onClick={() => navigate("/app/create")}>新しい投稿を作る</button>
      </Sheet>

      {/* ── 操作シート ───────────────────────────────── */}
      <Sheet
        open={sheet === "actions" && selected !== null}
        onClose={() => setSheet(null)}
        title={selected ? `${STATUS_LABEL[selected.status] ?? ""}の操作` : "操作"}
      >
        {selected && (
          <>
            <p className="muted" style={{ marginBottom: "var(--sp)" }}>
              {selected.body.slice(0, 60) || "（本文なし）"}
            </p>
            <div className="menu-list">
              {selected.status !== "done" && selected.status !== "publishing" && (
                <button type="button" className="menu-item" onClick={() => openSheet(selected, "edit")}>
                  編集
                </button>
              )}
              {/* 承認は2形ある（SPEC §7.4）: pending_approval → scheduled と、
                  取消可モード（scheduled ＋ approve_deadline）の締切を消す方 */}
              {(selected.status === "pending_approval" ||
                (selected.status === "scheduled" && selected.approveDeadline)) && (
                <button
                  type="button"
                  className="menu-item"
                  disabled={!canPublish}
                  onClick={() =>
                    approve.mutate(selected.id, {
                      onSuccess: () => {
                        setSheet(null);
                        toast.show("承認しました", "ok");
                      },
                      onError: (e) => fail(e, "承認できませんでした"),
                    })
                  }
                >
                  承認する
                </button>
              )}
              {selected.status !== "done" && selected.status !== "publishing" && <button type="button" className="menu-item" disabled={!canPublish || patch.isPending} onClick={() => reschedule({ kind: "next_slot", at: null })}>次の空き枠へ入れる</button>}
              {selected.status !== "done" && selected.status !== "publishing" && (
                <button
                  type="button"
                  className="menu-item"
                  disabled={!canPublish}
                  onClick={() => openSheet(selected, "schedule")}
                >
                  {selected.scheduledAt ? "日時を変える" : "日時を決める"}
                </button>
              )}
              {selected.status !== "done" && selected.status !== "publishing" && (
                <button
                  type="button"
                  className="menu-item"
                  disabled={!canPublish}
                  onClick={() => openSheet(selected, "publish")}
                >
                  {selected.status === "failed" ? "今すぐ再試行" : "今すぐ投稿"}
                </button>
              )}
              {selected.status === "done" && (
                <>
                  <button type="button" className="menu-item" onClick={() => toCreate(selected)}>
                    リライト
                  </button>
                  <button
                    type="button"
                    className="menu-item"
                    disabled={repost.isPending || !selected.metrics}
                    onClick={() => {
                      const postId = selected.metrics?.postId ?? selected.resultIds[0];
                      if (!postId) {
                        toast.show("投稿IDが見つかりませんでした", "bad");
                        return;
                      }
                      repost.mutate(postId, {
                        onSuccess: () => {
                          setSheet(null);
                          toast.show("リポストしました", "ok");
                        },
                        onError: (e) => fail(e, "リポストできませんでした"),
                      });
                    }}
                  >
                    {repost.isPending ? "リポストしています…" : "リポスト"}
                  </button>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      setOpenId(selected.id);
                      setSheet(null);
                    }}
                  >
                    数字を見る
                  </button>
                  {selected.metrics?.permalink && (
                    <a
                      className="menu-item"
                      href={selected.metrics.permalink}
                      target="_blank"
                      rel="noreferrer noopener"
                      onClick={() => setSheet(null)}
                    >
                      Threads で開く
                    </a>
                  )}
                </>
              )}
              <button
                type="button"
                className="menu-item"
                onClick={() =>
                  duplicate.mutate(selected.id, {
                    onSuccess: () => {
                      setSheet(null);
                      setTab("draft");
                      toast.show("下書きに複製しました", "ok");
                    },
                    onError: (e) => fail(e, "複製できませんでした"),
                  })
                }
              >
                複製
              </button>
              {(selected.status === "scheduled" || selected.status === "pending_approval") && (
                <button
                  type="button"
                  className="menu-item"
                  onClick={() =>
                    cancel.mutate(selected.id, {
                      onSuccess: () => {
                        setSheet(null);
                        toast.show("取り消しました", "ok");
                      },
                      onError: (e) => fail(e, "取り消せませんでした"),
                    })
                  }
                >
                  取り消す
                </button>
              )}
              {selected.status !== "done" && (
                <button
                  type="button"
                  className="menu-item menu-item-bad"
                  onClick={() =>
                    remove.mutate(selected.id, {
                      onSuccess: () => {
                        setSheet(null);
                        toast.show("削除しました", "ok");
                      },
                      onError: (e) => fail(e, "削除できませんでした"),
                    })
                  }
                >
                  削除
                </button>
              )}
            </div>
          </>
        )}
      </Sheet>

      {/* ── 編集シート ───────────────────────────────── */}
      <Sheet open={sheet === "edit" && selected !== null} onClose={() => setSheet(null)} title="編集">
        <PostFields draft={editDraft} onChange={setEditDraft} idPrefix="queue-edit" />
        <button
          type="button"
          className="btn"
          style={{ marginTop: "calc(var(--sp) * 2)" }}
          disabled={patch.isPending}
          onClick={saveEdit}
        >
          {patch.isPending ? "保存しています…" : "保存する"}
        </button>
      </Sheet>

      <PublishNowSheet
        open={sheet === "publish" && selected !== null}
        onClose={() => setSheet(null)}
        username={account.username}
        body={selected?.body ?? ""}
        comments={selected?.comments ?? []}
        canPublish={canPublish}
        busy={publishNow.isPending}
        resume={Boolean(selected?.resultIds.length)}
        onConfirm={() => {
          if (!selected || !canPublish || publishNow.isPending) return;
          publishNow.mutate(selected.id, {
            onSuccess: () => {
              setSheet(null);
              setTab("scheduled");
              setDay(dayKey(Date.now(), tz));
              toast.show("投稿を受け付けました。進行状況を確認できます", "ok");
            },
            onError: e => fail(e, "投稿できませんでした"),
          });
        }}
      />

      {/* ── 日時変更シート ───────────────────────────── */}
      <ScheduleSheet
        open={sheet === "schedule" && selected !== null}
        onClose={() => setSheet(null)}
        onPick={reschedule}
        accountId={accountId}
        tz={tz}
        title="予約する日時"
        confirmLabel="この日時で予約する"
        initialAt={selected?.scheduledAt ?? null}
        busy={patch.isPending}
      />
    </>
  );
}

function DailySlots({ date, data, loading, error, now, tz, canPublish, openId, onToggle, onMenu, onFill, onSettings }: {
  date: string; data: QueueSlotsResponse | undefined; loading: boolean; error: Error | null;
  now: number; tz: string; canPublish: boolean; openId: string | null;
  onToggle: (id: string) => void; onMenu: (item: QueueItem) => void;
  onFill: (at: string) => void; onSettings: () => void;
}) {
  if (loading) return <p className="muted section">この日の投稿スロットを読み込んでいます…</p>;
  if (error) return <p className="msg msg-bad" role="alert">{error instanceof ApiError ? error.message : "投稿スロットを読み込めませんでした"}</p>;
  if (!data) return null;
  const renderItem = (item: QueueItem) => <QueueRow key={item.id} item={item} tz={tz} now={now} open={openId === item.id} onToggle={() => onToggle(item.id)} onMenu={() => onMenu(item)} />;
  return <section className="daily-schedule section" aria-label={`${date}の投稿スロット`}>
    <div className="section-head"><h2>{date.replaceAll("-", "/")} の予定</h2><span className="muted">{data.slots.filter(slot => slot.item).length} / {data.slots.length} 枠に投稿あり</span></div>
    {data.slots.length === 0 && <div className="card"><p className="muted">毎日の投稿スロットを設定すると、空き枠がここに表示されます。</p><button type="button" className="btn btn-sub btn-fit section" onClick={onSettings}>投稿スロットを設定</button></div>}
    <div className="slot-timeline">{data.slots.map(slot => {
      const past = new Date(slot.at).getTime() <= now;
      return <div className="slot-timeline-row" key={slot.at}>
        <div className="slot-timeline-time num"><time dateTime={slot.at}>{slot.time}</time><span className={`slot-timeline-dot${slot.item ? " is-filled" : ""}`} /></div>
        {slot.item ? renderItem(slot.item) : <div className={`slot-empty${past || slot.skipped ? " is-muted" : ""}`}><div><strong>{slot.skipped ? "取り消した枠" : past ? "過ぎた空き枠" : "空き枠"}</strong><p className="muted">{slot.skipped ? "自動作成では埋め直しません" : past ? "この時刻は過ぎています" : "下書きを選んで、この時刻に予約"}</p></div>{!past && !slot.skipped && <button type="button" className="btn btn-sub btn-fit" disabled={!canPublish} onClick={() => onFill(slot.at)}>＋ 下書きを入れる</button>}</div>}
      </div>;
    })}</div>
    {data.unslotted.length > 0 && <div className="section"><h3>スロット以外の予約・投稿</h3><p className="muted">日時を直接指定した投稿や、スロット設定を変える前の予約です。</p><div className="rows section">{data.unslotted.map(renderItem)}</div></div>}
  </section>;
}

/* ── 1行 ───────────────────────────────────────────── */

function QueueRow({
  item,
  tz,
  now,
  open,
  onToggle,
  onMenu,
}: {
  item: QueueItem;
  tz: string;
  now: number;
  open: boolean;
  onToggle: () => void;
  onMenu: () => void;
}) {
  const reduced = useReducedMotion();
  const when = item.scheduledAt ?? item.createdAt;
  const left = item.approveDeadline ? remaining(item.approveDeadline, now) : null;
  const m = item.metrics;

  return (
    <article className="row">
      <div style={{ display: "flex", alignItems: "stretch" }}>
        <button type="button" className="row-main" aria-expanded={open} onClick={onToggle}>
          <div className="row-meta">
            <span>{mdhm(when, tz)}</span>
            <span className={`tag tag-${item.status}`}>{STATUS_LABEL[item.status] ?? item.status}</span>
            {item.comments.length > 0 && <span className="tag">ツリー {item.comments.length + 1}段</span>}
            {item.imageUrl && <span className="tag">画像</span>}
            {item.source === "autopilot" && <span className="tag tag-link">自動</span>}
          </div>
          <div className="row-text">{item.body || "（本文なし）"}</div>

          {item.status === "done" && m && (
            <div className="row-stats num">
              <span className="lead">表示 {fmtN(m.views)}</span>
              <span>いいね {fmtN(m.likes)}</span>
              <span>クリック {fmtN(m.clicks)}</span>
            </div>
          )}
          {item.status === "failed" && item.error && (
            <p className="row-error">{item.error}</p>
          )}
          {left && item.status === "scheduled" && (
            <p className="row-note">あと{left}で自動的に出ます（取り消せます）</p>
          )}
        </button>
        <button
          type="button"
          className="icon-btn"
          style={{ alignSelf: "center", marginRight: "calc(var(--sp) * 0.5)" }}
          aria-label="この投稿の操作"
          onClick={onMenu}
        >
          <DotsIcon size={18} />
        </button>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className="row-panel"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={reduced ? CROSSFADE : SPRING}
          >
            <div className="child">
              <span className="t">1投稿目: {item.body || "（本文なし）"}</span>
              {m && <span className="num">{fmtN(m.views)} 表示</span>}
            </div>
            {item.comments.map((c, i) => (
              <div className="child" key={i}>
                <span className="t">
                  {i + 2}投稿目: {c}
                </span>
              </div>
            ))}

            {item.status === "done" && m && (
              <p className="muted" style={{ marginTop: "var(--sp)" }}>
                {md(m.postedAt, tz)} に投稿 / 返信 {fmtN(m.replies)} / リポスト {fmtN(m.reposts)} / 引用{" "}
                {fmtN(m.quotes)} / クリック {fmtN(m.clicks)}
              </p>
            )}
            {item.status === "done" && !m && (
              <p className="muted" style={{ marginTop: "var(--sp)" }}>
                数字はこのあとの取り込みで入ります。
              </p>
            )}

            {item.status === "failed" && (
              <div className="err-box">
                <p className="err-msg">{withoutRaw(item.error ?? "投稿できませんでした")}</p>
                {item.errorRaw && (
                  <p className="err-raw num">Threads からの返答: {item.errorRaw}</p>
                )}
                <p className="muted" style={{ marginTop: "calc(var(--sp) * 0.5)" }}>
                  本文を直してから「もう一度ためす」を押すと、出せたところの続きから進みます。
                </p>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}
