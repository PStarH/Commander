#!/usr/bin/env python3
"""
Random Password Generator with Configurable Character Sets
===========================================================

A robust CLI tool for generating cryptographically-secure random passwords
with full control over character composition, length, and output format.

Features:
  • Configurable character sets (uppercase, lowercase, digits, special)
  • Guaranteed inclusion of at least one character from each enabled set
  • Cryptographically secure randomness via the `secrets` module
  • Password strength estimation (entropy-based) with crack time estimates
  • Multiple password generation in a single invocation
  • Exclude ambiguous characters option (I, l, 1, O, 0)
  • Custom special character set support
  • Convenience presets (alphanumeric, digits-only, letters-only)
  • Silent/pipe-friendly output mode
  • Separator control for multi-password output

Author: deep-synthesizer-ultimate
Version: 2.0.0
License: MIT

Usage:
  python password_gen.py                      # Default: 16-char password
  python password_gen.py -l 32                # 32-character password
  python password_gen.py -l 24 -n 5           # Five 24-char passwords
  python password_gen.py --no-special         # No special characters
  python password_gen.py --digits-only        # PIN-like: digits only
  python password_gen.py --strength           # Show strength analysis
  python password_gen.py -q                   # Quiet mode (pipe-friendly)
"""

from __future__ import annotations

import argparse
import math
import random
import secrets
import string
import sys


# ─── Constants ───────────────────────────────────────────────────────────────

VERSION = "2.0.0"
DEFAULT_LENGTH = 16
DEFAULT_COUNT = 1

# Ambiguous characters that are often confused visually
AMBIGUOUS_CHARS = frozenset("Il1O0")

# Strength thresholds based on NIST guidelines and common conventions
# Entropy in bits → human-readable label
STRENGTH_THRESHOLDS: list[tuple[float, str]] = [
    (28.0,  "Very Weak"),
    (36.0,  "Weak"),
    (60.0,  "Fair"),
    (128.0, "Strong"),
    (float("inf"), "Very Strong"),
]


# ─── Password Generation ────────────────────────────────────────────────────

def build_charset(
    uppercase: bool = True,
    lowercase: bool = True,
    digits: bool = True,
    special: bool = True,
    custom_special: str | None = None,
    exclude_chars: str = "",
    no_ambiguous: bool = False,
) -> tuple[str, dict[str, str]]:
    """
    Build the character set for password generation.

    Constructs the full pool of characters from which passwords will be drawn,
    applying all filtering rules (exclusions, ambiguity removal).

    Args:
        uppercase:      Include uppercase ASCII letters (A-Z).
        lowercase:      Include lowercase ASCII letters (a-z).
        digits:         Include digits (0-9).
        special:        Include punctuation/special characters.
        custom_special: Custom string of special characters (overrides default punctuation).
        exclude_chars:  Specific characters to exclude from the pool.
        no_ambiguous:   Exclude visually ambiguous characters (I, l, 1, O, 0).

    Returns:
        A tuple of:
          - full_charset (str): Combined string of all usable characters.
          - active_sets (dict[str, str]): Mapping of set name → characters in that set.

    Raises:
        ValueError: If no character sets are enabled, or all characters are
                    empty after applying exclusions.
    """
    sets: dict[str, str] = {}
    exclude = set(exclude_chars)

    # Map logical set names to their character sources
    if uppercase:
        sets["uppercase"] = string.ascii_uppercase
    if lowercase:
        sets["lowercase"] = string.ascii_lowercase
    if digits:
        sets["digits"] = string.digits
    if special:
        if custom_special is not None:
            sets["special"] = custom_special
        else:
            sets["special"] = string.punctuation

    if not sets:
        raise ValueError(
            "At least one character set must be enabled. "
            "Use --uppercase, --lowercase, --digits, or --special."
        )

    # Build the full character set, applying all exclusion filters
    full_charset = ""
    active_sets: dict[str, str] = {}

    for name, chars in sets.items():
        filtered = chars
        # Apply explicit exclusions
        if exclude:
            filtered = "".join(c for c in filtered if c not in exclude)
        # Apply ambiguity filter
        if no_ambiguous:
            filtered = "".join(c for c in filtered if c not in AMBIGUOUS_CHARS)

        if filtered:
            active_sets[name] = filtered
            full_charset += filtered
        else:
            # Warn but don't fail — the user may have over-excluded one set
            print(
                f"Warning: Character set '{name}' is empty after exclusions.",
                file=sys.stderr,
            )

    if not full_charset:
        raise ValueError(
            "All character sets are empty after applying exclusions. "
            "Reduce --exclude or disable --no-ambiguous."
        )

    return full_charset, active_sets


