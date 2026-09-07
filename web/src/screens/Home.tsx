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
import { AnimatePresence, motion } from "motion/react";
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
import { CROSSFADE, SPRING, useReducedMotion } from "../lib/motion";
import { fmtK, fmtN, md, mdhm, pct, signed } from "../lib/format";

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
    return <div className="onboarding"><p className="eyebrow">WELCOME TO YOUR WORKSPACE</p><h1>ここから、あなたのThreadsを。</h1><p className="muted">アカウントを接続して、投稿と数字をひとつの場所に。</p><div className="onboarding-grid"><section className="card"><span className="step-number">01</span><h2>Threadsを接続</h2><p>自分のアクセストークンを使って、投稿と分析データを取り込みます。</p><button className="btn" onClick={() => navigate("/connect")}>Threadsをつなぐ →</button></section><section className="card"><span className="step-number">02</span><h2>投稿環境を整える</h2><p>AIキー、ログイン情報、通知は設定から管理できます。</p><button className="btn btn-sub" onClick={() => navigate("/app/settings")}>設定を開く →</button></section></div></div>;
  }

  if (isError && !data) {
    const message = error instanceof ApiError ? error.message : "数字を読み込めませんでした";
    return (
      <p className="msg msg-bad" role="alert">
        {message}
      </p>
    );
  }

  return (
    <>
      <div className="page-heading"><div><p className="eyebrow">YOUR THREADS, AT A GLANCE</p><h1>アナリティクス</h1><p className="muted">@{account.username} の成長と、次の投稿のヒント。</p></div><button className="btn btn-fit" onClick={() => navigate("/app/create")}>＋ 投稿をつくる</button></div>
      <div className="dashboard-toolbar"><span className="toolbar-label"><span className="status-dot" />表示期間</span><div className="chips" role="group" aria-label="表示期間">
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
      <div className="sync-summary" role="status"><span>{sync.data?.status === "failed" ? sync.data.message : sync.data?.running ? `データを取り込み中 · ${sync.data.posts}件の投稿を保存済み。数字は順次反映します。` : sync.data?.status === "done" ? `${sync.data.posts}件の投稿を同期済み` : "接続済みです。初回のデータ同期を開始してください。"}</span><button className="btn btn-sub btn-fit" disabled={startSync.isPending} onClick={()=>startSync.mutate(undefined,{onError:e=>toast.show(e instanceof ApiError ? e.message : "同期を開始できませんでした","bad")})}>{startSync.isPending ? "同期を開始中…" : sync.data?.running ? "同期を再開" : "今すぐ同期"}</button></div>
      {isPending || !data ? (
        <p className="muted" style={{ marginTop: "calc(var(--sp) * 3)" }}>
          読み込んでいます…
        </p>
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
                明日から推移が出ます
                <br />
                （フォロワー数は接続した日から毎日ためていきます）
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
              <p className="muted">この期間のデータがまだありません</p>
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
            この期間に投稿がありません。
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
  const reduced = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const repost = useRepost(accountId);

  const metricLabel = METRICS.find((m) => m.key === metric)?.label ?? "";
  const carry = post.children[0] ? post.children[0].views / Math.max(1, post.views) : null;
  // 並べ替えに使っている指標を先頭に出し、残りから2つ添える（同じ数字を二度出さない）
  const sideMetrics = (["views", "likes", "clicks"] as const)
    .filter((k) => k !== metric)
    .slice(0, 2);

  function toCreate(mode: CreatePreset["mode"]) {
    const preset: CreatePreset = { mode, postId: post.id, text: post.text };
    setSheet(false);
    navigate("/app/create", { state: { preset } });
  }

  return (
    <article className="row">
      <div style={{ display: "flex", alignItems: "stretch" }}>
        <button
          type="button"
          className="row-main"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
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

      <AnimatePresence initial={false}>
        {open && (
          // 動かすのは transform と opacity だけ（SPEC §12.5）。高さは即座に決まる
          <motion.div
            className="row-panel"
            initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
            animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={reduced ? CROSSFADE : SPRING}
          >
            <div className="child">
              <span className="t">1投稿目</span>
              <span className="num">{fmtN(post.views)} 表示</span>
            </div>
            {post.children.map((c, i) => (
              <div className="child" key={c.id}>
                <span className="t">
                  {i + 2}投稿目: {c.text || "（本文なし）"}
                </span>
                <span className="num">{fmtN(c.views)} 表示</span>
              </div>
            ))}
            <p className="muted" style={{ marginTop: "var(--sp)" }}>
              返信 {fmtN(post.replies)} / リポスト {fmtN(post.reposts)} / 引用 {fmtN(post.quotes)} /
              クリック {fmtN(post.clicks)}
              {carry !== null && ` / 遷移率 ${pct(post.children[0]!.views, post.views)}`}
            </p>
            <div className="row-actions">
              <button type="button" className="btn btn-sub" onClick={() => toCreate("rewrite")}>
                リライト
              </button>
              <button type="button" className="btn btn-sub" onClick={() => toCreate("template")}>
                これを型にして作る
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

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
          <button
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
