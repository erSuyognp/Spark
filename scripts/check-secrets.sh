#!/usr/bin/env bash
# Fails if anything resembling a live credential would be published.
# Run before your first push, and before every push after that:
#     bash scripts/check-secrets.sh
set -u
cd "$(dirname "$0")/.." || exit 2
found=0

# Real Anthropic keys look like sk-ant-<long>. The placeholder in
# .dev.vars.example is excluded deliberately.
if command -v git >/dev/null && git rev-parse --git-dir >/dev/null 2>&1; then
  scan() { git grep -nIE "$1" -- . ':!*.example' 2>/dev/null; }
  tracked_secret_file=$(git ls-files .dev.vars .env 2>/dev/null)
else
  # Works before `git init` too, so you can check before the repo exists.
  scan() { grep -rnIE --exclude-dir=.git --exclude-dir=node_modules \
             --exclude='*.example' "$1" . 2>/dev/null; }
  tracked_secret_file=""
fi

if scan 'sk-ant-[A-Za-z0-9_-]{20,}' | grep -v 'REPLACE-ME'; then
  echo "FAIL: an Anthropic API key is present in the working tree."
  found=1
fi

if [ -n "$tracked_secret_file" ]; then
  echo "FAIL: these secret files are tracked by git:"
  echo "$tracked_secret_file"
  echo "Untrack them:  git rm --cached .dev.vars .env"
  found=1
fi

if [ "$found" -eq 0 ]; then
  echo "OK: no credentials found. Safe to publish."
fi
exit "$found"
