/**
 * The old staging URL after staging was promoted to production (DECISIONS 2026-10-22).
 * Every request is sent to the same path on the production origin.
 * No bindings, no secrets, no cron: this Worker never touches the database.
 */
const TARGET = "https://threads-autopilot.yama-threads-apps.workers.dev";

export default {
  fetch(request: Request): Response {
    const url = new URL(request.url);
    return Response.redirect(TARGET + url.pathname + url.search, 301);
  },
};
