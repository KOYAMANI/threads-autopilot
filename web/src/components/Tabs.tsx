/**
 * 下部5タブ（SPEC §12.1 / design-v0.2 §3-2）。
 * ラベルは中身の名前にする（apple-design §16「Direct, specific labels」）。
 */
import { useLocation, useNavigate } from "react-router-dom";
import { GearIcon, HomeIcon, PenIcon, PlaneIcon, StackIcon } from "./Icons";

export const TABS = [
  { path: "/app/home", label: "ホーム", Icon: HomeIcon },
  { path: "/app/create", label: "作る", Icon: PenIcon },
  { path: "/app/queue", label: "キュー", Icon: StackIcon },
  { path: "/app/autopilot", label: "オートパイロット", Icon: PlaneIcon },
  { path: "/app/settings", label: "設定", Icon: GearIcon },
] as const;

export default function Tabs() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <nav className="chrome tabs" aria-label="画面の切り替え">
      {TABS.map(({ path, label, Icon }) => {
        const current = pathname === path || pathname.startsWith(`${path}/`);
        return (
          <button
            key={path}
            type="button"
            className="tab"
            aria-current={current ? "page" : undefined}
            onClick={() => navigate(path)}
          >
            <Icon size={20} />
            <span>{label === "オートパイロット" ? "自動" : label}</span>
          </button>
        );
      })}
    </nav>
  );
}
