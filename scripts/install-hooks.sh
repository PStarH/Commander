#!/usr/bin/env bash
# scripts/install-hooks.sh — installer for the D3 git hooks (pre-commit, pre-push).
#
# Ownership contract (LM-14 / HOOK-01):
#   • The hooks directory is DISCOVERED with `git rev-parse --git-path hooks`, so
#     linked worktrees (where `.git` is a file) work and `$ROOT/.git/hooks` is
#     never hardcoded. `core.hooksPath` is read too: if it points anywhere other
#     than this repo's version-controlled `.githooks`, the installer refuses to
#     run rather than silently writing a directory git will not use.
#   • It installs a small managed SHIM per hook that execs the version-controlled
#     `.githooks/<hook>`; hook logic stays in git, only the shim is local state.
#   • It never touches what it does not own. An unknown pre-existing hook, a
#     symlinked hook, or a custom hooksPath stops the run with a clear message,
#     exit 3, and zero changes (nothing written, no git config touched).
#     `--adopt-existing` is the explicit opt-in to back up an unknown hook first.
#   • Each install writes a per-hook manifest next to the hook recording the
#     target, backup path, backup hash, installed hash and the previous
#     core.hooksPath value, so ownership is provable later.
#   • Re-installing identical content is a no-op (no backups, no timestamp churn).
#   • `--uninstall` verifies the installed shim still matches the recorded hash;
#     a shim edited by someone else aborts the uninstall untouched. A backup that
#     contains a known security bypass (COMMANDER_SKIP_PRECOMMIT=1 etc.) is NEVER
#     restored automatically — the operator has to move it back by hand.
#
# Local hooks are a convenience gate, NOT a security boundary: anyone who
# controls this checkout can skip them (`git commit --no-verify`,
# `git config --unset core.hooksPath`, deleting the shim). The hard guarantee is
# server-side — branch protection with required status checks that CI runs.
#
# Usage:
#   bash scripts/install-hooks.sh                  # install/refresh both hooks
#   bash scripts/install-hooks.sh --adopt-existing # also take over unknown hooks (after backing them up)
#   bash scripts/install-hooks.sh --uninstall      # remove managed shims
#
# Exit codes: 0 ok, 1 internal/tooling failure, 2 bad arguments, 3 refused
# (unsupported layout or unowned/foreign state — nothing was changed).

set -euo pipefail

SHIM_MARKER="# COMMANDER-MANAGED-HOOK-SHIM v1"
SHIM_VERSION="1"
HOOKS=("pre-commit" "pre-push")
# Patterns that mark a legacy hook as deliberately bypassable. Such a backup is
# preserved but never restored automatically.
KNOWN_BYPASS_RE='COMMANDER_SKIP_PRECOMMIT|COMMANDER_SKIP_PREPUSH|COMMANDER_SKIP_HOOKS|CORE_SKIP_HOOKS|--no-verify'

MODE="install"
ADOPT_EXISTING=0

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/install-hooks.sh                   install/refresh managed hook shims
  bash scripts/install-hooks.sh --adopt-existing  also back up and take over unknown hooks
  bash scripts/install-hooks.sh --uninstall       remove managed shims
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --uninstall) MODE="uninstall" ;;
    --adopt-existing) ADOPT_EXISTING=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "❌ Unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

refuse() {
  printf '❌ %s\n' "$1" >&2
  exit 3
}

# ── discovery ────────────────────────────────────────────────────────────────

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ]; then
  refuse "Not in a git working directory — install-hooks.sh must run inside a git checkout."
fi
cd "$REPO_ROOT"

CUSTOM_HOOKS_PATH="$(git config --get core.hooksPath || true)"
EFFECTIVE_HOOKS_PATH="$(git rev-parse --git-path hooks 2>/dev/null || true)"
if [ -z "$EFFECTIVE_HOOKS_PATH" ]; then
  refuse "git could not resolve a hooks path for this checkout."
fi

