/**
 * ホーム（SPEC §12.3 / §7.2、design-v0.2 §3-3）。
 *
 * 期間セレクタ（7日 / 2週間 / 1ヶ月 / 3ヶ月）で
 * 上段KPI・グラフ・トップ投稿が切り替わる。URL別クリックは累計。
 * 指標タブの並び替えは client 側（SPEC §12.3）。
 * ツリーは1投稿目に束ねて1行にし、タップで各段の数字を開く。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DashboardPeriod, DashboardResponse, PostSummary } from "@tap/shared";
import { useDashboard, useRepost, useSyncStatus, useStartSync } from "../api/accounts";
import { useQueryClient } from "@tanstack/react-query";
import { meKey } from "../api/auth";
import { ApiError } from "../api/client";
import { useShell } from "../components/Shell";
import Sheet from "../components/Sheet";
import Pagination, { usePagination } from "../components/Pagination";
import { DotsIcon } from "../components/Icons";
import { useToast } from "../components/Toast";
import { fmtK, fmtN, md, mdhm, pct, signed } from "../lib/format";
import Skeleton from "../components/Skeleton";
import PostViewer from "../components/PostViewer";

const PERIODS: Array<{ value: DashboardPeriod; label: string }> = [
  { value: 7, label: "7日" },
  { value: 14, label: "2週間" },
  { value: 30, label: "1ヶ月" },
  { value: 90, label: "3ヶ月" },
];

type MetricKey = "likes" | "views" | "clicks" | "replies" | "reposts" | "quotes";

const METRICS: Array<{ key: MetricKey; label: string }> = [
  { key: "likes", label: "いいね" },
  { key: "views", label: "表示" },
  { key: "clicks", label: "クリック" },
  { key: "replies", label: "返信" },
  { key: "reposts", label: "リポスト" },
  { key: "quotes", label: "引用" },
];

/** 「型にして作る」「リライト」で Create に渡す下敷き（SPEC §12.3）。 */
export type CreatePreset = {
  mode: "template" | "rewrite";
  postId: string;
  text: string;
};

