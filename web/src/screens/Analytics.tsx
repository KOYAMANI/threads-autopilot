import FollowerChart from "../components/FollowerChart";
import PostReadSheet from "../components/PostReadSheet";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ClickSyncStatus, DashboardPeriod, DashboardResponse, PostSummary } from "@tap/shared";
import { useDashboard, useStartSync, useSyncStatus } from "../api/accounts";
import { useShell } from "../components/Shell";
import { useToast } from "../components/Toast";
import { ApiError } from "../api/client";
import { fmtN, signed } from "../lib/format";
import type { CreatePreset } from "./Home";

type Metric = "followers" | "views" | "likes";
type RankingMetric = "views" | "likes";
const PERIODS: Array<{ value: DashboardPeriod; label: string }> = [{ value: "all", label: "全期間" }, { value: 7, label: "7日" }, { value: 30, label: "30日" }, { value: 90, label: "90日" }];
const METRICS: Array<{ key: Metric; label: string }> = [{ key: "followers", label: "フォロワー" }, { key: "views", label: "表示" }, { key: "likes", label: "いいね" }];

type ChartPoint = { label: string; value: number };

function toTwelveWeeks(points: ChartPoint[], mode: "last" | "sum"): ChartPoint[] {
  if (points.length <= 12) return points;
  return Array.from({ length: 12 }, (_, index) => {
    const start = Math.floor(index * points.length / 12);
    const end = Math.floor((index + 1) * points.length / 12);
    const group = points.slice(start, Math.max(start + 1, end));
    return {
      label: group[0]?.label ?? "",
      value: mode === "last" ? group.at(-1)?.value ?? 0 : group.reduce((sum, point) => sum + point.value, 0),
    };
  });
}

function PeriodControl({ period, onChange, className = "" }: { period: DashboardPeriod; onChange: (period: DashboardPeriod) => void; className?: string }) {
  return <div className={`analytics-period ${className}`} role="group" aria-label="表示期間">{PERIODS.map(item => <button type="button" aria-pressed={period === item.value} key={item.value} onClick={() => onChange(item.value)}>{item.label}</button>)}</div>;
}