def generate_password(
    length: int = 16,
    uppercase: bool = True,
    lowercase: bool = True,
    digits: bool = True,
    special: bool = True,
    custom_special: str | None = None,
    exclude_chars: str = "",
    no_ambiguous: bool = False,
) -> str:
    """
    Generate a single random password.

    Uses ``secrets.choice`` for cryptographically secure randomness, and
    guarantees at least one character from each enabled character set appears
    in the final password.

    Algorithm:
        1. Build the character pool from enabled sets.
        2. Select one guaranteed character from each active set.
        3. Fill remaining positions from the full combined pool.
        4. Shuffle securely using Fisher-Yates with a cryptographic RNG.

    Args:
        length:          Desired password length. Must be >= number of enabled sets.
        uppercase:       Include uppercase letters (A-Z).
        lowercase:       Include lowercase letters (a-z).
        digits:          Include digits (0-9).
        special:         Include special/punctuation characters.
        custom_special:  Override default special character set.
        exclude_chars:   Characters to exclude from the pool.
        no_ambiguous:    Exclude visually ambiguous characters.

    Returns:
        The generated password string.

    Raises:
        ValueError: If length is too small to guarantee one character per set,
                    or if no valid characters remain after filtering.
    """
    full_charset, active_sets = build_charset(
        uppercase=uppercase,
        lowercase=lowercase,
        digits=digits,
        special=special,
        custom_special=custom_special,
        exclude_chars=exclude_chars,
        no_ambiguous=no_ambiguous,
    )

    # Ensure password is long enough to guarantee one from each set
    num_sets = len(active_sets)
    if length < num_sets:
        raise ValueError(
            f"Password length ({length}) must be >= number of active "
            f"character sets ({num_sets}) to guarantee representation."
        )

    # Step 1: Guarantee at least one character from each active set
    password_chars: list[str] = []
    for chars in active_sets.values():
        password_chars.append(secrets.choice(chars))

    # Step 2: Fill the remaining length from the full combined character pool
    remaining = length - len(password_chars)
    for _ in range(remaining):
        password_chars.append(secrets.choice(full_charset))

    # Step 3: Shuffle using cryptographically secure randomness
    # SystemRandom uses os.urandom() under the hood
    secure_random = random.SystemRandom()
    secure_random.shuffle(password_chars)

    return "".join(password_chars)


def generate_passwords(
    count: int = 1,
    **kwargs,
) -> list[str]:
    """
    Generate multiple passwords with the same configuration.

    Args:
        count:    Number of passwords to generate.
        **kwargs: All keyword arguments are forwarded to ``generate_password()``.

    Returns:
        A list of generated password strings.
    """
    return [generate_password(**kwargs) for _ in range(count)]


# ─── Strength Analysis ──────────────────────────────────────────────────────

def calculate_entropy(length: int, charset_size: int) -> float:
    """
    Calculate the Shannon entropy of a password.

    Entropy measures the unpredictability of the password, expressed in bits.
    Formula: ``H = L × log₂(N)`` where L = length, N = charset size.

    Args:
        length:       Password length in characters.
        charset_size: Number of unique possible characters.

    Returns:
        Entropy in bits (float).
    """
    if charset_size <= 0 or length <= 0:
        return 0.0
    return length * math.log2(charset_size)


