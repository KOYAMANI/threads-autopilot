# Meta privacy callbacks

This is a dedicated Worker (`callbacks/src/index.ts`, `wrangler.callbacks.toml`). It accepts Meta privacy requests for the one Threads app shared by production and staging, without releasing the staging application's unrelated changes to production.

## Endpoints and trust boundary

- `POST /deauthorize`: verifies the Meta signature, clears matching account tokens, marks them `needs_reauth`, switches Autopilot off, cancels pending/scheduled/publishing queue rows and removes account jobs. It retains existing analytics and drafts for an explicit reconnection.
- `POST /data-deletion`: verifies the signature and deletes the eligible accounts and their account-owned app data in both active D1 databases. Only after both database transactions complete does it return `{ url, confirmation_code }`.
- `GET /deletion-status?code=...`: verifies an opaque completion receipt and displays a static completion page. No user ID, account name, token, app session or request payload is encoded in this receipt. The receipt uses a domain-separated HMAC with the app secret and the SHA-256 fingerprint of the signed request; identical retries return the same receipt. Secret rotation invalidates old receipt URLs.
- `GET`/`HEAD` of the two callback URLs is an informational, non-mutating reachability response. Opening a URL never deletes or revokes anything.

The only credential is `THREADS_APP_SECRET`. Bind exactly `DB_PRODUCTION`, `DB_STAGING` and the fixed HTTPS `CALLBACK_ORIGIN`. There is no app encryption key, admin session, provider access token or posting client in this Worker. The response URL uses the configured origin, never an untrusted incoming Host header. Responses are not cacheable. Request bodies are capped at 16 KiB and signatures/payloads are never logged.

Accepted POST bodies are form encoded with exactly one `signed_request`. Validation checks HMAC-SHA256 over the original encoded payload with a constant-time byte comparison, exact `algorithm: "HMAC-SHA256"`, numeric-string `user_id`, and integer positive `issued_at` no more than five minutes in the future. Authentication completes before any DB operation. Invalid input returns 400 without side effects.

**Provider compatibility gate:** this implementation requires `issued_at` to order revocation against a subsequent authorization. We have not established that Meta promises this field on every Threads privacy callback. A signed notification without it deliberately returns 400; it must be investigated and given a safe ordering design, not silently assigned the receipt time. An actual Meta callback must still be checked before claiming end-to-end provider verification. Old correctly signed requests have no age expiry, because delayed provider retries must be safe and functional.

## Grant ordering and the additive DB guards

Apply `ops/meta-callback-guards.sql` explicitly to **both** databases before deploying the callback Worker. It is compatible with schema 0005 (production) and schema 0009 (staging). Do not apply the unrelated missing application migrations to production as part of this deployment. The SQL is idempotent and does not delete existing data or rewrite ordinary app tables.

`meta_subject_cutoffs` retains the Threads subject ID and the highest authenticated revocation/deletion cutoff. This is minimal security metadata retained to reject late grants and token resurrection; it contains no profile, content or tokens. `meta_account_grants` records the authorization time for each current account and cascades when that account is deleted.

The existing application's `token_obtained_at` changes on automatic refresh, so it cannot serve as an authorization time. Triggers maintain the separate grant record:

1. Account INSERT records the initial token time.
2. The existing explicit reconnect SQL changes the encrypted token and sets `status='ok', token_last_refresh_at=NULL`. Only this pattern advances the grant time.
3. Maintenance token refresh sets `token_last_refresh_at` and leaves the grant time unchanged. A refresh that completes before a delayed callback cannot evade it by advancing token age. A refresh completing after revocation cannot restore a cleared token. An older refresh cannot overwrite a newer reconnection.

For existing rows at first installation, there is a historical limitation: when `token_last_refresh_at IS NULL`, the current token time is usable; when automatic refresh has already occurred, the original connection time was not retained. The backfill conservatively uses `created_at` for these rows. Thus a historical callback for an earlier grant could invalidate an already-refreshed reconnection that predates installing this metadata. All explicit connections after installation get exact grant ordering. This is an intentional fail-closed backfill, not recovery of historical data that does not exist.

