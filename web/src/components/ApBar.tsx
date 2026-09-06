/**
 * ApBar（オートパイロット帯。SPEC §12.2 / §7.7）。
 *
 * `GET /accounts/:id/autopilot/next` の1行をそのまま出す。文言はサーバー側で作る
 * （「次は 9/7 21:00。17:00 まで取り消せます」）— アカウントの timezone で組み立てる
 * 必要があり、端末の時計で作ると海外から触ったときにずれるため（SPEC §2.4）。
 *
 * 押すとオートパイロットの画面へ行く。帯そのものは操作しない。
 */
import { useNavigate } from "react-router-dom";
import { useApNext } from "../api/autopilot";
import { PlaneIcon } from "./Icons";

export default function ApBar({
  accountId,
  enabled,
}: {
  accountId: string | null;
  enabled: boolean;
}) {
  const navigate = useNavigate();
  const next = useApNext(accountId);

  // 読み込み中は、アカウント一覧が持っている enabled だけで暫定の文言を出す。
  // 空欄にすると帯の高さが変わって画面が跳ねる
  const text = next.data?.summary ?? (enabled ? "次の下書きを確かめています" : "オートパイロットはオフです");

  return (
    <button
      type="button"
      className="chrome apbar"
      onClick={() => navigate("/app/autopilot")}
      aria-label={`オートパイロット: ${text}`}
    >
      <PlaneIcon size={14} />
      <span>{text}</span>
    </button>
  );
}
