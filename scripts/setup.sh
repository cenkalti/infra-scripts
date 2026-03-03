#!/usr/bin/env bash
# Replace %%CANARY%% placeholder with your deployed Cloudflare Worker URL.
#
# Usage:
#   ./scripts/setup.sh https://infra.YOUR-SUBDOMAIN.workers.dev

set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <worker-url>"
  echo "Example: $0 https://infra.acme.workers.dev"
  exit 1
fi

WORKER_URL="${1%/}"  # strip trailing slash

TARGET_FILES=$(find . -type f \( \
  -name "*.md" -o \
  -name "*.yaml" -o \
  -name "*.yml" -o \
  -name "*.py" -o \
  -name "*.js" -o \
  -name "*.example" \
\) \
  -not -path "./.git/*" \
  -not -path "./worker/*" \
  -not -path "./node_modules/*")

COUNT=0
while IFS= read -r file; do
  if grep -q "%%CANARY%%" "$file" 2>/dev/null; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s|%%CANARY%%|${WORKER_URL}|g" "$file"
    else
      sed -i "s|%%CANARY%%|${WORKER_URL}|g" "$file"
    fi
    echo "  updated: $file"
    COUNT=$((COUNT + 1))
  fi
done <<< "$TARGET_FILES"

echo ""
echo "Done. $COUNT file(s) updated with: $WORKER_URL"
echo ""
echo "Next: commit and push the repo to GitHub."