export default function Home() {
  const { account } = useShell();
  const toast = useToast();
  const navigate = useNavigate();
  const [period, setPeriod] = useState<DashboardPeriod>(30);
  const [metric, setMetric] = useState<MetricKey>("views");

  const sync = useSyncStatus(account?.id ?? null);
  const startSync = useStartSync(account?.id ?? null);
  const qc = useQueryClient();
  const lastSync = useRef<{accountId: string; running: boolean; stamp: string | null} | null>(null);
  useEffect(() => {
    if (!account || !sync.data) return;
    const previous = lastSync.current;
    const stamp = sync.data.lastSyncedAt;
    if (sync.data.running || (previous?.accountId === account.id && (previous.running || previous.stamp !== stamp))) {
      void qc.invalidateQueries({queryKey:[account.id,"dashboard"]});
      void qc.invalidateQueries({queryKey:meKey});
    }
    lastSync.current = {accountId: account.id, running: sync.data.running, stamp};
  }, [account?.id, sync.dataUpdatedAt, qc]);

  const tz = account?.timezone ?? "Asia/Tokyo";
  const { data, isPending, isError, error, isPlaceholderData, isFetching } = useDashboard(account?.id ?? null, period);

  if (!account) {
    return <div className="onboarding"><h1>はじめに、2つだけ設定します</h1><p className="muted">どちらも数分で終わります。終わると、投稿の数字と下書きづくりが使えます。</p><div className="onboarding-grid"><section className="card"><span className="step-number" aria-hidden="true">1</span><h2>Threads をつなぐ</h2><p>あなたの Threads アカウントから、投稿と数字を取り込みます。</p><button className="btn" onClick={() => navigate("/connect")}>Threads をつなぐ</button></section><section className="card"><span className="step-number" aria-hidden="true">2</span><h2>AIキーを登録する</h2><p>下書きを AI で作るときに使います。あとからでも登録できます。</p><button className="btn btn-sub" onClick={() => navigate("/app/settings")}>設定でAIキーを登録</button></section></div></div>;
  }

  if (isError && !data) {
    const message = error instanceof ApiError ? error.message : "数字を読み込めませんでした";
    return (
      <p className="msg msg-bad" role="alert">
        {message}
      </p>
    );
  }

  const syncDone = sync.data?.status === "done" && !sync.data.running;
  const runSync = () => startSync.mutate(undefined, { onError: (e) => toast.show(e instanceof ApiError ? e.message : "同期を開始できませんでした", "bad") });
  // 同期が済むまでは、数字より先に「何をすればいいか」を出す
  const syncNotice = syncDone ? null : (
    <div className={`notice home-sync${sync.data?.status === "failed" ? " notice-warn" : ""}`} role="status">
      <div>
        <strong>{sync.data?.status === "failed" ? "同期できませんでした" : sync.data?.running ? "データを取り込んでいます" : "最初の同期をしましょう"}</strong>
        <p>{sync.data?.status === "failed" ? sync.data.message : sync.data?.running ? `${sync.data.posts}件の投稿を保存しました。数字は順に反映されます。` : "Threads から投稿と数字を取り込みます。数分かかることがあります。"}</p>
      </div>
      {/* 失敗は、ほかの取り込みが動いている最中でも出る（GET /sync は failed と running を別々に見る）ので、
          失敗したら常にやり直せるようにする */}
      {sync.data?.status === "failed" ? (
        <div className="notice-actions">
          <button className="btn btn-fit" aria-busy={startSync.isPending} disabled={startSync.isPending} onClick={runSync}>
            {startSync.isPending ? "開始しています…" : "もう一度同期する"}
          </button>
          <button type="button" className="btn-link" onClick={() => navigate("/app/settings")}>診断を開く</button>
        </div>
      ) : !sync.data?.running && (
        <button className="btn btn-fit" aria-busy={startSync.isPending} disabled={startSync.isPending} onClick={runSync}>
          {startSync.isPending ? "開始しています…" : "今すぐ同期"}
        </button>
      )}
    </div>
  );

  return (
    <>
      <div className="page-heading"><div><h1>アナリティクス</h1><p className="muted">@{account.username} の成長と、次の投稿のヒント。</p></div><button className="btn btn-fit" onClick={() => navigate("/app/create")}>投稿をつくる</button></div>
      {syncNotice}
      <div className="dashboard-toolbar"><span className="toolbar-label">{syncDone ? <>{sync.data?.posts}件の投稿を同期済み<button className="btn-link" aria-busy={startSync.isPending} disabled={startSync.isPending} onClick={runSync}>{startSync.isPending ? "開始中…" : "今すぐ同期"}</button></> : "表示期間"}</span><div className="chips" role="group" aria-label="表示期間">
        {PERIODS.map((p) => (
          <button
            key={String(p.value)}
            type="button"
            className="chip"
            aria-pressed={period === p.value}
            onClick={() => setPeriod(p.value)}
          >
            {p.label}
          </button>
        ))}
      </div>

      </div>
      <div className="period-feedback" role="status">{isPlaceholderData ? `${PERIODS.find(p => p.value === data?.period)?.label ?? "前の期間"}のデータを表示中 · 選択した期間を読み込み中…` : isFetching && data ? "最新の数字に更新中…" : "期間内に公開した投稿を表示します。URL別クリックは累計です。"}</div>
      {isError && data && <p className="msg msg-bad" role="alert">更新できませんでした。表示中のデータを残しています。期間を選び直してください。</p>}
      {isPending || !data ? (
        <div className="kpis section">
          {[0, 1, 2, 3].map((i) => <div className="kpi" key={i}><Skeleton lines={2} label="数字を読み込んでいます" /></div>)}
        </div>
      ) : (
        <Loaded
          key={account.id}
          data={data}
          tz={tz}
          metric={metric}
          onMetric={setMetric}
          accountId={account.id}
          onToast={toast.show}
        />
      )}
    </>
  );
}