def classify_strength(entropy_bits: float) -> str:
    """
    Classify password strength based on entropy thresholds.

    Thresholds are based on commonly accepted security guidelines:
      - < 28 bits  → Very Weak  (trivially crackable)
      - < 36 bits  → Weak       (crackable in seconds)
      - < 60 bits  → Fair       (crackable with moderate resources)
      - < 128 bits → Strong     (resistant to offline attacks)
      - ≥ 128 bits → Very Strong (future-proof)

    Args:
        entropy_bits: Entropy in bits.

    Returns:
        Human-readable strength label (str).
    """
    for threshold, label in STRENGTH_THRESHOLDS:
        if entropy_bits < threshold:
            return label
    return "Very Strong"


def estimate_crack_time(entropy_bits: float) -> str:
    """
    Estimate the time to crack a password by brute force.

    Assumes an attacker capable of 10 billion guesses/second (modern GPU cluster),
    and uses the average-case scenario (half the search space).

    Args:
        entropy_bits: Entropy in bits.

    Returns:
        A human-readable time estimate (e.g., "3.2 million years").
    """
    guesses_per_second = 10_000_000_000  # 10 billion
    total_guesses = 2 ** entropy_bits
    seconds = total_guesses / guesses_per_second / 2  # Average case

    if seconds < 0.001:
        return "instantly"
    elif seconds < 1:
        return f"{seconds:.2f} seconds"
    elif seconds < 60:
        return f"{seconds:.1f} seconds"
    elif seconds < 3600:
        return f"{seconds / 60:.1f} minutes"
    elif seconds < 86400:
        return f"{seconds / 3600:.1f} hours"
    elif seconds < 86400 * 365.25:
        return f"{seconds / 86400:.1f} days"
    elif seconds < 86400 * 365.25 * 1000:
        return f"{seconds / (86400 * 365.25):.1f} years"
    elif seconds < 86400 * 365.25 * 1_000_000:
        return f"{seconds / (86400 * 365.25 * 1000):.1f} thousand years"
    elif seconds < 86400 * 365.25 * 1_000_000_000:
        return f"{seconds / (86400 * 365.25 * 1_000_000):.1f} million years"
    elif seconds < 86400 * 365.25 * 1_000_000_000_000:
        return f"{seconds / (86400 * 365.25 * 1_000_000_000):.1f} billion years"
    else:
        return "effectively infinite"


def format_strength_report(password: str, charset_size: int) -> str:
    """
    Generate a detailed, formatted strength report for a password.

    The report includes:
      - Password length and charset size
      - Entropy in bits
      - Strength classification
      - Estimated crack time (at 10B guesses/sec)
      - Character composition breakdown

    Args:
        password:     The password to analyze.
        charset_size: Size of the character set used to generate it.

    Returns:
        A multi-line formatted report string.
    """
    length = len(password)
    entropy = calculate_entropy(length, charset_size)
    strength = classify_strength(entropy)
    crack_time = estimate_crack_time(entropy)

    # Character composition analysis
    has_upper = any(c in string.ascii_uppercase for c in password)
    has_lower = any(c in string.ascii_lowercase for c in password)
    has_digit = any(c in string.digits for c in password)
    has_special = any(
        c in string.punctuation or not c.isalnum() for c in password
    )

    composition = []
    if has_upper:
        uppers = sum(1 for c in password if c in string.ascii_uppercase)
        composition.append(f"uppercase ({uppers})")
    if has_lower:
        lowers = sum(1 for c in password if c in string.ascii_lowercase)
        composition.append(f"lowercase ({lowers})")
    if has_digit:
        digits_count = sum(1 for c in password if c in string.digits)
        composition.append(f"digits ({digits_count})")
    if has_special:
        specials = sum(
            1 for c in password
            if c in string.punctuation or (not c.isalnum() and not c.isspace())
        )
        composition.append(f"special ({specials})")

    report = f"""
┌─────────────────────────────────────────────────┐
│             PASSWORD STRENGTH REPORT            │
├─────────────────────────────────────────────────┤
│ Length:           {length:>4} characters                 │
│ Charset size:     {charset_size:>4} unique characters          │
│ Entropy:          {entropy:>8.2f} bits                   │
│ Strength:         {strength:<16}               │
│ Est. crack time:  {crack_time:<24}       │
│ Composition:      {', '.join(composition):<24}       │
└─────────────────────────────────────────────────┘"""
    return report


