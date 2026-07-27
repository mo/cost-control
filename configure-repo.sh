#!/usr/bin/env bash
set -euo pipefail

REPO="mo/cost-control"
DOMAIN="cost-control.minimum.se"

gh api -X POST "repos/${REPO}/pages" -f build_type=workflow || true
gh api -X PUT "repos/${REPO}/pages" -f "cname=${DOMAIN}"
