import { afterEach, expect, it, vi } from "vitest";
import { clearPrivateState } from "../../web/src/lib/session-boundary";
import { selectCreateAccount, readCreateValue, writeCreateValue, createSessionEpoch } from "../../web/src/lib/create-session";

afterEach(() => { selectCreateAccount(null); vi.unstubAllGlobals(); });
it("retains edited candidates and submitted state in memory across screen readers", () => {
  const storage = vi.fn();
  vi.stubGlobal("localStorage", { setItem: storage });
  selectCreateAccount("a");
  writeCreateValue("a", "candidates", [{ key: "A", body: "edited" }, { key: "B", body: "second" }]);
  writeCreateValue("a", "submitted", { A: { id: "queue-a", status: "pending" } });
  expect(readCreateValue("a", "candidates", [])).toEqual([{ key: "A", body: "edited" }, { key: "B", body: "second" }]);
  expect(readCreateValue("a", "submitted", {})).toEqual({ A: { id: "queue-a", status: "pending" } });
  expect(storage).not.toHaveBeenCalled();
});
it("account switches clear drafts and reject a late result even after returning to the same account", () => {
  selectCreateAccount("a");
  const oldEpoch = createSessionEpoch();
  writeCreateValue("a", "draft", "private");
  selectCreateAccount("b");
  expect(readCreateValue("b", "draft", "")).toBe("");
  selectCreateAccount("a");
  writeCreateValue("a", "draft", "late result", oldEpoch);
  expect(readCreateValue("a", "draft", "")).toBe("");
});
it("logout releases previews and removes all completed draft state", () => {
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  selectCreateAccount("a");
  writeCreateValue("a", "media", [{ previewUrl: "blob:preview" }]);
  writeCreateValue("a", "instruction", "private theme");
  clearPrivateState();
  selectCreateAccount("a");
  expect(readCreateValue("a", "instruction", "")).toBe("");
  expect(revoke).toHaveBeenCalledWith("blob:preview");
  revoke.mockRestore();
});
