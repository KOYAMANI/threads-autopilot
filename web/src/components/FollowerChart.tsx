import { useState } from "react";
import { fmtN, signed } from "../lib/format";

type Point = { date: string; n: number };
export default function FollowerChart({ points }: { points: Point[] }) {
  const [selected, setSelected] = useState<number | null>(null);
  if (points.length < 2) return null;
  const start = Date.parse(points[0]!.date), end = Date.parse(points.at(-1)!.date);
  const values = points.map(p => p.n), low = Math.min(...values), high = Math.max(...values);
  const pad = Math.max(1, Math.ceil((high - low) * .15));
  const floor = Math.max(0, low - pad), ceiling = high + pad;
  const x = (p: Point) => 52 + (Date.parse(p.date) - start) / Math.max(1, end - start) * 616;
  const y = (p: Point) => 162 - (p.n - floor) / Math.max(1, ceiling - floor) * 142;
  const index = selected !== null && points[selected] ? selected : points.length - 1;
  const p = points[index]!;
  const previous = points[index - 1];
  const description = (i: number) => `${points[i]!.date}：${fmtN(points[i]!.n)}人${i ? `、前回記録から${signed(points[i]!.n - points[i-1]!.n)}人` : "、最初の記録"}`;
  return <div className="follower-chart">
    <p className="follower-chart-readout" aria-live="polite">{p.date} · <strong>{fmtN(p.n)}人</strong> · {previous ? `前回記録（${previous.date}）から ${signed(p.n - previous.n)}人` : "最初の記録"}</p>
    <svg viewBox="0 0 700 204" role="group" aria-label="フォロワー数の推移。各記録を選ぶと人数と増減を確認できます" onPointerMove={event => {const rect=event.currentTarget.getBoundingClientRect();const px=(event.clientX-rect.left)/rect.width*700;let closest=0;points.forEach((point,i)=>{if(Math.abs(x(point)-px)<Math.abs(x(points[closest]!)-px))closest=i;});setSelected(closest);}}>
      {[floor, Math.round((floor+ceiling)/2), ceiling].map((n,i) => {const py=162-(n-floor)/(ceiling-floor)*142;return <g key={i}><line x1="52" x2="668" y1={py} y2={py} className="follower-grid"/><text x="44" y={py+4} textAnchor="end">{fmtN(n)}</text></g>;})}
      <polyline points={points.map(point => `${x(point)},${y(point)}`).join(" ")} fill="none" className="follower-line" />
      {points.map((point,i) => <circle key={point.date} cx={x(point)} cy={y(point)} r={i===index ? 5 : 3} tabIndex={0} role="button" aria-label={description(i)} className="follower-point" onFocus={()=>setSelected(i)} onClick={()=>setSelected(i)} onKeyDown={e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();const next=Math.max(0,Math.min(points.length-1,i+(e.key==='ArrowRight'?1:-1)));(e.currentTarget.parentElement?.querySelectorAll<SVGCircleElement>('circle')[next])?.focus();}if(e.key==='Enter'||e.key===' '){e.preventDefault();setSelected(i);}}}><title>{description(i)}</title></circle>)}
      <text x="52" y="192" textAnchor="start">{points[0]!.date}</text><text x="668" y="192" textAnchor="end">{points.at(-1)!.date}</text>
    </svg>
    <p className="muted">点を選ぶと人数と増減を表示します。記録のない日は補完していません。</p>
  </div>;
}
