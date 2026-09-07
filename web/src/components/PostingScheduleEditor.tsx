import { useEffect, useState } from "react";
import { usePostingSchedule, usePutPostingSchedule } from "../api/queue";
import { ApiError } from "../api/client";
import { useToast } from "./Toast";

/** 枠の変更は未来の新規予約にだけ適用する。予約済みの時刻は動かさない。 */
export default function PostingScheduleEditor({ accountId }: { accountId: string }) {
  const schedule = usePostingSchedule(accountId);
  const save = usePutPostingSchedule(accountId);
  const toast = useToast();
  const [times, setTimes] = useState<string[]>([]);
  const savedTimes = schedule.data?.times.join(",");
  useEffect(() => { if (savedTimes !== undefined) setTimes(savedTimes ? savedTimes.split(",") : []); }, [savedTimes, accountId]);

  const sorted = [...times].sort();
  const dirty = sorted.join(",") !== savedTimes;
  const invalid = times.some(t => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t));
  const duplicate = new Set(times).size !== times.length;
  const issue = invalid ? "すべての枠に時刻を入力してください。" : duplicate ? "同じ時刻は1つだけ登録できます。" : null;

  function add() {
    // 既存の枠を保ち、空いている時刻を1つ追加する。
    const suggested = ["09:00", "12:00", "18:00", "21:00", "15:00", "10:00", "13:00", "16:00", "19:00", "22:00"];
    setTimes(current => [...current, suggested.find(t => !current.includes(t)) ?? "08:00"]);
  }

  if (schedule.isPending) return <p className="muted">投稿スロットを読み込んでいます…</p>;
  if (schedule.isError) return <p className="msg msg-bad" role="alert">{schedule.error instanceof ApiError ? schedule.error.message : "設定を読み込めませんでした"}</p>;

  return <div className="posting-schedule-editor">
    <p className="muted">毎日使う投稿時刻を、1〜10個設定できます。時刻は {schedule.data?.timezone} です。</p>
    <div className="slot-time-inputs">
      {times.map((time, i) => <div className="slot-time-input" key={i}>
        <label><span className="muted">枠 {i + 1}</span><input type="time" className="input num" step={60} aria-label={`投稿枠${i + 1}の時刻`} value={time} disabled={save.isPending} onChange={e => setTimes(current => current.map((t, index) => index === i ? e.target.value : t))} /></label>
        <button type="button" className="icon-btn" aria-label={`投稿枠${i + 1}を削除`} title={times.length <= 1 ? "投稿スロットは1個以上必要です" : "この時刻を削除"} disabled={save.isPending || times.length <= 1} onClick={() => setTimes(current => current.filter((_, index) => index !== i))}>×</button>
      </div>)}
      {times.length < 10 && <button type="button" className="slot-add-time" disabled={save.isPending} onClick={add}>＋ 時刻を追加</button>}
    </div>
    {times.length === 1 && <p className="muted section">投稿スロットは1個以上必要です。最後の1個は削除できません。</p>}
    {issue && <p className="msg msg-bad" role="alert">{issue}</p>}
    <div className="schedule-save-row"><span className="muted">{times.length} / 10 枠</span><button type="button" className="btn btn-fit" disabled={!dirty || Boolean(issue) || save.isPending} onClick={() => save.mutate({ times: sorted }, {
      onSuccess: () => toast.show("投稿スロットを保存しました", "ok"),
      onError: error => toast.show(error instanceof ApiError ? error.message : "保存できませんでした", "bad"),
    })}>{save.isPending ? "保存しています…" : "スロットを保存"}</button></div>
    <p className="muted section">保存しても、予約済みの投稿は移動しません。オートパイロットはこの枠から毎日最大3本分を使います。</p>
  </div>;
}