# `git rev-parse --git-path hooks` already honours core.hooksPath and returns an
# absolute path in linked worktrees; a relative result is relative to the repo root.
case "$EFFECTIVE_HOOKS_PATH" in
  /*) HOOKS_DIR="$EFFECTIVE_HOOKS_PATH" ;;
  *) HOOKS_DIR="$REPO_ROOT/$EFFECTIVE_HOOKS_PATH" ;;
esac
if [ -d "$HOOKS_DIR" ]; then
  HOOKS_DIR="$(cd "$HOOKS_DIR" && pwd -P)"
fi
SOURCE_HOOKS_DIR="$REPO_ROOT/.githooks"

if [ -n "$CUSTOM_HOOKS_PATH" ]; then
  if [ -d "$SOURCE_HOOKS_DIR" ] && [ "$HOOKS_DIR" = "$(cd "$SOURCE_HOOKS_DIR" && pwd -P)" ]; then
    cat <<EOF
ℹ️  core.hooksPath is already set to '$CUSTOM_HOOKS_PATH' (git resolves it to
   $HOOKS_DIR), i.e. git runs the version-controlled hooks directly.
   No shim is needed and none was installed. Nothing was changed.
EOF
    exit 0
  fi
  cat >&2 <<EOF
❌ Refusing to install: core.hooksPath is set to '$CUSTOM_HOOKS_PATH'.
   git resolves the hooks directory for this checkout to: $HOOKS_DIR
   This installer only manages the repository's default hooks directory (the one
   inside the git dir). Writing into a custom hooksPath would be wrong, and this
   installer will not rewrite your git config for you.

   Pick one and re-run:
     • Keep your custom directory and manage those hooks yourself.
     • Track the version-controlled hooks: git config core.hooksPath .githooks
       (then no install step is needed — git runs them directly).
     • Unset it: git config --unset core.hooksPath

   Nothing was changed.
EOF
  exit 3
fi

# ── helpers ──────────────────────────────────────────────────────────────────

hash_file() {
  local f="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$f" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" | awk '{print $1}'
  else
    echo "❌ No sha256 tool (shasum/sha256sum) available." >&2
    exit 1
  fi
}

has_marker() {
  grep -qF "$SHIM_MARKER" "$1" 2>/dev/null
}

contains_known_bypass() {
  grep -qE "$KNOWN_BYPASS_RE" "$1" 2>/dev/null
}

manifest_path() {
  printf '%s/%s.commander-manifest' "$HOOKS_DIR" "$1"
}

manifest_get() {
  local file="$1" key="$2" out=""
  if [ -f "$file" ]; then
    out="$(grep "^${key}=" "$file" 2>/dev/null | head -n 1 | cut -d '=' -f 2- || true)"
  fi
  printf '%s' "$out"
}

write_manifest() {
  local hook="$1" target="$2" installed_hash="$3" backup="$4" backup_hash="$5" prev_cfg="$6" bypass_flag="$7"
  local file tmp
  file="$(manifest_path "$hook")"
  tmp="$file.tmp.$$"
  {
    printf 'shim_version=%s\n' "$SHIM_VERSION"
    printf 'hook=%s\n' "$hook"
    printf 'target=%s\n' "$target"
    printf 'installed_sha256=%s\n' "$installed_hash"
    printf 'previous_core_hooks_path=%s\n' "$prev_cfg"
    printf 'backup=%s\n' "$backup"
    printf 'backup_sha256=%s\n' "$backup_hash"
    printf 'backup_contains_known_bypass=%s\n' "$bypass_flag"
    printf 'repo_root=%s\n' "$REPO_ROOT"
  } > "$tmp"
  mv -f "$tmp" "$file"
}

# The shim is the only thing this installer writes into the hooks directory.
# Content is deterministic (no timestamps) so a re-install is byte-identical.
render_shim() {
  local hook="$1"
  cat <<SHIM
#!/usr/bin/env bash
$SHIM_MARKER
# Managed by scripts/install-hooks.sh (shim v$SHIM_VERSION) — do not edit.
# Delegates to the version-controlled .githooks/$hook so the gate logic is
# reviewable in git. Local hooks are NOT a security boundary; the hard
# guarantee is server-side branch protection with required status checks.
set -euo pipefail

REPO_ROOT="$REPO_ROOT"
TARGET="\$REPO_ROOT/.githooks/$hook"

if [ ! -f "\$TARGET" ]; then
  echo "❌ Managed hook source missing: \$TARGET" >&2
  echo "   Reinstall: bash \"\$REPO_ROOT/scripts/install-hooks.sh\"" >&2
  exit 1
fi

exec bash "\$TARGET" "\$@"
SHIM
}

install_bytes() {
  local src="$1" dst="$2" staging="$2.commander-staging.$$"
  cat "$src" > "$staging"
  chmod 0755 "$staging"
  mv -f "$staging" "$dst"
}

render_shim_hash() {
  local hook="$1" tmp="$TMPDIR_RUN/$hook.hash.tmp"
  render_shim "$hook" > "$tmp"
  hash_file "$tmp"
}

# ── install preflight (nothing is written before this passes) ────────────────

preflight_install() {
  local hook target
  case "$REPO_ROOT" in
    *'"'*|*'`'*|*'$'*)
      refuse "Repository path contains quote/dollar/backtick characters; this installer will not embed it in a shim: $REPO_ROOT" ;;
  esac
  for hook in "${HOOKS[@]}"; do
    if [ ! -f "$SOURCE_HOOKS_DIR/$hook" ]; then
      refuse "Source hook missing: $SOURCE_HOOKS_DIR/$hook (was .githooks/$hook deleted or never committed?)"
    fi
  done
  for hook in "${HOOKS[@]}"; do
    target="$HOOKS_DIR/$hook"
    if [ -L "$target" ]; then
      refuse "Refusing to touch '$target': it is a symlink and this installer never creates symlinks. Nothing was changed."
    fi
    if [ -e "$target" ] && ! has_marker "$target" && [ "$ADOPT_EXISTING" -ne 1 ]; then
      cat >&2 <<EOF
❌ Refusing to overwrite '$target': it is a pre-existing hook this installer does
   not own (no '$SHIM_MARKER' marker).
   Move it aside yourself, or re-run with --adopt-existing to back it up first:
     mv '$target' '$target.local-backup'
     bash scripts/install-hooks.sh
   Nothing was changed.
EOF
      exit 3
    fi
  done
}

do_install() {
  local hook target manifest rendering new_hash cur_hash backup backup_hash bypass_flag prev_cfg
  prev_cfg="$(git config --get core.hooksPath || true)"
  mkdir -p "$HOOKS_DIR"

  for hook in "${HOOKS[@]}"; do
    target="$HOOKS_DIR/$hook"
    manifest="$(manifest_path "$hook")"
    rendering="$TMPDIR_RUN/$hook.shim"
    render_shim "$hook" > "$rendering"
    new_hash="$(hash_file "$rendering")"

    if [ -e "$target" ] && has_marker "$target"; then
      cur_hash="$(hash_file "$target")"
      if [ "$cur_hash" = "$new_hash" ]; then
        echo "✅ $hook: already installed, identical content (no-op) → $target"
        continue
      fi
      # Managed but stale (moved checkout / older shim version): refresh in place
      # and keep the recorded original backup untouched.
      backup="$(manifest_get "$manifest" backup)"
      backup_hash="$(manifest_get "$manifest" backup_sha256)"
      bypass_flag="$(manifest_get "$manifest" backup_contains_known_bypass)"
      [ -n "$bypass_flag" ] || bypass_flag=0
      install_bytes "$rendering" "$target"
      write_manifest "$hook" "$target" "$new_hash" "$backup" "$backup_hash" "$prev_cfg" "$bypass_flag"
      echo "♻️  $hook: refreshed managed shim → $target"
      continue
    fi

    backup=""
    backup_hash=""
    bypass_flag=0

    if [ -e "$target" ]; then
      # --adopt-existing was given: back the unknown hook up without ever
      # overwriting an existing backup, then take ownership.
      backup="$HOOKS_DIR/$hook.commander-backup.$(hash_file "$target" | cut -c1-12)"
      if [ -e "$backup" ]; then
        if [ "$(hash_file "$backup")" != "$(hash_file "$target")" ]; then
          refuse "Refusing to adopt '$target': backup '$backup' already exists with different content. Nothing was changed."
        fi
      else
        cp -p "$target" "$backup"
      fi
      backup_hash="$(hash_file "$backup")"
      if contains_known_bypass "$backup"; then
        bypass_flag=1
        printf '⚠️  %s: the existing hook being adopted contains a known bypass pattern.\n' "$hook" >&2
        printf '   Preserved at %s but it will NOT be restored automatically on uninstall.\n' "$backup" >&2
      fi
      echo "📦 $hook: backed up existing hook → $backup"
    fi

    install_bytes "$rendering" "$target"
    write_manifest "$hook" "$target" "$new_hash" "$backup" "$backup_hash" "$prev_cfg" "$bypass_flag"
    echo "✅ $hook: installed managed shim → $target"
  done
}

# ── uninstall preflight (nothing is removed before this passes) ──────────────

preflight_uninstall() {
  local hook target manifest cur expected backup recorded_bh bypass
  for hook in "${HOOKS[@]}"; do
    target="$HOOKS_DIR/$hook"
    manifest="$(manifest_path "$hook")"
    if [ ! -e "$target" ] && [ ! -L "$target" ]; then
      continue
    fi
    if [ -L "$target" ]; then
      refuse "Refusing to uninstall '$target': it is a symlink this installer did not create. Nothing was changed."
    fi
    if ! has_marker "$target"; then
      refuse "Refusing to uninstall '$target': it is not a hook installed by this installer (no marker). Nothing was changed."
    fi
    cur="$(hash_file "$target")"
    expected="$(manifest_get "$manifest" installed_sha256)"
    if [ -z "$expected" ]; then
      expected="$(render_shim_hash "$hook")"
    fi
    if [ "$cur" != "$expected" ]; then
      cat >&2 <<EOF
❌ Refusing to uninstall '$hook': '$target' was modified after installation.
   recorded: $expected
   current:  $cur
   Someone or something changed the installed hook; this installer will not
   remove or replace it. Inspect it and delete it yourself if that is intended.
   Nothing was changed.
EOF
      exit 3
    fi
    backup="$(manifest_get "$manifest" backup)"
    if [ -n "$backup" ]; then
      if [ ! -e "$backup" ]; then
        refuse "Refusing to uninstall '$hook': the recorded backup '$backup' is missing. Nothing was changed."
      fi
      recorded_bh="$(manifest_get "$manifest" backup_sha256)"
      if [ -n "$recorded_bh" ] && [ "$(hash_file "$backup")" != "$recorded_bh" ]; then
        refuse "Refusing to uninstall '$hook': backup '$backup' no longer matches the recorded hash. Nothing was changed."
      fi
      bypass="$(manifest_get "$manifest" backup_contains_known_bypass)"
      if [ "$bypass" = "1" ] || contains_known_bypass "$backup"; then
        refuse "Refusing to auto-restore '$backup' for $hook: it contains a known security bypass
   (COMMANDER_SKIP_PRECOMMIT / COMMANDER_SKIP_PREPUSH / equivalent).
   Restoring it would silently re-enable a bypassable gate. The managed shim
   stays installed and nothing was changed. If you really want that file back,
   move it yourself:
     mv '$backup' '$target'"
      fi
    fi
  done
}

do_uninstall() {
  local hook target manifest backup legacy
  for hook in "${HOOKS[@]}"; do
    target="$HOOKS_DIR/$hook"
    manifest="$(manifest_path "$hook")"
    if [ ! -e "$target" ]; then
      echo "ℹ️  $hook: no managed hook at $target — nothing to uninstall."
      continue
    fi
    backup="$(manifest_get "$manifest" backup)"
    if [ -n "$backup" ] && [ -e "$backup" ]; then
      mv -f "$backup" "$target"
      echo "✅ $hook: restored the pre-install hook from $backup → $target"
    else
      rm -f "$target"
      echo "✅ $hook: removed managed shim $target (no pre-install hook to restore)."
    fi
    rm -f "$manifest"
  done

  # Legacy `*.bak.<timestamp>` backups from older installer versions are left in
  # place and NEVER auto-restored: the old code restored the newest one blindly,
  # which could resurrect a hook with COMMANDER_SKIP_PRECOMMIT=1.
  while IFS= read -r legacy; do
    [ -n "$legacy" ] || continue
    if contains_known_bypass "$legacy"; then
      echo "⚠️  Left legacy bypassable backup untouched (NOT restored): $legacy"
    else
      echo "ℹ️  Left legacy backup untouched (never auto-restored): $legacy"
    fi
  done < <(find "$HOOKS_DIR" -maxdepth 1 -type f -name '*.bak.*' 2>/dev/null || true)
}

# ── run ──────────────────────────────────────────────────────────────────────

if [ "$MODE" = "uninstall" ]; then
  TMPDIR_RUN="$(mktemp -d "${TMPDIR:-/tmp}/commander-hooks-uninstall.XXXXXX")"
  trap 'rm -rf "$TMPDIR_RUN"' EXIT
  preflight_uninstall
  do_uninstall
  cat <<'EOF'

⚠️  Local protection is reduced: those git hooks no longer run.
    Local hooks were never a hard security boundary — any user who controls this
    checkout can skip or delete them. The hard guarantee is server-side branch
    protection with required status checks that CI actually runs.
EOF
  exit 0
fi

preflight_install
TMPDIR_RUN="$(mktemp -d "${TMPDIR:-/tmp}/commander-hooks-install.XXXXXX")"
trap 'rm -rf "$TMPDIR_RUN"' EXIT
do_install

cat <<EOF

All D3 hooks are now managed shims delegating to the version-controlled .githooks:
  • pre-commit → $SOURCE_HOOKS_DIR/pre-commit → scripts/precommitHook.ts  (security: scanner + ExecPolicy smoke)
  • pre-push   → $SOURCE_HOOKS_DIR/pre-push   → scripts/prepushHook.ts    (style:    Prettier baseline check)

Re-run this script to refresh the shims; --uninstall removes them and restores any
hook this installer backed up (never a backup containing a known bypass).

⚠️  Local hooks are NOT a hard security boundary. Anyone who controls this checkout
    can bypass them (git commit --no-verify, git config --unset core.hooksPath,
    deleting the shim). The hard guarantee is server-side: branch protection with
    required status checks that CI actually runs. Do not treat the local pre-commit
    security gate as the only control.

The pre-push style gate has one logged emergency skip:
  COMMANDER_SKIP_PREPUSH=1 git push origin master
The pre-commit security gate has no environment bypass — but that is a property of
the hook script, not a boundary that stops a local user from removing the hook.

Run the same gates in CI without git via:
  CORE_PRECOMMIT_HOOK=1 pnpm exec tsx scripts/precommitHook.ts <files…>
  CORE_PREPUSH_HOOK=1   pnpm exec tsx scripts/prepushHook.ts
EOF
