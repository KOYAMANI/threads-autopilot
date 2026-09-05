/**
 * ApBar（オートパイロット帯。SPEC §12.2）。
 *
 * 本来は `GET /accounts/:id/autopilot/next`（SPEC §7.7）と連動して次の自動投稿を出すが、
 * オートパイロットは M6 なのでいまはプレースホルダの文言だけを出す。
 * M6 で `next` を読んで「9/6 21:00 に出ます（警告型）／取り消す」に差し替える。
 */
import { PlaneIcon } from "./Icons";

export default function ApBar({ enabled }: { enabled: boolean }) {
  return (
    <div className="chrome apbar" role="status">
      <PlaneIcon size={14} />
      <span>
        {enabled
          ? "オートパイロットは M6 で動きます"
          : "オートパイロットはまだオフです（設定は M6）"}
      </span>
    </div>
  );
}
