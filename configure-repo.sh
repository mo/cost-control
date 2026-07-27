#!/usr/bin/env bash
set -euo pipefail

REPO="mo/cost-control"
DOMAIN="cost-control.minimum.se"

gh api -X POST "repos/${REPO}/pages" -f build_type=workflow || true
gh api -X PUT "repos/${REPO}/pages" -f "cname=${DOMAIN}"
# Fails until the cert for a freshly-set CNAME is issued, so this can need a
# re-run rather than working on the very first pass.
gh api -X PUT "repos/${REPO}/pages" -F https_enforced=true || true