# ─── CLI Argument Parsing ────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    """
    Build and return the argparse argument parser.

    Defines all CLI flags, grouped logically:
      - General options (length, count, version)
      - Character set toggles
      - Presets (alphanumeric, digits-only, letters-only)
      - Exclusions (exclude specific chars, ambiguous chars)
      - Output options (strength, quiet, separator)
    """
    parser = argparse.ArgumentParser(
        prog="password_gen",
        description="Generate cryptographically-secure random passwords.",
        epilog=(
            "Examples:\n"
            "  %(prog)s                              # Default 16-char password\n"
            "  %(prog)s -l 32                        # 32-character password\n"
            "  %(prog)s -l 24 -n 5                   # Five 24-char passwords\n"
            "  %(prog)s --no-special                  # No special characters\n"
            "  %(prog)s --digits-only                 # PIN-like: digits only\n"
            "  %(prog)s --letters-only                # Letters only\n"
            "  %(prog)s --exclude 'O0Il1'             # Exclude ambiguous chars\n"
            "  %(prog)s --no-ambiguous                # Auto-exclude ambiguous\n"
            "  %(prog)s --strength                    # Show strength analysis\n"
            "  %(prog)s -q                            # Quiet / pipe-friendly\n"
            "  %(prog)s --custom-special '!@#$%^&*'   # Custom special chars\n"
            "  %(prog)s -l 20 -n 10 -q | pbcopy      # Copy 10 passwords\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    # ── Version ──
    parser.add_argument(
        "-v", "--version",
        action="version",
        version=f"%(prog)s {VERSION}",
    )

    # ── Length and count ──
    parser.add_argument(
        "-l", "--length",
        type=int,
        default=DEFAULT_LENGTH,
        metavar="N",
        help=f"Password length in characters (default: {DEFAULT_LENGTH})",
    )
    parser.add_argument(
        "-n", "--count",
        type=int,
        default=DEFAULT_COUNT,
        metavar="N",
        help=f"Number of passwords to generate (default: {DEFAULT_COUNT})",
    )

    # ── Character set toggles ──
    char_group = parser.add_argument_group("character sets (disable)")
    char_group.add_argument(
        "--no-upper",
        "--no-uppercase",
        action="store_true",
        default=False,
        dest="no_uppercase",
        help="Exclude uppercase letters (A-Z)",
    )
    char_group.add_argument(
        "--no-lower",
        "--no-lowercase",
        action="store_true",
        default=False,
        dest="no_lowercase",
        help="Exclude lowercase letters (a-z)",
    )
    char_group.add_argument(
        "--no-digits",
        action="store_true",
        default=False,
        help="Exclude digits (0-9)",
    )
    char_group.add_argument(
        "--no-special",
        action="store_true",
        default=False,
        help="Exclude special/punctuation characters",
    )
    char_group.add_argument(
        "--custom-special",
        type=str,
        default=None,
        metavar="CHARS",
        help="Custom set of special characters (implies --special is enabled)",
    )

    # ── Convenience presets ──
    preset_group = parser.add_argument_group("presets")
    preset_group.add_argument(
        "--alphanumeric",
        action="store_true",
        default=False,
        help="Only letters and digits (equivalent to --no-special)",
    )
    preset_group.add_argument(
        "--digits-only",
        action="store_true",
        default=False,
        help="Only digits (useful for PINs, OTPs, verification codes)",
    )
    preset_group.add_argument(
        "--letters-only",
        action="store_true",
        default=False,
        help="Only letters (no digits or special characters)",
    )

    # ── Exclusions ──
    exclude_group = parser.add_argument_group("exclusions")
    exclude_group.add_argument(
        "--exclude",
        type=str,
        default="",
        metavar="CHARS",
        help="Specific characters to exclude from the password (e.g., 'O0Il1')",
    )
    exclude_group.add_argument(
        "--no-ambiguous",
        action="store_true",
        default=False,
        help="Exclude visually ambiguous characters (I, l, 1, O, 0)",
    )

    # ── Output options ──
    output_group = parser.add_argument_group("output")
    output_group.add_argument(
        "--strength",
        action="store_true",
        default=False,
        help="Show password strength analysis (entropy, crack time)",
    )
    output_group.add_argument(
        "-q", "--quiet",
        action="store_true",
        default=False,
        help="Quiet mode: output only the password(s), no labels or decoration",
    )
    output_group.add_argument(
        "--separator",
        type=str,
        default=None,
        metavar="SEP",
        help="Separator between multiple passwords (default: newline in quiet mode, "
             "numbered list otherwise)",
    )

    return parser


def resolve_args(args: argparse.Namespace) -> dict:
    """
    Resolve CLI arguments into keyword arguments for ``generate_password()``.

    Handles preset flags and their interactions with individual toggles.
    Presets override individual flags when in conflict.

    Args:
        args: Parsed argparse Namespace.

    Returns:
        Dict of keyword arguments suitable for ``generate_password()``.
    """
    # Start with character set flags (True = enabled)
    uppercase = not args.no_uppercase
    lowercase = not args.no_lowercase
    digits = not args.no_digits
    special = not args.no_special

    # Apply presets (these override individual flags)
    if args.digits_only:
        uppercase = False
        lowercase = False
        digits = True
        special = False
    elif args.letters_only:
        uppercase = True
        lowercase = True
        digits = False
        special = False
    elif args.alphanumeric:
        special = False

    # Custom special chars imply special=True
    if args.custom_special is not None:
        special = True

    return {
        "length": args.length,
        "uppercase": uppercase,
        "lowercase": lowercase,
        "digits": digits,
        "special": special,
        "custom_special": args.custom_special,
        "exclude_chars": args.exclude,
        "no_ambiguous": args.no_ambiguous,
    }


# ─── Main Entry Point ───────────────────────────────────────────────────────

def main() -> int:
    """
    Main entry point for the CLI.

    Parses arguments, validates configuration, generates passwords, and
    formats output according to the selected mode.

    Returns:
        Exit code: 0 on success, 1 on error.
    """
    parser = build_parser()
    args = parser.parse_args()

    # ── Validate basic constraints ──
    if args.count < 1:
        print("Error: --count must be at least 1.", file=sys.stderr)
        return 1

    if args.length < 1:
        print("Error: --length must be at least 1.", file=sys.stderr)
        return 1

    # ── Resolve configuration ──
    try:
        config = resolve_args(args)
    except Exception as e:
        print(f"Configuration error: {e}", file=sys.stderr)
        return 1

    # ── Build charset for strength analysis ──
    try:
        _, active_sets = build_charset(
            uppercase=config["uppercase"],
            lowercase=config["lowercase"],
            digits=config["digits"],
            special=config["special"],
            custom_special=config["custom_special"],
            exclude_chars=config["exclude_chars"],
            no_ambiguous=config["no_ambiguous"],
        )
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    charset_size = sum(len(chars) for chars in active_sets.values())

    # ── Generate passwords ──
    try:
        passwords = generate_passwords(count=args.count, **config)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    # ── Format and output ──
    separator = args.separator if args.separator is not None else "\n"

    if args.quiet:
        # Quiet mode: just passwords, separated as requested
        print(separator.join(passwords))

    else:
        if args.count == 1:
            # Single password: show with optional strength report
            password = passwords[0]
            if args.strength:
                print(format_strength_report(password, charset_size))
                print()
            print(f"Generated password: {password}")

        else:
            # Multiple passwords
            if args.strength:
                for i, pw in enumerate(passwords, 1):
                    print(f"Password {i}/{args.count}: {pw}")
                    print(format_strength_report(pw, charset_size))
                    print()
            else:
                print(f"Generated {args.count} passwords:\n")
                for i, pw in enumerate(passwords, 1):
                    print(f"  {i:>3}. {pw}")

    return 0


# ─── Script Entry Point ─────────────────────────────────────────────────────

if __name__ == "__main__":
    sys.exit(main())
