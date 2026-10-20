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

## OAuth end-to-end status — passed

Staging version `dcc50818-fd87-44ec-9430-c6af7e059f78` includes the transport fix and immutable test-account pin. The browser OAuth flow for `yama_threads.sub` completed with HTTP 201. The app displayed “つながりました”, then populated the analytics page and profile avatar. The authenticated app API confirmed connection status `ok`, a long-lived token with 60 days remaining (no token value was printed), and initial sync `done`, 445 posts, no sync error. Follower count, views, likes, link clicks and top posts were visible. The initial follower history has one observation; historical follower counts are not invented.

The authenticated Threads ID is `28121200714239994`. `STAGING_THREADS_USER_ID` is pinned to it and `STAGING_THREADS_USERNAME` is blank. The app account ID is `66a7f17e-2b28-4abf-ae82-de06aab61563`. Staging external publishing/email remain disabled, and Autopilot remains off. No real post was published.

### Root cause and regression coverage

Safe diagnostics established `long_exchange / TypeError`: short-token exchange succeeded but the shared Threads transport failed before profile retrieval. Its `redirect: "error"` option is not accepted by the deployed workerd runtime. Changed to `manual` and explicitly reject all 3xx responses without following Location, forwarding credentials, or exposing response bodies. Existing endpoint hosts and scope requirements were not guessed or changed. Successful real OAuth and data sync after this change confirm the fix.

Google transport used the same unsupported option, so the current source and staging were corrected too. Google is still unconfigured and no real Google OAuth or Sheets synchronization was tested. The 41 related tests include actual Workers `Request` initialization before mocked Google transport, native request validation for Threads, and no-follow behavior for hostile redirects. Full project typecheck passed. Prior fake-fetch-only tests accepted options the runtime rejected.

The production bundle was read directly rather than assuming a git checkpoint matched it: its Threads function uses `fetch(url2, { method })`, and the only `redirect: "error"` occurrence is in `googleRequest`. Thus production Threads does not need this particular fix. The inactive production Google path retains that issue until a future production release of the source fix. The production app bundle was not redeployed during this fix; unrelated auth/scheduling changes and migrations remain outside this rollout.

The diagnostic logger retains only fixed stage/class labels and numeric provider/budget metadata; never error text, stack, raw provider bodies, credential URLs, app secrets, OAuth codes or state.

### Remaining verification boundaries

- Initial synchronization is verified. Future scheduled synchronization and automatic token refresh have not been proven by observed Cron execution; do not equate the 60-day expiry confirmation with a successful future refresh.
- The Meta app remains in development/test mode; general user access still requires the appropriate Meta publication/review steps.
- Actual Meta-signed uninstall/deletion delivery is not yet exercised; local signature/deletion tests and deployed unsigned rejection passed, as described above.

## Reference investigation

Typefully's public agent-skills repository is a client for Typefully's own API, not its Meta OAuth backend. Its mini-typefully repository is an interview exercise. We did not find a public Typefully lifecycle-callback implementation or Meta form-save workaround. Meta's own sample confirms use of the separate Threads App ID/Secret and HTTPS redirect registration: https://github.com/fbsamples/threads_api .
