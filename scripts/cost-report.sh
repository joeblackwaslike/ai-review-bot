#!/usr/bin/env bash
# Reproducible cost report for ai-review-bot reviews on a given repo.
# Usage: ./scripts/cost-report.sh [owner/repo] [--prs 65,67-74]
#   --prs   comma-separated PR numbers and/or ranges (e.g. "65,67-74").
#           Omit to scan merged PRs on the repo (most recent 500).
set -euo pipefail

REPO=""
PR_SPEC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prs)
      if [ $# -lt 2 ]; then
        echo "Error: --prs requires a value, e.g. --prs 65,67-74" >&2
        exit 1
      fi
      PR_SPEC="$2"
      shift 2
      ;;
    *)
      REPO="$1"
      shift
      ;;
  esac
done
REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"

expand_pr_spec() {
  IFS=',' read -ra parts <<< "$1"
  for part in "${parts[@]}"; do
    part="$(echo "$part" | tr -d '[:space:]')"
    [ -z "$part" ] && continue
    if [[ "$part" == *-* ]]; then
      local lo="${part%-*}" hi="${part#*-}"
      if ! [[ "$lo" =~ ^[0-9]+$ && "$hi" =~ ^[0-9]+$ && "$lo" -le "$hi" ]]; then
        echo "Error: bad PR range '$part' in --prs" >&2
        exit 1
      fi
      seq "$lo" "$hi"
    else
      if ! [[ "$part" =~ ^[0-9]+$ ]]; then
        echo "Error: bad PR number '$part' in --prs" >&2
        exit 1
      fi
      echo "$part"
    fi
  done
}

if [ -n "$PR_SPEC" ]; then
  echo "Pulling reviews for $REPO PRs: $PR_SPEC..." >&2
  pr_numbers=$(expand_pr_spec "$PR_SPEC")
else
  echo "Pulling merged PR reviews for $REPO (most recent 500)..." >&2
  pr_numbers=$(gh pr list --repo "$REPO" --state merged --limit 500 --json number --jq '.[].number')
fi

costs=$(echo "$pr_numbers" | while read -r pr; do
    gh api "repos/$REPO/pulls/$pr/reviews" \
      --jq '.[] | select(.user.login | contains("reviewbot")) | .body' 2>/dev/null || true
  done | { grep -oE '\$[0-9]+\.[0-9]{6}' || true; } | tr -d '$')

if [ -z "$costs" ]; then
  echo "No ai-review-bot reviews found on $REPO." >&2
  exit 1
fi

echo "$costs" | jq -R -s '
  split("\n") | map(select(length > 0) | tonumber) | sort as $s |
  ($s | length) as $n |
  ($s | add) as $total |
  {
    reviews: $n,
    total_usd: ($total * 100 | round / 100),
    mean_usd: (($total / $n) * 1000000 | round / 1000000),
    median_usd: (if $n % 2 == 1 then $s[($n - 1) / 2] else ($s[$n/2 - 1] + $s[$n/2]) / 2 end),
    min_usd: $s[0],
    max_usd: $s[-1]
  }
'
