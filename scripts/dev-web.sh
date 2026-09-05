#!/bin/bash
# Dev server launcher with a pinned Node PATH (the preview tool's PATH may resolve an old Node).
export PATH="/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.."
exec npm run dev:web
