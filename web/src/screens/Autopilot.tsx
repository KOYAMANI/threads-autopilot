/**
 * オートパイロット（SPEC §12.3 / design-v0.2 §3-6）。
 *
 * 上から順に「いま何が起きるか」→「どう動かすか」→「何が分かったか」→「何をしたか」。
 *
 * - ON/OFF … できないときは押した瞬間に**理由をトースト**で返す（SPEC §12.3）
 * - 頻度・時間帯（自動/固定）・ネタ源・型（自動/固定）・リンク・承認方式3種・上限
 * - 学習の表 … 型別と枠別。列は「型/枠 | 平均表示回数 | いいね率 | 本数」。
 *   `n < 10` の行は3列とも「集計中（あと◯本）」。**倍率・おすすめ・予測は出さない**
 * - ap_log
 */
import { useEffect, useMemo, useState } from "react";
import type { AutopilotSettings, LearningRow, SourceSummary } from "@tap/shared";
import { DEFAULT_HOOK_ORDER, MIN_SAMPLES_LEARNING } from "@tap/shared";
import {
  useApLog,
  useAutopilot,
  useLearning,
  usePutAutopilot,
} from "../api/autopilot";
import { usePatchSource, useSources } from "../api/ai";
import { useLinks } from "../api/accounts";
import { useToast } from "../components/Toast";
import { useShell } from "../components/Shell";
import { ApiError } from "../api/client";
import { fmtN, mdhm, pct } from "../lib/format";

/** 頻度の選択肢（SPEC §4 の `per_week` のコメントと同じ4つ）。 */
const FREQUENCIES = [
  { value: 3, label: "週3本", note: "月・火・水に1本ずつ" },
  { value: 5, label: "週5本", note: "平日に1本ずつ" },
  { value: 7, label: "1日1本", note: "毎日1本" },
  { value: 14, label: "1日2本", note: "毎日2本" },
] as const;

const APPROVAL_MODES = [
  {
    value: "manual" as const,
    label: "毎回承認する",
    note: "メールが届き、承認するまで出しません",
  },
  {
    value: "cancel" as const,
    label: "取消可",
    note: "投稿の前に知らせます。何もしなければ出ます",
  },
  { value: "auto" as const, label: "全部おまかせ", note: "確認なしで出します" },
];

const LINK_PLACEMENTS = [
  { value: "comment" as const, label: "コメントに置く", note: "本文にURLを書きません" },
  { value: "body" as const, label: "本文に置く", note: "本文にURLを入れます" },
  { value: "none" as const, label: "使わない", note: "リンクを入れません" },
];

const SLOT_HOURS = [0, 3, 6, 9, 12, 15, 18, 21];