The signed cutoff includes the entire `issued_at` second. A connection in that same second is conservatively treated as old. Reconnect after that second if needed. Cutoffs are monotonic across retries.

Account and child-table guards stop late jobs from inserting orphan posts, metrics, links, drafts, automation rows or account-specific audit entries after deletion. They also reject account-child writes while a privacy-revoked token is blank. This means retained drafts/links are read-only until reconnection. Ordinary expired tokens whose encrypted value is still present retain normal editing behavior. Global jobs and login audit entries are unaffected. Guard failures may appear as job errors in already-running old application code; the data mutation is rolled back.

Existing older-schema tables lack FKs, so simply deleting the account would not provide these guarantees. The guard installation is a required deployment step. The main app must preserve the explicit reconnect SQL contract; if that flow or token refresh changes, update and retest these guards as well.

## What is deleted, retained, and not covered

Each database transaction resolves eligible account rows for the signed Threads subject and the recorded grant time **inside the same transaction**. A subject may have multiple accounts belonging to different app users; all eligible matches are processed. Unrelated Threads accounts are preserved.

Deletion removes `posts`, `post_metrics_history`, `queue`, `learning`, `links`, `autopilot`, `jobs`, `daily_views`, `follower_snapshots`, `click_weeks`, `click_weeks_done`, `demographics`, `ap_log`, account-targeted `audit_log` entries and `accounts`. Staging's posting schedules and reservations cascade through their existing FKs; there are no direct queries to these newer tables on production. Grant metadata cascades too. User login records, licenses, AI credentials, user-owned sources and Google connection data remain because they are independent of the particular Threads account and may serve other linked accounts.

**New authorization boundary:** deauthorization retains existing data; when the same account is explicitly reconnected, that retained history is associated with the newer current grant. A delayed older deletion request will preserve the entire reconnected account, including retained pre-reconnection posts. This implementation does not track per-row provider grant lineage, and must not claim to delete every historical data item across a new consent event. The completion page states this boundary. A later authenticated deletion for the current grant deletes that account's full active data.

**Two DBs:** each D1 batch is atomic, but there is no distributed transaction across production and staging. If production succeeds and staging fails, the endpoint returns 503 and no completion receipt. The identical Meta retry safely finishes both. Operators should investigate persistent 503s and Meta rejected/retried requests. No background polling or cron is required by this Worker.

**In-flight external operations:** a Threads publish or other network call already sent before the callback cannot be unsent. The DB guards prevent restoring removed app data; they do not retract a previously accepted Threads post, erase provider-owned data, or undo external side effects.

**Backups and exports:** completion concerns the two **active databases**, not Cloudflare Time Travel, private backups, user exports or previously synced spreadsheets. Follow the backup retention policy separately. Before restoring a backup, restore/reapply all later signed deletion/revocation events or copy the later cutoff records and reconcile eligible data before serving traffic or resuming jobs. Restoring old data without this step would resurrect deleted data. Raw signed requests contain identity information and must not be placed in logs or public issue trackers; any operational replay archive needs restricted access and a defined retention policy. A completion receipt alone is intentionally not an authorization to rerun deletion.

## Validation and rollout

`worker/test/meta-callbacks.test.ts` uses only synthetic identities/secrets and separate local D1 bindings. The production fixture applies only migrations before 0007; staging applies all current migrations. Tests cover unsigned/malformed/forged requests with zero DB access, cross-user boundaries, both DBs, all account tables, newer-table cascades, idempotent retries and receipts, rollback, partial failure, the exact old maintenance refresh SQL, reconnect ordering and delayed-write guards. Normal editing and global jobs are covered too.

Before rollout: inspect/backup both actual schemas; apply guards to restored copies twice, confirm ordinary rows and counts remain intact, test integrity; run callback tests and standalone callback typecheck. Apply the exact SQL to each remote DB, set the dedicated app secret, deploy the dedicated callback Worker, verify public GET reachability and unsigned POST rejection, then register the real endpoints in Meta. A successful reachability response is not evidence that Meta has delivered a signed deletion/deauthorization event.
