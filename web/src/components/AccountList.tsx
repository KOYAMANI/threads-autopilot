/**
 * ドロワーのアカウント一覧。行の右端のつまみを持って上下にドラッグすると並びを変えられる。
 *
 * - 行を押したときはこれまでどおりアカウントの切り替え。つまみだけがドラッグの入口なので、
 *   ドロワーを閉じる左右のスワイプともぶつからない（つまみの pointerdown をドロワーへ渡さない）
 * - 指を離した時点で保存する。保存に失敗したら元の順に戻す（useReorderAccounts）
 * - つまみにフォーカスして上下の矢印キーでも動かせる。動かした結果は読み上げる
 * - 動きは motion の Reorder（transform のレイアウトアニメーション）。reduced-motion では動かさない
 */
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { Reorder, useDragControls } from "motion/react";
import type { AccountSummary } from "@tap/shared";
import { useReorderAccounts } from "../api/accounts";
import { ApiError } from "../api/client";
import AccountAvatar from "./AccountAvatar";
import { GripIcon } from "./Icons";
import { useToast } from "./Toast";
import { SPRING, useReducedMotion } from "../lib/motion";

const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

export default function AccountList({
  accounts,
  activeId,
  onSelect,
}: {
  accounts: AccountSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const reorder = useReorderAccounts();
  const toast = useToast();
  const serverOrder = accounts.map((a) => a.id);
  const [order, setOrder] = useState(serverOrder);
  const orderRef = useRef(order);
  orderRef.current = order;
  const dragging = useRef(false);
  const [announce, setAnnounce] = useState("");

  // ドラッグ中でなければ、サーバーの一覧（接続・削除・ほかの端末での並べ替え）に合わせる
  const serverKey = serverOrder.join(",");
  useEffect(() => {
    if (!dragging.current) setOrder(serverKey ? serverKey.split(",") : []);
  }, [serverKey]);

  const byId = new Map(accounts.map((a) => [a.id, a]));
  const items = order.filter((id) => byId.has(id));
  const movable = items.length > 1;

  function save(next: string[]) {
    if (sameOrder(next, serverOrder)) return;
    reorder.mutate(next, {
      onError: (e) => {
        setOrder(serverOrder);
        toast.show(e instanceof ApiError ? e.message : "並び順を保存できませんでした", "bad");
      },
    });
  }

  function moveBy(id: string, delta: number) {
    const from = items.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= items.length) return;
    const next = [...items];
    next.splice(to, 0, ...next.splice(from, 1));
    setOrder(next);
    setAnnounce(`@${byId.get(id)?.username} を${to + 1}番目に移動しました`);
    save(next);
  }

  return (
    <>
      <Reorder.Group as="ul" axis="y" values={items} onReorder={setOrder} className="account-list">
        {items.map((id) => (
          <AccountRow
            key={id}
            account={byId.get(id)!}
            active={id === activeId}
            movable={movable}
            onSelect={() => onSelect(id)}
            onDragStart={() => {
              dragging.current = true;
            }}
            onDragEnd={() => {
              dragging.current = false;
              save(orderRef.current.filter((x) => byId.has(x)));
            }}
            onKeyMove={(delta) => moveBy(id, delta)}
          />
        ))}
      </Reorder.Group>
      <p className="visually-hidden" aria-live="polite">
        {announce}
      </p>
    </>
  );
}

function AccountRow({
  account,
  active,
  movable,
  onSelect,
  onDragStart,
  onDragEnd,
  onKeyMove,
}: {
  account: AccountSummary;
  active: boolean;
  movable: boolean;
  onSelect: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onKeyMove: (delta: number) => void;
}) {
  const controls = useDragControls();
  const reduced = useReducedMotion();

  function startDrag(e: PointerEvent<HTMLButtonElement>) {
    // ドロワー自体の横スワイプ（Drawer の drag="x"）に拾わせない
    e.stopPropagation();
    e.preventDefault();
    controls.start(e);
  }

  function onKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      onKeyMove(e.key === "ArrowUp" ? -1 : 1);
    }
  }

  return (
    <Reorder.Item
      as="li"
      value={account.id}
      className="account-row"
      dragListener={false}
      dragControls={controls}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      transition={reduced ? { duration: 0 } : SPRING}
      whileDrag={reduced ? undefined : { scale: 1.02 }}
    >
      <button type="button" className="menu-item" aria-current={active} onClick={onSelect}>
        <AccountAvatar account={account} />
        <span style={{ minWidth: 0, flex: "1 1 auto" }}>
          <span style={{ display: "block", fontSize: "0.8125rem", fontWeight: 600 }}>@{account.username}</span>
          <span className="muted" style={{ fontSize: "0.6875rem" }}>
            {account.status === "needs_reauth" ? "要再接続" : (account.name ?? "　")}
          </span>
        </span>
      </button>
      {movable && (
        <button
          type="button"
          className="drag-handle"
          aria-label={`@${account.username} の並び順を変える（上下の矢印キーでも動かせます）`}
          onPointerDown={startDrag}
          onKeyDown={onKey}
        >
          <GripIcon size={18} />
        </button>
      )}
    </Reorder.Item>
  );
}