export default function Autopilot() {
  const { account } = useShell();
  const accountId = account?.id ?? null;
  const tz = account?.timezone ?? "Asia/Tokyo";
  const toast = useToast();

  const ap = useAutopilot(accountId);
  const put = usePutAutopilot(accountId);
  const learning = useLearning(accountId);
  const log = useApLog(accountId);
  const sources = useSources();
  const links = useLinks(accountId);
  const patchSource = usePatchSource();

  const settings = ap.data?.settings ?? null;

  /** 1項目だけ送る。失敗はサーバーの日本語をそのままトーストに出す（SPEC §12.2）。 */
  const patch = (body: Partial<AutopilotSettings>, okMessage?: string) => {
    put.mutate(body, {
      onSuccess: () => {
        if (okMessage) toast.show(okMessage, "ok");
      },
      onError: (e) => {
        toast.show(e instanceof ApiError ? e.message : "保存できませんでした", "bad");
      },
    });
  };

  if (!accountId) return <p className="muted">アカウントを選んでください。</p>;

  return (
    <>
      <div className="page-heading"><div><p className="eyebrow">YOUR PUBLISHING ROUTINE</p><h1>オートパイロット</h1><p className="muted">実績をもとに、投稿の型とスケジュールを整えます。</p></div></div>

      <details className="card section autopilot-guide" open>
        <summary>オートパイロットの使い方</summary>
        <ol><li>参考情報・投稿頻度・使うリンクを設定します。</li><li>オンにすると、設定した参考情報からAIが下書きと投稿予定を作ります。</li><li>「毎回承認する」なら、内容を確認して承認するまで投稿されません。</li><li>予約時刻に投稿し、投稿後の数字を次の型・時間帯選びに使います。</li></ol>
        <p className="muted">最初は「毎回承認する」がおすすめです。「取消可」は何もしないと投稿され、「全部おまかせ」は確認なしで投稿されます。自動作成・予約投稿はサーバーの定期実行で動きます。</p>
      </details>

      {ap.isPending && <p className="muted section">読み込んでいます…</p>}

      {settings && (
        <>
          <PowerCard
            settings={settings}
            canEnable={ap.data?.canEnable ?? false}
            blockerMessages={ap.data?.blockerMessages ?? []}
            pending={put.isPending}
            onToggle={(next) => {
              if (next && !(ap.data?.canEnable ?? false)) {
                // ON にできない理由はトーストで返す（SPEC §12.3）。押す前に読める形にする
                toast.show(ap.data?.blockerMessages[0] ?? "いまはオンにできません", "bad");
                return;
              }
              patch({ enabled: next }, next ? "オンにしました" : "オフにしました");
            }}
          />

          <div className="autopilot-grid">
          <FrequencyCard settings={settings} onChange={patch} />
          <SlotCard settings={settings} onChange={patch} />
          <HookCard settings={settings} onChange={patch} />
          <SourceCard
            sources={sources.data ?? []}
            pending={sources.isPending}
            onToggle={(id, enabled) =>
              patchSource.mutate(
                { id, enabledForAp: enabled },
                {
                  // ネタ源が0件になると ON にできなくなる（SPEC §7.7）。
                  // 判定はサーバー側なので、設定そのものを引き直して警告文を追いつかせる
                  onSuccess: () => void ap.refetch(),
                  onError: (e) =>
                    toast.show(e instanceof ApiError ? e.message : "保存できませんでした", "bad"),
                },
              )
            }
          />
          <LinkCard
            settings={settings}
            linkCount={links.data?.length ?? 0}
            onChange={patch}
          />
          <ApprovalCard settings={settings} onChange={patch} />
          <LimitCard settings={settings} onChange={patch} />
          </div>
        </>
      )}

      <LearningTables rows={learning.data ?? []} pending={learning.isPending} />

      <section className="card section">
        <div className="section-head">
          <h2>したこと</h2>
        </div>
        {log.isPending && <p className="muted">読み込んでいます…</p>}
        {!log.isPending && (log.data ?? []).length === 0 && (
          <p className="muted">まだ記録はありません。</p>
        )}
        <div className="rows">
          {(log.data ?? []).map((e) => (
            <div key={e.id} className="link-row">
              <span className="label">{e.message}</span>
              <span className="url">{mdhm(e.at, tz)}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

/* ── ON/OFF ─────────────────────────────────────────── */

function PowerCard({
  settings,
  canEnable,
  blockerMessages,
  pending,
  onToggle,
}: {
  settings: AutopilotSettings;
  canEnable: boolean;
  blockerMessages: string[];
  pending: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <section className="card section">
      <div className="section-head">
        <h2>{settings.enabled ? "自動投稿がオンです" : "自動投稿がオフです"}</h2>
      </div>
      <p className="muted">
        {settings.enabled
          ? "24時間先までの下書きを毎時つくり、承認方式にしたがって投稿します。"
          : "オンにすると、参考情報から下書きを作って予約します。"}
      </p>

      <div className="section">
        <button
          type="button"
          className={settings.enabled ? "btn btn-sub" : "btn"}
          disabled={pending}
          aria-pressed={settings.enabled}
          onClick={() => onToggle(!settings.enabled)}
        >
          {pending ? "保存しています…" : settings.enabled ? "オフにする" : "オンにする"}
        </button>
      </div>

      {!canEnable && !settings.enabled && blockerMessages.length > 0 && (
        <div className="msg msg-warn section" role="status">
          <p style={{ margin: 0 }}>いまはオンにできません。</p>
          <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.1rem" }}>
            {blockerMessages.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      {settings.consecutiveFailures > 0 && (
        <p className="msg msg-warn section" role="status">
          続けて{settings.consecutiveFailures}回失敗しています（3回で自動的に止まります）
        </p>
      )}
    </section>
  );
}

/* ── 頻度・枠・型・ネタ源・リンク・承認・上限 ────────── */

type Patcher = (body: Partial<AutopilotSettings>, ok?: string) => void;

function FrequencyCard({
  settings,
  onChange,
}: {
  settings: AutopilotSettings;
  onChange: Patcher;
}) {
  return (
    <section className="card section">
      <div className="section-head">
        <h2>どれくらい出すか</h2>
      </div>
      <div className="choices" role="radiogroup" aria-label="頻度">
        {FREQUENCIES.map((f) => (
          <button
            key={f.value}
            type="button"
            role="radio"
            className="choice"
            aria-checked={settings.perWeek === f.value}
            onClick={() => onChange({ perWeek: f.value })}
          >
            <span className="choice-title">{f.label}</span>
            <span className="choice-note">{f.note}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function SlotCard({ settings, onChange }: { settings: AutopilotSettings; onChange: Patcher }) {
  const fixed = settings.slotMode === "fixed";
  return (
    <section className="card section">
      <div className="section-head">
        <h2>いつ出すか</h2>
      </div>
      <div className="choices" role="radiogroup" aria-label="時間帯の決め方">
        <button
          type="button"
          role="radio"
          className="choice"
          aria-checked={!fixed}
          onClick={() => onChange({ slotMode: "auto" })}
        >
          <span className="choice-title">自動</span>
          <span className="choice-note">
            実績のある枠から選びます（まだ足りなければ平日21時・土日12時）
          </span>
        </button>
        <button
          type="button"
          role="radio"
          className="choice"
          aria-checked={fixed}
          onClick={() => onChange({ slotMode: "fixed", fixedHour: settings.fixedHour ?? 21 })}
        >
          <span className="choice-title">時間を固定</span>
          <span className="choice-note">毎回この時間に出します</span>
        </button>
      </div>

      {fixed && (
        <div className="chips section" role="radiogroup" aria-label="固定する時間">
          {SLOT_HOURS.map((h) => (
            <button
              key={h}
              type="button"
              role="radio"
              className="chip"
              aria-checked={(settings.fixedHour ?? 21) === h}
              aria-pressed={(settings.fixedHour ?? 21) === h}
              onClick={() => onChange({ fixedHour: h })}
            >
              {h}時
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function HookCard({ settings, onChange }: { settings: AutopilotSettings; onChange: Patcher }) {
  const fixed = settings.hookMode === "fixed";
  return (
    <section className="card section">
      <div className="section-head">
        <h2>どの型で書くか</h2>
      </div>
      <div className="choices" role="radiogroup" aria-label="型の決め方">
        <button
          type="button"
          role="radio"
          className="choice"
          aria-checked={!fixed}
          onClick={() => onChange({ hookMode: "auto" })}
        >
          <span className="choice-title">自動</span>
          <span className="choice-note">
            実績のある型から、直近3本と重ならないように選びます
          </span>
        </button>
        <button
          type="button"
          role="radio"
          className="choice"
          aria-checked={fixed}
          onClick={() =>
            onChange({ hookMode: "fixed", fixedHook: settings.fixedHook ?? DEFAULT_HOOK_ORDER[0]! })
          }
        >
          <span className="choice-title">型を固定</span>
          <span className="choice-note">毎回この型で書きます</span>
        </button>
      </div>

      {fixed && (
        <div className="chips section" role="radiogroup" aria-label="固定する型">
          {DEFAULT_HOOK_ORDER.map((h) => (
            <button
              key={h}
              type="button"
              role="radio"
              className="chip"
              aria-checked={settings.fixedHook === h}
              aria-pressed={settings.fixedHook === h}
              onClick={() => onChange({ fixedHook: h })}
            >
              {h}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function SourceCard({
  sources,
  pending,
  onToggle,
}: {
  sources: SourceSummary[];
  pending: boolean;
  onToggle: (id: string, enabled: boolean) => void;
}) {
  const on = sources.filter((s) => s.enabledForAp).length;
  return (
    <section className="card section">
      <div className="section-head">
        <h2>何から書くか</h2>
        <span className="muted">{on}件を使います</span>
      </div>
      {pending && <p className="muted">読み込んでいます…</p>}
      {!pending && sources.length === 0 && (
        <p className="muted">
          参考情報がありません。「作る」から追加すると、ここで選べるようになります。
        </p>
      )}
      <div className="chips">
        {sources.map((s) => (
          <button
            key={s.id}
            type="button"
            className="chip"
            aria-pressed={s.enabledForAp}
            onClick={() => onToggle(s.id, !s.enabledForAp)}
          >
            {s.title}
          </button>
        ))}
      </div>
      {sources.length > 0 && (
        <p className="muted section">同じネタ源は7日以内に使い回しません。</p>
      )}
    </section>
  );
}

function LinkCard({
  settings,
  linkCount,
  onChange,
}: {
  settings: AutopilotSettings;
  linkCount: number;
  onChange: Patcher;
}) {
  return (
    <section className="card section">
      <div className="section-head">
        <h2>リンクをどこに置くか</h2>
        <span className="muted">{linkCount}本のリンク</span>
      </div>
      <div className="choices" role="radiogroup" aria-label="リンクの置き場所">
        {LINK_PLACEMENTS.map((p) => (
          <button
            key={p.value}
            type="button"
            role="radio"
            className="choice"
            aria-checked={settings.linkPlacement === p.value}
            onClick={() => onChange({ linkPlacement: p.value })}
          >
            <span className="choice-title">{p.label}</span>
            <span className="choice-note">{p.note}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function ApprovalCard({ settings, onChange }: { settings: AutopilotSettings; onChange: Patcher }) {
  return (
    <section className="card section">
      <div className="section-head">
        <h2>出す前に確認するか</h2>
      </div>
      <div className="choices" role="radiogroup" aria-label="承認方式">
        {APPROVAL_MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            role="radio"
            className="choice"
            aria-checked={settings.approvalMode === m.value}
            onClick={() => onChange({ approvalMode: m.value })}
          >
            <span className="choice-title">{m.label}</span>
            <span className="choice-note">{m.note}</span>
          </button>
        ))}
      </div>

      {settings.approvalMode === "cancel" && (
        <div className="chips section" role="radiogroup" aria-label="何時間前に知らせるか">
          {[1, 2, 4, 8, 12].map((h) => (
            <button
              key={h}
              type="button"
              role="radio"
              className="chip"
              aria-checked={settings.approvalWindowH === h}
              aria-pressed={settings.approvalWindowH === h}
              onClick={() => onChange({ approvalWindowH: h })}
            >
              {h}時間前
            </button>
          ))}
        </div>
      )}
      <p className="muted section">
        メールのリンクはログインしなくても踏めます。1回だけ使えます。
      </p>
    </section>
  );
}

function LimitCard({ settings, onChange }: { settings: AutopilotSettings; onChange: Patcher }) {
  const [ng, setNg] = useState(settings.ngWords);
  // サーバー側が変わったら（他の端末で保存した等）入力欄も追いつかせる
  useEffect(() => setNg(settings.ngWords), [settings.ngWords]);

  return (
    <section className="card section">
      <div className="section-head">
        <h2>安全のための上限</h2>
      </div>

      <label className="field">
        <span>1日に出す本数の上限</span>
        <div className="chips" role="radiogroup" aria-label="1日の上限">
          {[1, 2, 3].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              className="chip"
              aria-checked={settings.dailyLimit === n}
              aria-pressed={settings.dailyLimit === n}
              onClick={() => onChange({ dailyLimit: n })}
            >
              {n}本
            </button>
          ))}
        </div>
      </label>

      <button
        type="button"
        className="choice section"
        role="switch"
        aria-checked={settings.quietHours}
        onClick={() => onChange({ quietHours: !settings.quietHours })}
      >
        <span className="choice-title">
          深夜帯（0〜6時）に出さない{settings.quietHours ? "（オン）" : "（オフ）"}
        </span>
        <span className="choice-note">オンのあいだ、0時・3時・6時の枠は候補から外します</span>
      </button>

      <label className="field section">
        <span>使わない言葉</span>
        <textarea
          className="input"
          rows={3}
          placeholder={"改行か読点で区切ります\n例: 絶対、必ず、稼げる"}
          value={ng}
          onChange={(e) => setNg(e.target.value)}
          onBlur={() => {
            if (ng !== settings.ngWords) onChange({ ngWords: ng }, "使わない言葉を保存しました");
          }}
        />
      </label>
      <p className="muted">入った下書きは投稿されず、次の枠で作り直します。</p>
    </section>
  );
}

/* ── 学習の表（SPEC §12.3） ─────────────────────────── */

function LearningTables({ rows, pending }: { rows: LearningRow[]; pending: boolean }) {
  const hooks = useMemo(
    () => rows.filter((r) => r.dim === "hook"),
    [rows],
  );
  const slots = useMemo(
    () => rows.filter((r) => r.dim === "slot"),
    [rows],
  );

  return (
    <section className="card section">
      <div className="section-head">
        <h2>分かったこと</h2>
      </div>

      {pending && <p className="muted">読み込んでいます…</p>}
      {!pending && hooks.length === 0 && slots.length === 0 && (
        <p className="muted">
          まだ集計がありません。投稿から48時間たつと、ここに数字が出はじめます。
        </p>
      )}

      {hooks.length > 0 && <LearningTable title="型別" head="型" rows={hooks} />}
      {slots.length > 0 && <LearningTable title="枠別" head="枠" rows={slots} />}

      {(hooks.length > 0 || slots.length > 0) && (
        <p className="muted section">
          投稿から48時間後の数字をもとに集計しています。ホームの表示回数（最新値）とは一致しません。AIは本文を書くだけで、この集計には関わりません。
        </p>
      )}
    </section>
  );
}

function LearningTable({
  title,
  head,
  rows,
}: {
  title: string;
  head: string;
  rows: LearningRow[];
}) {
  return (
    <div className="section">
      <h3 className="learn-title">{title}</h3>
      <div className="learn-table" role="table" aria-label={title}>
        <div className="learn-row learn-head" role="row">
          <span role="columnheader">{head}</span>
          <span role="columnheader">平均表示回数</span>
          <span role="columnheader">いいね率</span>
          <span role="columnheader">本数</span>
        </div>
        {rows.map((r) => {
          // n < 10 は3列とも「集計中（あと◯本）」（SPEC §12.3）
          const short = r.avgViews === null;
          const rest = MIN_SAMPLES_LEARNING - r.n;
          return (
            <div key={`${r.dim}:${r.value}`} className="learn-row" role="row">
              <span role="cell">{r.label ?? r.value}</span>
              {short ? (
                <span role="cell" className="muted learn-wide" style={{ gridColumn: "2 / -1" }}>
                  集計中（あと{rest}本）
                </span>
              ) : (
                <>
                  <span role="cell" className="num">
                    {fmtN(r.avgViews)}
                  </span>
                  <span role="cell" className="num">
                    {pct(r.likeRate ?? 0, 1, 1)}
                  </span>
                  <span role="cell" className="num">
                    {r.n}
                  </span>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