export default function Analytics() {
  const { account } = useShell();
  const navigate = useNavigate();
  const toast = useToast();
  const [period, setPeriod] = useState<DashboardPeriod>("all");
  const [metric, setMetric] = useState<Metric>("followers");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const dashboard = useDashboard(account?.id ?? null, period);
  const sync = useSyncStatus(account?.id ?? null);
  const startSync = useStartSync(account?.id ?? null);
  const data = dashboard.data;
  const clickStatus = sync.data?.clicks ?? null;

  useEffect(() => setSelectedIndex(null), [metric, period]);
  const refreshedClickSnapshot = useRef<string | null>(null);
  useEffect(() => {
    const snapshot = clickStatus?.state === "ready" ? clickStatus.lastSyncedAt : null;
    if (!snapshot || refreshedClickSnapshot.current === snapshot) return;
    refreshedClickSnapshot.current = snapshot;
    void dashboard.refetch();
  }, [clickStatus?.state, clickStatus?.lastSyncedAt, dashboard.refetch]);
  if (!account) return <p className="muted">アカウントを接続してください。</p>;
  if (dashboard.isError && !data) return <p className="msg msg-bad">{dashboard.error instanceof ApiError ? dashboard.error.message : "分析を読み込めませんでした"}</p>;
  const hero = !data ? 0 : metric === "followers" ? data.followers.current : metric === "views" ? data.views.total : data.likes;
  const delta = metric === "followers" ? data?.followers.delta ?? 0 : null;

  return <div className="analytics-page">
    <div className="analytics-heading"><div><p className="eyebrow">ANALYTICS</p><h1>分析</h1><p className="muted">@{account.username}</p></div><div className="analytics-heading-actions"><PeriodControl period={period} onChange={setPeriod} className="analytics-period-desktop" /><div className="analytics-sync"><span className="num">同期 {sync.data?.lastSyncedAt ? new Date(sync.data.lastSyncedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "未同期"}</span><button type="button" className="btn btn-sub btn-fit" disabled={startSync.isPending} onClick={() => startSync.mutate(undefined, { onError: error => toast.show(error instanceof ApiError ? error.message : "同期できませんでした", "bad") })}>今すぐ同期</button></div></div></div>
    {dashboard.isPending || !data ? <p className="muted section">数字を読み込んでいます…</p> : <AnalyticsLoaded key={account.id} data={data} clickStatus={clickStatus} timezone={account.timezone} period={period} metric={metric} hero={hero} delta={delta} selectedIndex={selectedIndex} onPeriod={setPeriod} onMetric={setMetric} onSelected={setSelectedIndex} onCreate={(post) => { const preset: CreatePreset = { mode: "template", postId: post.id, text: post.text }; navigate("/app/create", { state: { preset } }); }} onLinks={() => navigate("/app/settings?tab=links")} />}
  </div>;
}

function AnalyticsLoaded({ data, clickStatus, timezone, period, metric, hero, delta, selectedIndex, onPeriod, onMetric, onSelected, onCreate, onLinks }: { data: DashboardResponse; clickStatus: ClickSyncStatus | null; timezone: string; period: DashboardPeriod; metric: Metric; hero: number; delta: number | null; selectedIndex: number | null; onPeriod: (period: DashboardPeriod) => void; onMetric: (metric: Metric) => void; onSelected: (index: number | null) => void; onCreate: (post: PostSummary) => void; onLinks: () => void }) {
  const [reading, setReading] = useState<PostSummary | null>(null);
  const [rankingMetric, setRankingMetric] = useState<RankingMetric>("views");
  const clicksReady = clickStatus?.state === "ready";
  const followerCount = data.followers.series.length;
  const followerNote = metric !== "followers" ? null : followerCount === 0 ? "フォロワーの記録はまだありません。同期すると記録を開始します。" : followerCount === 1 ? `記録開始：${data.followers.series[0]!.date}。まだ1日分のため、次回以降の別の日の記録で推移を表示します。` : `記録期間：${data.followers.series[0]!.date}〜${data.followers.series.at(-1)!.date}（${followerCount}日分）。接続前の履歴は含みません。`;
  const previous = useRef(hero);
  const [shown, setShown] = useState(hero);
  useEffect(() => {
    const from = previous.current; previous.current = hero;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setShown(hero); return; }
    let raf = 0; const start = performance.now();
    const tick = (now: number) => { const k = Math.min(1, (now - start) / 620); setShown(Math.round(from + (hero - from) * (1 - Math.pow(1-k,3)))); if (k < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick); return () => cancelAnimationFrame(raf);
  }, [hero]);

  const series = useMemo(() => {
    if (metric === "followers") {
      const points = data.followers.series.map(point => ({ label: point.date.slice(5).replace("-", "/"), value: point.n }));
      return data.period === 90 ? toTwelveWeeks(points, "last") : points;
    }
    if (metric === "views") {
      const points = data.views.series.map(point => ({ label: point.date.slice(5).replace("-", "/"), value: point.v }));
      return data.period === 90 ? toTwelveWeeks(points, "sum") : points;
    }
    const grouped = new Map<string, number>();
    for (const post of data.posts) { const day = post.postedAt.slice(0,10); grouped.set(day, (grouped.get(day) ?? 0) + post.likes); }
    const points = [...grouped].sort(([a],[b]) => a.localeCompare(b)).map(([day,value]) => ({ label: day.slice(5).replace("-", "/"), value }));
    return data.period === 90 ? toTwelveWeeks(points, "sum") : points;
  }, [data, metric]);
  const max = Math.max(1, ...series.map(point => point.value));
  const [rankingLimit, setRankingLimit] = useState(10);
  useEffect(() => setRankingLimit(10), [data.period, rankingMetric]);
  const sortedPosts = [...data.posts].sort((a,b) => b[rankingMetric] - a[rankingMetric]);
  const posts = sortedPosts.slice(0, rankingLimit);
  const maxPost = Math.max(1, ...posts.map(post => post[rankingMetric]));
  const maxLink = Math.max(1, ...data.links.map(link => link.clicks));
  const selected = selectedIndex === null ? null : series[selectedIndex];
  const timeBuckets = useMemo(() => {
    const buckets = [
      { label: "朝", total: 0, count: 0 },
      { label: "昼", total: 0, count: 0 },
      { label: "夕", total: 0, count: 0 },
      { label: "夜", total: 0, count: 0 },
    ];
    for (const post of data.posts) {
      const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(new Date(post.postedAt)));
      const index = hour >= 5 && hour < 11 ? 0 : hour >= 11 && hour < 16 ? 1 : hour >= 16 && hour < 21 ? 2 : 3;
      buckets[index]!.total += post.views;
      buckets[index]!.count += 1;
    }
    return buckets.map(bucket => ({ ...bucket, average: bucket.count ? Math.round(bucket.total / bucket.count) : 0 }));
  }, [data.posts, timezone]);
  const maxTime = Math.max(1, ...timeBuckets.map(bucket => bucket.average));
  const bestTime = timeBuckets.reduce((best, bucket) => bucket.average > best.average ? bucket : best, timeBuckets[0]!);

  return <>
    <section className="analytics-main-card">
      <div className="analytics-hero"><div><span>{METRICS.find(item => item.key === metric)?.label}（{data.period === "all" ? "全期間" : `${data.period}日`}）</span><strong className="num">{fmtN(shown)}</strong>{delta !== null && followerCount >= 2 && <small className={`num${delta < 0 ? " is-down" : ""}`}>{signed(delta)}人 / 最初の記録から</small>}</div><div className="metric-pills" role="group" aria-label="指標">{METRICS.map(item => <button type="button" key={item.key} aria-pressed={metric === item.key} onClick={() => onMetric(item.key)}>{item.label}</button>)}</div></div>
      {followerNote && <p className="follower-record-note">{followerNote}</p>}
      {metric === "followers" ? <FollowerChart key={`${data.period}-${data.followers.series.length}`} points={data.followers.series} /> : <>
      <div className="chart-readout num">{selected ? `${selected.label} ・ ${fmtN(selected.value)} ${METRICS.find(item => item.key === metric)?.label}` : series.length ? "棒を選ぶと、記録した日の数字を表示します" : ""}</div>
      {series.length ? <div className="tap-bar-chart">{series.map((point,index) => <button type="button" key={`${point.label}-${index}`} className={selectedIndex === index ? "is-selected" : ""} onClick={() => onSelected(selectedIndex === index ? null : index)} aria-label={`${point.label} ${fmtN(point.value)}`}><span style={{ height: `${Math.max(4, point.value / max * 100)}%`, animationDelay: `${index * 22}ms` }} /><small>{series.length <= 7 || index % Math.ceil(series.length / 7) === 0 ? point.label : ""}</small></button>)}</div> : <div className="analytics-empty">この期間のデータがまだありません。</div>}
      </>}
      <PeriodControl period={period} onChange={onPeriod} className="analytics-period-mobile" />
    </section>
    <section className="analytics-side-kpis"><Kpi label="表示" value={data.views.total} note={`1日平均 ${fmtN(data.views.total / Math.max(1,data.views.series.length))}`} /><Kpi label="いいね" value={data.likes} note="期間内の合計" /></section>
    <section className="analytics-ranking">
      <div className="section-head"><h2>伸びた投稿 <span>上位10件</span></h2><label className="ranking-sort"><span>並べ替え</span><select value={rankingMetric} onChange={event => setRankingMetric(event.target.value as RankingMetric)}><option value="views">表示</option><option value="likes">いいね</option></select></label></div>
      {posts.length ? <>
        <div className="ranking-table-head desktop-only"><span>#</span><span>本文</span><span>表示</span><span>いいね</span><span>操作</span></div>
        <div className="ranking-list">{posts.map((post,index) => <div className="ranking-row" key={post.id} style={{ animationDelay: `${index*45}ms` }}>
          <span className="rank num">{index+1}</span><div className="rank-content"><button type="button" className="rank-read" onClick={() => setReading(post)}><p>{post.text}</p><span className="post-read-link">全文を読む →</span></button><span className="rank-bar"><i style={{ width: `${post[rankingMetric] / maxPost * 100}%`, animationDelay: `${index*60}ms` }} /></span><span className="rank-mobile-stats num">{fmtN(post.views)} 表示 ・ {fmtN(post.likes)} いいね</span></div>
          <span className="rank-stats num">{fmtN(post.views)}<small>表示</small></span><span className="rank-stats num">{fmtN(post.likes)}<small>いいね</small></span><button type="button" className="btn btn-sub btn-fit rank-create" onClick={() => onCreate(post)}>参考に作る</button>
        </div>)}</div>
        {sortedPosts.length > 10 && <button type="button" className="btn-quiet mobile-ranking-more" onClick={() => setRankingLimit(limit => limit === 10 ? Math.min(20, sortedPosts.length) : 10)}>{rankingLimit === 10 ? "11〜20件目を見る" : "上位10件に戻す"}</button>}
      </> : <p className="muted section">この期間に投稿がありません。</p>}
    </section>
    <PostReadSheet post={reading} onClose={() => setReading(null)} />
    <aside className="analytics-insights"><div className="section-head"><h2>リンク別クリック</h2><button className="btn-quiet" onClick={onLinks}>リンクを編集</button></div>{!clicksReady ? <ClickSyncNotice status={clickStatus} compact /> : data.links.length ? data.links.slice(0,6).map(link => <div className="link-rank" key={link.url}><span>{link.label}</span><b className="num">{fmtN(link.clicks)}</b><i><span style={{width:`${link.clicks/maxLink*100}%`}} /></i></div>) : <p className="muted section">取得済みです。クリックのあるリンクはまだありません。</p>}<hr/><h2>時間帯別の結果</h2>{data.posts.length ? <><div className="time-bucket-chart" aria-label="時間帯別の1投稿平均表示数">{timeBuckets.map(bucket => <div key={bucket.label}><span><i style={{height:`${Math.max(bucket.average ? 8 : 0,bucket.average/maxTime*100)}%`}} /></span><b className="num">{fmtN(bucket.average)}</b><small>{bucket.label}</small></div>)}</div><p className="muted time-insight">この期間は「{bestTime.label}」が1投稿あたり最も多く表示されています。</p></> : <p className="muted section">投稿が増えると、反応の良い時間帯がここに表示されます。</p>}</aside>
  </>;
}

function ClickSyncNotice({ status, compact = false }: { status: ClickSyncStatus | null; compact?: boolean }) {
  const title = !status ? "クリックの状態を確認中" : status.state === "syncing" ? "クリックを同期中" : status.state === "failed" ? "クリックを取得できませんでした" : "クリックは未取得です";
  const message = status?.message ?? "取得状態を確認しています。数字が確定するまで少しお待ちください。";
  return <div className={`click-sync-notice is-${status?.state ?? "loading"}${compact ? " is-compact" : ""}`}><strong>{title}</strong><p>{message}</p></div>;
}

function Kpi({ label, value, note }: { label: string; value: number | string; note: string }) { return <div><span>{label}</span><strong className="num">{typeof value === "number" ? fmtN(value) : value}</strong><small>{note}</small></div>; }
