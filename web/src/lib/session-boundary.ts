let epoch = 0;
const pending = new Set<AbortController>();
export function beginRequest() {
  const controller = new AbortController();
  pending.add(controller);
  const started = epoch;
  return {
    controller,
    current: () => started === epoch,
    finish: () => pending.delete(controller),
  };
}
export function clearPrivateState() {
  epoch++;
  for (const controller of pending) controller.abort();
  pending.clear();
  // Best-effort removal of already displayed notifications; server session revocation is authoritative.
  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    void navigator.serviceWorker.getRegistrations().then(async registrations => {
      for (const registration of registrations) {
        for (const notification of await registration.getNotifications()) notification.close();
      }
    }).catch(() => {});
  }
  try {
    localStorage.removeItem("aiKey");
    localStorage.removeItem("activeAccountId");
  } catch {
    /* unavailable */
  }
}
export function announceSessionChange() {
  try {
    localStorage.setItem("tap:session-change", crypto.randomUUID());
  } catch {
    /* unavailable */
  }
}
export function installSessionBoundary(clearCache: () => void) {
  // Legacy local keys have no reliable owner. Never silently upload one to the current user.
  try {
    if (localStorage.getItem("aiKey"))
      sessionStorage.setItem("tap:legacy-key-removed", "1");
    localStorage.removeItem("aiKey");
  } catch {
    /* unavailable */
  }
  const reset = () => {
    clearPrivateState();
    clearCache();
    window.location.replace("/login");
  };
  window.addEventListener("storage", (e) => {
    if (e.key === "tap:session-change") reset();
  });
  window.addEventListener("tap:unauthorized", reset);
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      clearPrivateState();
      clearCache();
      window.location.reload();
    }
  });
}
