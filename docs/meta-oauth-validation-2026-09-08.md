# Meta OAuth validation — 2026-09-08 JST

## Resolved: Meta settings did not save

The app is Meta app `1584346690092191`, Threads client ID `924086796982144`. The Threads app is still in development/test mode.

The form previously returned a generic save error with the two OAuth redirect URLs entered and the uninstall/delete fields empty. After implementing and entering the two real lifecycle callback URLs below, Save completed without that error. Reloading the Meta settings page confirmed that all four values persisted.

- Production redirect: https://threads-autopilot.yama-threads-apps.workers.dev/api/threads/oauth/callback
- Staging redirect: https://threads-autopilot-staging.yama-threads-apps.workers.dev/api/threads/oauth/callback
- Uninstall callback: https://threads-autopilot-meta-callbacks.yama-threads-apps.workers.dev/deauthorize
- Delete callback: https://threads-autopilot-meta-callbacks.yama-threads-apps.workers.dev/data-deletion

This is evidence of the actual successful configuration, not a claim that every Meta save error has the same cause. The earlier HTTP 404 alone was not enough to diagnose a Meta outage.

## Deployed lifecycle service

Dedicated Worker version: `a857aa1c-6a25-4267-895a-c9785652882c` (100%). The Threads App Secret is a Cloudflare Worker secret; it is not in the repository or a local settings file.

The additive guard SQL `ops/meta-callback-guards.sql` has SHA256 `405835bc1991e89bcdc47b1af4136294726b94a1696861d1ef1a919706bdb1a0`. It was applied first to staging and then production. Production's unrelated pending app migrations were not applied, and the production app bundle was not changed. Both DBs were backed up privately and restore-checked first. Guard setup was rehearsed twice against both restored copies; counts, integrity, and ordinary updates passed.

Validation: 14 callback tests; 55 tests including related account, maintenance, queue and OAuth suites; full project typecheck including the standalone callback Worker. Public GET returns 200, malformed unsigned POST returns 400, and invalid deletion receipt returns 404 with no-store. A Python urllib client received an edge 403; Node fetch reached the Worker and passed these checks. Actual delivery of a signed lifecycle event from Meta is still unverified; see `meta-callbacks.md` for the issued_at compatibility gate and deletion/backup boundaries.

## OAuth end-to-end status

The staging button now reaches Meta's consent screen for `yama_threads.sub`; the previous redirect whitelist error is gone. Consent redirects back to the staging callback (HTTP 200). The subsequent app `/api/threads/oauth/complete` request currently returns 502; no staging account has been saved. Investigation is ongoing. Do not claim connection, synchronization, or token renewal has passed yet.

The staging-only username bootstrap remains in place until a successful connection supplies the immutable Threads user ID. Then pin the numeric ID and remove the username fallback.

## Reference investigation

Typefully's public agent-skills repository is a client for Typefully's own API, not its Meta OAuth backend. Its mini-typefully repository is an interview exercise. We did not find a public Typefully lifecycle-callback implementation or Meta form-save workaround. Meta's own sample confirms use of the separate Threads App ID/Secret and HTTPS redirect registration: https://github.com/fbsamples/threads_api .
