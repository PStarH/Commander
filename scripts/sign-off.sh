#!/usr/bin/env bash
# scripts/sign-off.sh — Day 7+3 GPG sign-off driver for §6.3 of keys-rotation.md.
#
# Audit #5 closeout: every release is RED exit 1 until ≥4 GPG-verified commits
# land on the §6.3 table. This script drives the operator through the two-
# commit flow per role without ever auto-signing (GPG private keys must NEVER
# be automated; only the named human must sign with their key).
#
# Two-commit contract (mandatory):
#   Commit A (SIGNED):
#     - The operator makes the policy text edit (e.g. the Name/Handle/Fingerprint
#       for one role) and signs it with `git commit -S`.
#     - The script captures Commit A's SHA.
#   Commit B (UNSIGNED — records the binding):
#     - The script writes the captured SHA into the row's Signed-Commit SHA cell.
#     - `git commit` (unsigned) finalizes the table.
#
# This split is necessary because a commit's SHA is computed from its tree +
# content; embedding the SHA within the same commit impossible by definition
# (cyrptic recursion). The d26 verifier accepts Commits B as the table-update
# while Commit A holds the actual GPG binding.
#
# Usage:
#   bash scripts/sign-off.sh --role=ciso --name="Alice Smith" --handle=@alice \
#     --fingerprint=7E5C0F8B4D1A9C23
#
#   bash scripts/sign-off.sh --role=eng --dry-run
#
# Bypass: NEVER. This script refuses to auto-sign; it expects
#   git config --global user.signingkey <GPG-KEY-ID>
# to already be set on the operator's machine.
#
# Exit codes:
#   0 — both commits landed + d26 verifier shows green for the row
#   1 — operator error (wrong role, missing fingerprint format, etc.)
#   2 — git / GPG plumbing failure

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

# ----- arg parsing -----------------------------------------------------------

ROLE=""
NAME=""
HANDLE=""
FINGERPRINT=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --role=*)         ROLE="${1#*=}" ;;
    --name=*)         NAME="${1#*=}" ;;
    --handle=*)       HANDLE="${1#*=}" ;;
    --fingerprint=*)  FINGERPRINT="${1#*=}" ;;
    --dry-run)        DRY_RUN=1 ;;
    --help|-h)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *) echo "sign-off: unknown flag: $1" >&2; exit 1 ;;
  esac
  shift
done

VALID_ROLES="ciso head-of-security eng compliance"
if ! echo " $VALID_ROLES " | grep -q " $ROLE "; then
  echo "sign-off: --role must be one of: $VALID_ROLES (got: $ROLE)" >&2
  exit 1
fi

# Map shorthand → canonical role label as it appears in §6.3
case "$ROLE" in
  ciso)   CANONICAL_ROLE="CISO" ;;
  head-of-security) CANONICAL_ROLE="Head of Security" ;;
  eng)    CANONICAL_ROLE="Engineering Lead" ;;
  compliance) CANONICAL_ROLE="Compliance Lead" ;;
esac

# GPG fingerprint is 40-char hex / 16-char short. Stricter here than d26
# because this is the per-operator invariant.
if [ -z "$FINGERPRINT" ]; then
  echo "sign-off: --fingerprint is required (16-char short, 40-char SHA-1, or 64-char SHA-256)" >&2
  exit 1
fi

# Validate fingerprint: must be hex of length 16, 40, or 64
case ${#FINGERPRINT} in
  16|40|64)
    if ! echo "$FINGERPRINT" | grep -qE '^[A-Fa-f0-9]+$'; then
      echo "sign-off: --fingerprint=$FINGERPRINT is not valid hex" >&2
      exit 1
    fi
    ;;
  *)
    echo "sign-off: --fingerprint=$FINGERPRINT must be 16, 40, or 64 hex characters (got ${#FINGERPRINT})" >&2
    exit 1
    ;;
esac

# Refuse to auto-sign — GPG contract is HUMAN-ONLY.
if git config --global --get user.signingkey >/dev/null 2>&1; then
  SIGNING_KEY=$(git config --global --get user.signingkey)
  echo "sign-off: detected git signingkey=$SIGNING_KEY (operator must sign manually)"
else
  echo "sign-off: git signingkey NOT configured"
  echo "          → this script will never auto-sign"
  echo "          → run: gpg --full-gen-key  (or import an existing key)"
  echo "          → then: git config --global user.signingkey <KEY-ID>"
  exit 1
fi

DOC="$REPO_ROOT/docs/security/keys-rotation.md"

# ----- diff the operator's row into a working change -----------------------

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[sign-off] dry-run mode: no commits will be created"
fi

# Locate the row for CANONICAL_ROLE in the §6.3 table.
ROW_LINE=$(grep -nE "^\| \*\*${CANONICAL_ROLE}\*\*" "$DOC" | head -1 | cut -d: -f1)
if [ -z "$ROW_LINE" ]; then
  echo "sign-off: no row in §6.3 for role=$CANONICAL_ROLE — check keys-rotation.md" >&2
  exit 1
fi

# Build the new row. Cells: Role | Name | GitHub handle | GPG fingerprint | Signed-Commit SHA
# The SHA cell is intentionally empty in Commit A — it is filled in Commit B.
NEW_ROW="| **${CANONICAL_ROLE}** | ${NAME} | ${HANDLE} | ${FINGERPRINT} |  |"

# Apply the edit (sed in-place).
sed -i.bak "${ROW_LINE}s|.*|${NEW_ROW}|" "$DOC"
rm -f "$DOC.bak"

echo "[sign-off] staged edited row for $CANONICAL_ROLE"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[sign-off] would commit (A) the policy edit, then commit (B) the SHA"
  exit 0
fi

# ----- Commit A (GPG-signed) ------------------------------------------------
git add "$DOC"
echo "[sign-off] stage Commit A — operator signs manually: git commit -S -m 'sign-off: $CANONICAL_ROLE row fields'"
echo "          → once you've committed, capture the SHA: git log -1 --format=%H"
echo "          → re-run this script with --commit-sha=<SHA> to record Commit B"

# ----- Commit B (records the binding, unsigned) ----------------------------
# Caller can re-invoke us with --commit-sha=<SHA>:
COMMIT_SHA=""
for arg in "$@"; do
  case "$arg" in
    --commit-sha=*) COMMIT_SHA="${arg#*=}" ;;
  esac
done

if [ -z "$COMMIT_SHA" ]; then
  echo "[sign-off] Commit A not yet made — operator action required"
  exit 0
fi

# Refill the row's SHA cell with the captured Commit A SHA
sed -i "/^\| \*\*${CANONICAL_ROLE}\*\*/s|  |  ${COMMIT_SHA}  |" "$DOC"
git add "$DOC"
git -c user.signingkey= commit -m "sign-off: record ${CANONICAL_ROLE} signing commit (SHA=${COMMIT_SHA:0:12})"
echo "[sign-off] Commit B landed"

# ----- Verify ----------------------------------------------------------------
echo "[sign-off] running d26 verifier to confirm green status:"
npx tsx scripts/verify-rotation-signoff.ts --json | node -e "
let buf='';
process.stdin.on('data',d=>buf+=d);
process.stdin.on('end',()=>{
  const r=JSON.parse(buf);
  console.log('  exit_code='+r.exitCode+' status='+r.status);
  for(const reason of r.reasons){console.log('  - '+reason);}
});"

# The verifier already exits with the binding code; we just summarize.
echo "[sign-off] done"
