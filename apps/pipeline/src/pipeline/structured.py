"""Evaluate imported structured candidate results without network access."""

import json

from jsonschema import SchemaError, ValidationError, validate

from pipeline.snapshot import build_snapshot, match_candidate_results


def _check(name, status, detail=None):
    result = {"name": name, "status": status}
    if detail:
        result["detail"] = detail
    return result


def _parse_output(output_text):
    try:
        parsed = json.loads(output_text)
    except (TypeError, ValueError):
        return None, _check("parse", "fail", "output is not valid JSON")
    if not isinstance(parsed, (dict, list)):
        return None, _check("parse", "fail", "structured output must be an object or array")
    return parsed, _check("parse", "pass")


def _schema_check(parsed, checks):
    schema = checks.get("schema")
    if schema is None:
        return _check("schema", "not_applicable"), None
    if not isinstance(schema, dict):
        return (
            _check("schema", "not_applicable", "named schemas are unavailable offline"),
            "insufficient_evidence",
        )
    try:
        validate(parsed, schema)
    except ValidationError as error:
        return _check("schema", "fail", error.message), "schema_mismatch"
    except SchemaError as error:
        raise ValueError(f"invalid inline schema: {error.message}") from error
    return _check("schema", "pass"), None


def _required_fields_check(parsed, checks):
    required_fields = checks.get("required_fields")
    if required_fields is None:
        return _check("required_fields", "not_applicable"), None
    if not isinstance(required_fields, list):
        raise ValueError("required_fields must be a list")
    missing = [
        field for field in required_fields if not isinstance(parsed, dict) or field not in parsed
    ]
    if missing:
        return (
            _check("required_fields", "fail", f"missing fields: {', '.join(missing)}"),
            "missing_required_fields",
        )
    return _check("required_fields", "pass"), None


def _evaluate_result(case, result):
    evidence_refs = sorted(set(result.get("evidence_refs", [])))
    duration_ms = result.get("duration_ms")
    checks = []
    failure_code = None
    abstention_reason = None
    evidence_type = "abstain"
    evaluator = "abstain"

    if case["risk"] == "high":
        terminal_verdict = "abstain"
        abstention_reason = "high_risk_case"
    elif not evidence_refs:
        terminal_verdict = "abstain"
        abstention_reason = "missing_evidence"
    elif case["required_evidence"] == "abstain":
        terminal_verdict = "abstain"
        abstention_reason = "case_requires_abstention"
    else:
        evidence_type = "deterministic"
        evaluator = "structured-check"
        parsed, parse_check = _parse_output(result["output_text"])
        checks.append(parse_check)
        if parse_check["status"] == "fail":
            terminal_verdict = "fail"
            failure_code = "invalid_json"
        else:
            schema_check, schema_failure = _schema_check(parsed, case["checks"])
            checks.append(schema_check)
            required_check, required_failure = _required_fields_check(parsed, case["checks"])
            checks.append(required_check)
            failure_code = schema_failure or required_failure
            if failure_code:
                terminal_verdict = (
                    "fail"
                    if schema_check["status"] == "fail" or required_check["status"] == "fail"
                    else "abstain"
                )
                abstention_reason = (
                    "insufficient_evidence" if terminal_verdict == "abstain" else None
                )
            else:
                terminal_verdict = "pass"

    return {
        "case_id": case["case_id"],
        "pipeline_family": case["pipeline_family"],
        "split": case["split"],
        "terminal_verdict": terminal_verdict,
        "evidence_type": evidence_type,
        "evaluator": evaluator,
        "checks": checks,
        "failure_code": failure_code,
        "abstention_reason": abstention_reason,
        "timing": {
            "availability": "available" if duration_ms is not None else "unavailable",
            "duration_ms": duration_ms,
        },
        "cost_usd": result["cost_usd"],
        "evidence_refs": evidence_refs,
        "reference": None,
    }


def _missing_result(case):
    return {
        "case_id": case["case_id"],
        "pipeline_family": case["pipeline_family"],
        "split": case["split"],
        "terminal_verdict": "abstain",
        "evidence_type": "abstain",
        "evaluator": "abstain",
        "checks": [],
        "failure_code": None,
        "abstention_reason": "missing_candidate_result",
        "timing": {"availability": "unavailable", "duration_ms": None},
        "cost_usd": 0,
        "evidence_refs": [],
        "reference": None,
    }


def evaluate_structured_candidates(corpus, candidate_bundle):
    cases, results_by_case = match_candidate_results(corpus, candidate_bundle, "structured-check")

    verdicts = [
        _evaluate_result(case, results_by_case[case["case_id"]])
        if case["case_id"] in results_by_case
        else _missing_result(case)
        for case in cases
    ]
    return build_snapshot(corpus, candidate_bundle, verdicts)