function Loaded({
  data,
  tz,
  metric,
  onMetric,
  accountId,
  onToast,
}: {
  data: DashboardResponse;
  tz: string;
  metric: MetricKey;
  onMetric: (m: MetricKey) => void;
  accountId: string;
  onToast: (text: string, kind?: "info" | "ok" | "bad") => void;
}) {
  const navigate = useNavigate();
  const sorted = useMemo(
    () => [...data.posts].sort((a, b) => (b[metric] ?? 0) - (a[metric] ?? 0)),
    [data.posts, metric],
  );

  const postPaging = usePagination(sorted, `${accountId}:${data.period}:${metric}`);
  const linkPaging = usePagination(data.links, accountId);

  const followerSeries = data.followers.series.map((f) => ({ x: md(f.date, tz), n: f.n }));
  const viewSeries = data.views.series.map((v) => ({ x: md(v.date, tz), v: v.v }));

  return (
    <>
      {/* 上段KPI（design-v0.2 §3-3） */}
      <section className="section kpis" aria-label="この期間の数字">
        <div className="kpi">
          <div className="label">フォロワー</div>
          <div className="value num">{fmtN(data.followers.current)}</div>
          <div
            className={`delta num ${
              data.followers.delta > 0 ? "delta-up" : data.followers.delta < 0 ? "delta-down" : ""
            }`}
          >
            {signed(data.followers.delta)} / 期間
          </div>
        </div>
        <div className="kpi">
          <div className="label">表示回数</div>
          <div className="value num">{fmtN(data.views.total)}</div>
          <div className="delta num">1日平均 {fmtK(data.views.total / Math.max(1, data.views.series.length))}</div>
        </div>
        <div className="kpi">
          <div className="label">いいね</div>
          <div className="value num">{fmtN(data.likes)}</div>
          <div className="delta num">いいね率 {pct(data.likes, data.views.total)}</div>
        </div>
        <div className="kpi">
          <div className="label">リンククリック</div>
          <div className="value num">{fmtN(data.clicks)}</div>
          <div className="delta num">CTR {pct(data.clicks, data.views.total)}</div>
        </div>
      </section>

      <div className="dashboard-charts">
      {/* グラフ */}
      <section className="section" aria-label="フォロワー推移">
        <div className="chart-card">
          <div className="chart-title">フォロワー推移</div>
          {followerSeries.length <= 1 ? (
            <div className="chart-empty">
              <p className="muted">
                明日から推移が出ます。
                <br />
                フォロワー数は、つないだ日から毎日記録します。
              </p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={followerSeries} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis dataKey="x" tick={{ fontSize: 10, fill: "var(--ink3)" }} minTickGap={22} />
                <YAxis tick={{ fontSize: 10, fill: "var(--ink3)" }} width={34} tickFormatter={fmtK} />
                <Tooltip content={<Tip unit="人" />} />
                <Line
                  type="monotone"
                  dataKey="n"
                  stroke="var(--chart)"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      <section className="section" aria-label="日別の表示回数">
        <div className="chart-card">
          <div className="chart-title">日別の表示回数</div>
          {viewSeries.length === 0 ? (
            <div className="chart-empty">
              <p className="muted">この期間の表示回数はまだありません。<br />同期すると、ここに日ごとの数字が出ます。</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={viewSeries} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="var(--line)" vertical={false} />
                <XAxis dataKey="x" tick={{ fontSize: 10, fill: "var(--ink3)" }} minTickGap={22} />
                <YAxis tick={{ fontSize: 10, fill: "var(--ink3)" }} width={34} tickFormatter={fmtK} />
                <Tooltip content={<Tip unit="回" />} cursor={{ fill: "var(--paper2)" }} />
                <Bar dataKey="v" fill="var(--chart)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      <TimeBuckets posts={data.posts} tz={tz} />

      </div>
      {/* トップ投稿 */}
      <section className="section" aria-label="トップ投稿">
        <div className="section-head">
          <h2>トップ投稿</h2>
          <span className="muted">{PERIODS.find(p => p.value === data.period)?.label}に公開 · {data.posts.length}本</span>
        </div>

        <div className="chips" role="group" aria-label="並べ替える指標">
          {METRICS.map((m) => (
            <button
              key={m.key}
              type="button"
              className="chip"
              aria-pressed={metric === m.key}
              onClick={() => onMetric(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>

        {sorted.length === 0 ? (
          <p className="muted" style={{ marginTop: "var(--sp)" }}>
            この期間に公開した投稿はありません。期間を広げると、前の投稿も並びます。
          </p>
        ) : (
          <div className="rows" style={{ marginTop: "var(--sp)" }}>
            {postPaging.items.map((p) => (
              <PostRow
                key={p.id}
                post={p}
                metric={metric}
                tz={tz}
                accountId={accountId}
                onToast={onToast}
              />
            ))}
          </div>
        )}
      </section>

      <Pagination label="トップ投稿" paging={postPaging} />
      {/* リンク */}
      <section className="section" aria-label="リンク">
        <div className="section-head">
          <h2>リンク</h2>
          <button className="btn btn-sub btn-fit" onClick={() => navigate("/app/settings?tab=links")}>リンク名を編集</button>
        </div>
        <p className="muted">URL別クリックの累計です。上の表示期間では絞り込まれません。</p>
        <div className="card">
          {data.links.length === 0 ? (
            <p className="muted">まだクリックのあるリンクがありません。</p>
          ) : (
            linkPaging.items.map((l) => (
              <div className="link-row" key={l.url}>
                <span style={{ minWidth: 0 }}>
                  <span className="label">{l.label}</span>
                  {l.label !== l.url && <span className="url">{l.url}</span>}
                  <span className="url">{l.posts}本の投稿に入っています</span>
                </span>
                <span className="num" style={{ fontWeight: 700, whiteSpace: "nowrap" }}>
                  {fmtN(l.clicks)}
                </span>
              </div>
            ))
          )}
          <p className="muted" style={{ marginTop: "var(--sp)" }}>
            どの投稿にも結びつかなかったクリック: {fmtN(data.unassignedClicks)}
          </p>
        </div>
        <Pagination label="リンク" paging={linkPaging} />
      </section>
    </>
  );
}

/** 朝・昼・夕・夜ごとの1投稿あたりの表示回数（B 系統の分析画面から。DECISIONS 2026-10-20） */
function TimeBuckets({ posts, tz }: { posts: DashboardResponse["posts"]; tz: string }) {
  const buckets = [
    { label: "朝", total: 0, count: 0 },
    { label: "昼", total: 0, count: 0 },
    { label: "夕", total: 0, count: 0 },
    { label: "夜", total: 0, count: 0 },
  ];
  for (const post of posts) {
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date(post.postedAt)));
    const i = hour >= 5 && hour < 11 ? 0 : hour >= 11 && hour < 16 ? 1 : hour >= 16 && hour < 21 ? 2 : 3;
    buckets[i]!.total += post.views;
    buckets[i]!.count += 1;
  }
  const rows = buckets.map((b) => ({ ...b, average: b.count ? Math.round(b.total / b.count) : 0 }));
  const max = Math.max(1, ...rows.map((b) => b.average));
  const best = rows.reduce((a, b) => (b.average > a.average ? b : a), rows[0]!);
  return (
    <section className="section" aria-label="時間帯別の結果">
      <div className="chart-card">
        <div className="chart-title">時間帯別の結果</div>
        {posts.length === 0 ? (
          <div className="chart-empty"><p className="muted">投稿が増えると、反応の良い時間帯がここに出ます。</p></div>
        ) : (
          <>
            <div className="time-bucket-chart" aria-label="時間帯別の1投稿平均表示数">
              {rows.map((b) => (
                <div key={b.label}>
                  <span><i style={{ height: `${Math.max(b.average ? 8 : 0, (b.average / max) * 100)}%` }} /></span>
                  <b className="num">{fmtN(b.average)}</b>
                  <small>{b.label}</small>
                </div>
              ))}
            </div>
            <p className="muted time-insight">この期間は「{best.label}」が1投稿あたりいちばん多く表示されています。</p>
          </>
        )}
      </div>
    </section>
  );
}

function Tip({
  active,
  payload,
  label,
  unit,
}: {
  active?: boolean;
  payload?: Array<{ value?: number }>;
  label?: string;
  unit: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tip">
      <span className="muted">{label}</span>{" "}
      <span className="num" style={{ fontWeight: 700 }}>
        {fmtN(payload[0]?.value ?? 0)}
        {unit}
      </span>
    </div>
  );
}

function PostRow({
  post,
  metric,
  tz,
  accountId,
  onToast,
}: {
  post: PostSummary;
  metric: MetricKey;
  tz: string;
  accountId: string;
  onToast: (text: string, kind?: "info" | "ok" | "bad") => void;
}) {
  const navigate = useNavigate();
  const { account } = useShell();
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const repost = useRepost(accountId);

  const metricLabel = METRICS.find((m) => m.key === metric)?.label ?? "";
  // 並べ替えに使っている指標を先頭に出し、残りから2つ添える（同じ数字を二度出さない）
  const sideMetrics = (["views", "likes", "clicks"] as const)
    .filter((k) => k !== metric)
    .slice(0, 2);

  function toCreate(mode: CreatePreset["mode"]) {
    const preset: CreatePreset = { mode, postId: post.id, text: post.text };
    setSheet(false);
    setOpen(false);
    navigate("/app/create", { state: { preset } });
  }

  return (
    <article className="row">
      <div style={{ display: "flex", alignItems: "stretch" }}>
        <button
          type="button"
          className="row-main"
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          <div className="row-meta">
            <span>{mdhm(post.postedAt, tz)}</span>
            <span className="tag">{post.hook}</span>
            {post.children.length > 0 && <span className="tag">ツリー {post.children.length + 1}段</span>}
            {post.link && <span className="tag tag-link">リンク</span>}
          </div>
          <div className="row-text">{post.text || "（本文なし）"}</div>
          <div className="row-stats num">
            <span className="lead">
              {metricLabel} {fmtN(post[metric])}
            </span>
            {sideMetrics.map((k) => (
              <span key={k}>
                {METRICS.find((m) => m.key === k)?.label} {fmtK(post[k])}
              </span>
            ))}
          </div>
        </button>
        <button
          type="button"
          className="icon-btn"
          style={{ alignSelf: "center", marginRight: "calc(var(--sp) * 0.5)" }}
          aria-label="この投稿の操作"
          onClick={() => setSheet(true)}
        >
          <DotsIcon size={18} />
        </button>
      </div>

      {account && (
        <PostViewer
          open={open}
          onClose={() => setOpen(false)}
          account={account}
          title={`${mdhm(post.postedAt, tz)} の投稿`}
          escapeDisabled={sheet}
          meta={
            <>
              <span className="tag">{post.hook}</span>
              {post.link && <span className="tag tag-link">リンク</span>}
            </>
          }
          segments={[
            { text: post.text, views: post.views },
            ...post.children.map((c, i) => ({
              text: c.text,
              views: c.views,
              ...(i === 0 ? { note: `1投稿目からの遷移率 ${pct(c.views, post.views)}` } : {}),
            })),
          ]}
          stats={[
            { label: "表示", value: fmtN(post.views) },
            { label: "いいね", value: fmtN(post.likes) },
            { label: "返信", value: fmtN(post.replies) },
            { label: "リポスト", value: fmtN(post.reposts) },
            { label: "引用", value: fmtN(post.quotes) },
            { label: "クリック", value: fmtN(post.clicks) },
          ]}
          headerActions={
            post.permalink && (
              <a className="btn-link" href={post.permalink} target="_blank" rel="noreferrer noopener">
                Threads で開く
              </a>
            )
          }
          actions={
            <>
              <button type="button" className="btn btn-sub" onClick={() => toCreate("rewrite")}>
                リライト
              </button>
              <button type="button" className="btn" onClick={() => toCreate("template")}>
                これを型にして作る
              </button>
            </>
          }
        />
      )}

      <Sheet open={sheet} onClose={() => setSheet(false)} title={md(post.postedAt, tz) + " の投稿"}>
        <p className="muted" style={{ marginBottom: "var(--sp)" }}>
          {post.text.slice(0, 60) || "（本文なし）"}
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "calc(var(--sp) * 0.75)" }}>
          <button type="button" className="menu-item" onClick={() => toCreate("rewrite")}>
            リライト
          </button>
          <button type="button" className="menu-item" onClick={() => toCreate("template")}>
            これを型にして作る
          </button>
          <button aria-busy={repost.isPending}
            type="button"
            className="menu-item"
            disabled={repost.isPending}
            onClick={() => {
              repost.mutate(post.id, {
                onSuccess: () => {
                  setSheet(false);
                  onToast("リポストしました", "ok");
                },
                onError: (e) => {
                  onToast(e instanceof ApiError ? e.message : "リポストできませんでした", "bad");
                },
              });
            }}
          >
            {repost.isPending ? "リポストしています…" : "リポスト"}
          </button>
          <a
            className="menu-item"
            href={post.permalink ?? "#"}
            target="_blank"
            rel="noreferrer noopener"
            aria-disabled={!post.permalink}
            onClick={(e) => {
              if (!post.permalink) {
                e.preventDefault();
                onToast("この投稿のURLがありません", "bad");
                return;
              }
              setSheet(false);
            }}
          >
            Threads で開く
          </a>
        </div>
      </Sheet>
    </article>
  );
}
