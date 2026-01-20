# ai/tests/run_validator_local.py
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Tuple, Union

from ai.validator.response_validator import validate_ai_output


ROOT = Path(__file__).resolve().parents[2]
TEST_FILE = Path(__file__).resolve().parent / "fake_ai_outputs.jsonl"


def _normalize_result(result: Union[Tuple[bool, List[str]], Dict[str, Any]]) -> Tuple[bool, List[str]]:
    """
    Supports both:
      - (bool, [reasons])
      - {"pass": bool, "fail_reasons": [...]}
    """
    if isinstance(result, tuple) and len(result) == 2:
        ok = bool(result[0])
        reasons = list(result[1] or [])
        return ok, reasons

    if isinstance(result, dict):
        ok = bool(result.get("pass", False))
        reasons = result.get("fail_reasons", []) or []
        return ok, list(reasons)

    return False, ["invalid_validator_return_type"]


def main() -> None:
    if not TEST_FILE.exists():
        raise FileNotFoundError(f"Missing test file: {TEST_FILE}")

    print(f"Reading test cases from: {TEST_FILE}")

    total = 0
    correct = 0
    mismatches: List[Dict[str, Any]] = []

    with TEST_FILE.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue

            total += 1
            case = json.loads(line)

            case_id = case.get("case_id", f"line_{line_no}")
            difficulty_tier = case["difficulty_tier"]
            attempt_state = case["attempt_state"]
            mode = case["mode"]
            ai_output = case["ai_output"]
            expected_pass = bool(case["expected_pass"])

            result = validate_ai_output(
                difficulty_tier=difficulty_tier,
                attempt_state=attempt_state,
                mode=mode,
                ai_output=ai_output,
            )

            ok, reasons = _normalize_result(result)

            is_correct = (ok == expected_pass)
            if is_correct:
                correct += 1
            else:
                mismatches.append(
                    {
                        "case_id": case_id,
                        "expected_pass": expected_pass,
                        "actual_pass": ok,
                        "reasons": reasons,
                        "attempt_state": attempt_state,
                        "difficulty_tier": difficulty_tier,
                        "mode": mode,
                    }
                )

            status = "PASS" if ok else "FAIL"
            print(f"[{status}] {case_id} | expected={expected_pass} | reasons={reasons}")

    print("\n--- Summary ---")
    print(f"Total: {total}")
    print(f"Correct: {correct}")
    print(f"Mismatches: {len(mismatches)}")

    if mismatches:
        out = Path(__file__).resolve().parent / "validator_mismatches.json"
        out.write_text(json.dumps(mismatches, indent=2), encoding="utf-8")
        print(f"Saved mismatch details to: {out}")


if __name__ == "__main__":
    main()
