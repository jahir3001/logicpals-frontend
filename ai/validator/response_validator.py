# ai/validator/response_validator.py
from __future__ import annotations

import re
from typing import List, Tuple


# ---------- Rules (simple + effective) ----------
# ACTIVE should NEVER leak:
# - full solution steps
# - final answer
# - proof / walkthrough language
ACTIVE_LEAK_PATTERNS = [
    r"\bfinal answer\b",
    r"\banswer is\b",
    r"\banswer:\b",
    r"\bsolution\b",
    r"\bfull solution\b",
    r"\bwalkthrough\b",
    r"\bstep\s*1\b",
    r"\bstep\s*2\b",
    r"\btherefore\b",
    r"\bhence\b",
    r"\bproof\b",
    r"\bderive\b",
]

ACTIVE_LEAK_REGEX = re.compile("|".join(ACTIVE_LEAK_PATTERNS), re.IGNORECASE)


def validate_ai_output(
    *,
    difficulty_tier: str,
    attempt_state: str,
    mode: str,
    ai_output: str,
) -> Tuple[bool, List[str]]:
    """
    Returns:
      (validator_pass: bool, fail_reasons: list[str])

    Goal:
      Catch "leak full solution in ACTIVE" and other obvious policy violations.
    """

    tier = (difficulty_tier or "").strip().upper()
    state = (attempt_state or "").strip().upper()
    mode_norm = (mode or "").strip().upper()
    text = (ai_output or "").strip()

    reasons: List[str] = []

    # Basic sanity
    if not text:
        reasons.append("empty_output")

    # ACTIVE: strict
    if state == "ACTIVE":
        if ACTIVE_LEAK_REGEX.search(text):
            reasons.append("active_leak_solution_or_answer_language")

        # Heuristic: too long often means full solution dump
        if len(text) > 700:
            reasons.append("active_too_long_possible_full_solution")

        # Heuristic: looks like multi-step solution formatting
        if re.search(r"(?m)^\s*(\d+[\).\]]|-\s+|\*\s+)", text):
            # Bullets/numbered steps in ACTIVE is suspicious
            reasons.append("active_stepwise_formatting")

    # REVIEW: allow full solutions; but still must be meaningful
    if state == "REVIEW":
        if len(text) < 20:
            reasons.append("review_too_short")

    # Optional: validate allowed values (non-fatal, but helpful)
    if tier not in {"WARMUP", "STANDARD", "CHALLENGE"}:
        # Don’t fail the user for tier mismatch; just add reason for debugging
        reasons.append(f"unknown_tier:{tier}")

    if mode_norm not in {"PRACTICE", "BOOTCAMP", "MIXED", "MOCK"}:
        reasons.append(f"unknown_mode:{mode_norm}")

    validator_pass = len([r for r in reasons if not r.startswith("unknown_")]) == 0
    # unknown_* are warnings, not failures
    return validator_pass, reasons
