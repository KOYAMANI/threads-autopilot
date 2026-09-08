# Meta reviewer walkthrough — preparation copy

Status: not yet submitted. Do not paste this status paragraph into the final review. Validate every step on screen before submitting the instructions. The credentials belong only in Meta’s private reviewer credentials field; retrieve them from the operator’s protected staging-meta-reviewer.json file, never from Git.

## Access

Review URL: https://threads-autopilot-staging.yama-threads-apps.workers.dev/login

The application has its own email/password sign-in. It does not use Facebook Login. Threads authorization is a separate flow using the official Threads authorization page. A dedicated application test login has the test profile @yama_threads.sub connected. No other user’s drafts are included.

## Instructions to validate and then submit

1. Sign in at the review URL using the dedicated application credentials provided in the private field. Open Analytics. Confirm the selected profile is @yama_threads.sub.
2. Inspect the profile picture, username, own posts and available insights. Change the date range and open a multi-part post to see the profile’s own follow-up replies. Newly published posts can have zero views or unavailable metrics; do not present fabricated engagement.
3. Open Create and save a short test draft. If the Create screen requires AI, use the existing manual draft editor instead, and update these instructions to its actual label after verification. Reviewers must not need a personal paid AI key to test the requested Threads permissions.
4. Open Drafts & Schedule. Open the test draft, choose the separate immediate-publish action, and confirm both the selected profile and complete text. Check the completed state, then open the result URL and compare the live root post and follow-up reply.
5. For scheduling, create a separate clearly labelled review test draft and choose a future time. After the selected time, refresh the queue and inspect its completed state and live result. A scheduled row alone is not proof that automatic publishing ran.
6. Settings includes account management and links to the published privacy/deletion instructions. Do not delete or disconnect the shared test profile as part of ordinary navigation. A separate controlled test is needed to demonstrate deletion and reconnection.

## Recording plan

Use a genuine browser screen recording. Capture the official Threads authorization flow, return to the application, profile and own-post data, insights, own-reply expansion, draft save, immediate publish confirmation, completed queue state, and the resulting post on Threads. Include scheduling completion only after the Cron execution has been observed. Avoid showing passwords, tokens, developer secrets, other users’ data, bank tabs or verification documents.

The previously approved direct API test posts are evidence of API connectivity only. They are not a substitute for the application walkthrough:
- Root: https://www.threads.com/@yama_threads.sub/post/DdAhMh8EjQC
- Follow-up: https://www.threads.com/@yama_threads.sub/post/DdAhNY0khqX

## Permission evidence

| Permission | Actual feature to demonstrate |
| --- | --- |
| threads_basic | Connected profile and own posts |
| threads_manage_insights | Available account/post metrics |
| threads_content_publish | User-confirmed root post and completed publication |
| threads_read_replies | Reading this profile’s own follow-up replies |
| threads_manage_replies | Verify that the implemented own-reply operation actually requires this scope; do not claim moderation that is not implemented |

## Operator checks before submission

- Complete processor names, service purposes and actual processing-location declarations; do not submit the current partial country selection as complete.
- Resolve Gemini/OpenRouter contract and routing conditions with the chosen release scope.
- Replace the saved preparation-only reviewer instructions in Meta with verified steps and private credentials.
- Ensure the login remains valid for Meta’s requested one-year period. The publication policy currently expires on 2027-10-01; the connected Threads token has a separate expiry and needs maintenance.
- Recheck the required API test counters and attach actual videos to each relevant permission.
- Review and accept only accurate permitted-use declarations. Submit and record the resulting receipt/status.
