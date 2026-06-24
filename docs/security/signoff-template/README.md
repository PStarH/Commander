# GPG Sign-off Template — Day 7+3 (Audit #5 Closeout)

`docs/security/keys-rotation.md §6.3` requires 4 GPG-verified SHAs on the
sign-off table before `pnpm vitest run tests/security/d26-rotation-signoff-gate.test.ts`
turns GREEN. Until then every release stays RED exit 1.

This template drives a per-role operator through the GPG setup + two-commit
flow WITHOUT automating any signing. GPG private keys NEVER leave the
operator's machine.

## Who needs to sign

| Role (in §6.3)   | Operator shorthand | Required?                         |
| ---------------- | ------------------ | --------------------------------- |
| CISO             | `ciso`             | Yes — security policy cannot bind |
| Head of Security | `head-of-security` | Yes — operational ownership       |
| Engineering Lead | `eng`              | Yes — implementation-side binding |
| Compliance Lead  | `compliance`       | Yes — audit-side binding          |

## Two-commit flow (mandatory)

A commit's SHA is computed from its tree + content. Embedding the SHA into
the same commit is impossible by cryptographic recursion. So the §6 verifier
expects two commits per sign-off:

```
Commit A (GPG-signed):
  - Operator makes the policy text edit (Name/Handle/Fingerprint for their role).
  - `git commit -S -m 'sign-off: <role> row fields'`
  - Captures SHA: `git log -1 --format=%H`

Commit B (UNSIGNED):
  - Script writes the captured SHA into the role's row cell.
  - `git commit -m 'sign-off: record <role> signing commit (SHA=...)'`
  - This is the binding artifact — d26 verifier reads this row's SHA cell
    and replays `git verify-commit <SHA>` against Commit A (which IS signed).
```

The verifier accepts both commits: Commit A holds the GPG binding, Commit B
is the table-update that points to it.

## GPG setup (per operator)

```bash
# Generate (or import existing):
gpg --full-gen-key   # ed25519 recommended

# Tell git to use it:
git config --global user.signingkey "<KEY-ID>"

# Verify your setup:
echo "test" | gpg --clearsign | gpg --verify
```

## Drive the signing (one-time per role)

```bash
# Edit the row's Name / Handle / Fingerprint cells with the operator's data.
# Drive the rest with scripts/sign-off.sh:

# Step 1: stage + sign Commit A:
bash scripts/sign-off.sh \
  --role=ciso \
  --name="Alice Smith" \
  --handle=@alice \
  --fingerprint=7E5C0F8B4D1A9C23

# Stage + sign Commit A MANUALLY (script refuses to auto-sign):
git add docs/security/keys-rotation.md
git commit -S -m "sign-off: CISO row fields"

# Capture Commit A's SHA:
CAPTURED_SHA=$(git log -1 --format=%H)

# Step 2: drive Commit B (records the SHA):
bash scripts/sign-off.sh \
  --role=ciso \
  --commit-sha=$CAPTURED_SHA

# Step 3: confirm d26 gate turns GREEN:
npx tsx scripts/verify-rotation-signoff.ts --json
```

## Verifier invariants

`packages/core/src/security/rotationSignoffVerifier.ts`:

- `POLICY_MIN_VERIFIED_ROWS = 4` (D2.9 full 4-role bump; pre-D2.9 was 1, then 2).
- Empty SHA cell = `[pending]`, NOT `[FAILED]`.
- Row with non-empty SHA that fails `git verify-commit` IS a failure.
- Both clauses surface when violated (D3.0 `reasons[]` array):
  - `policy NOT bound` (insufficient verified rows)
  - `N unverified SHA(s) need to be fixed`
- Effective date is NEVER free-form — derived as
  `git log -1 --format=%aI <SHA>` (cryptographic binding to commit).

## SHA format requirements

d26's `verifySha()` accepts:

- 7-char abbreviated (`abc1234`)
- 40-char SHA-1
- 64-char SHA-256

Anything else is rejected with `invalid SHA format` BEFORE git sees it
(shell-injection defense-in-depth — see `SHA_RE`).

## Operator checklist

- [ ] GPG key exists (ed25519 recommended; ≥2048-bit RSA acceptable)
- [ ] `git config --global user.signingkey <KEY-ID>` set
- [ ] Commit A signed by the named human's key
- [ ] Commit B records `git log -1 --format=%H` from Commit A
- [ ] PR has at least one approval from a DIFFERENT role (§6.4)
- [ ] Included in next tagged security-policy release

## Break-glass (waiver under §3)

Under CISO direct instruction (per §3 trigger #3) OR a HackerOne report
(trigger #1), a waiver-PR can be filed. The waiver SHOULD NOT bypass the
4-row gate without explicit CISO commitment to remediate post-incident.
