#!/usr/bin/env python3
"""Normalize Kazumi rule JSON and verify kazumi:// base64 payloads."""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import re
import sys
from pathlib import Path
from typing import Any


CORE_FIELDS = (
    "api",
    "type",
    "name",
    "version",
    "baseURL",
    "searchURL",
    "searchList",
    "searchName",
    "searchResult",
    "chapterRoads",
    "chapterResult",
)

XPATH_FIELDS = (
    "searchList",
    "searchName",
    "searchResult",
    "chapterRoads",
    "chapterResult",
)

UNSUPPORTED_XPATH_PATTERNS = (
    (re.compile(r"\bcontains\s*\(", re.I), "contains() is not Kazumi-compatible; use [@attr*='value'] or [@attr~='value']"),
    (re.compile(r"\bstarts-with\s*\(", re.I), "starts-with() is not Kazumi-compatible; use [@attr^='value']"),
    (re.compile(r"\bnormalize-space\s*\(", re.I), "normalize-space() is not supported"),
    (re.compile(r"\bsubstring\s*\(", re.I), "substring() is not supported"),
    (re.compile(r"\bstring\s*\(", re.I), "string() is not supported"),
    (re.compile(r"\blast\s*\(", re.I), "last() is not supported"),
    (re.compile(r"\btext\s*\(", re.I), "text() predicates are not supported"),
    (re.compile(r"\band\b", re.I), "boolean and is not supported; choose one stable attribute"),
    (re.compile(r"\bor\b", re.I), "boolean or is not supported; choose one stable path"),
    (re.compile(r"\|"), "XPath union is not supported"),
    (re.compile(r"::"), "XPath axes such as following-sibling:: or ancestor:: are not supported"),
    (re.compile(r"(^|/)\.\.($|/)"), "parent traversal ../ is not supported"),
)


class RuleCodecError(ValueError):
    """Raised when a rule or encoded payload is invalid."""


def compact_json_bytes(rule: dict[str, Any]) -> bytes:
    return json.dumps(rule, ensure_ascii=False, separators=(",", ":"), sort_keys=False).encode("utf-8")


def pretty_json(rule: dict[str, Any]) -> str:
    return json.dumps(rule, ensure_ascii=False, indent=2)


def encode_rule(rule: dict[str, Any]) -> str:
    return base64.b64encode(compact_json_bytes(rule)).decode("ascii")


def import_link(rule: dict[str, Any]) -> str:
    return "kazumi://" + encode_rule(rule)


def decode_payload(payload: str) -> dict[str, Any]:
    raw = payload.strip()
    if raw.startswith("kazumi://"):
        raw = raw[len("kazumi://") :]
    raw = "".join(raw.split())

    padding = "=" * (-len(raw) % 4)
    try:
        decoded = base64.b64decode(raw + padding, validate=True)
    except binascii.Error as exc:
        raise RuleCodecError(f"base64 decode failed: {exc}") from exc

    try:
        value = json.loads(decoded.decode("utf-8"))
    except UnicodeDecodeError as exc:
        raise RuleCodecError("base64 payload is not UTF-8 JSON") from exc
    except json.JSONDecodeError as exc:
        raise RuleCodecError(f"base64 payload is not valid JSON: {exc}") from exc
    return require_rule_object(value)


def require_rule_object(value: Any) -> dict[str, Any]:
    if isinstance(value, list):
        raise RuleCodecError("Kazumi rule must be a single JSON object, not an array")
    if not isinstance(value, dict):
        raise RuleCodecError("Kazumi rule must decode to a JSON object")
    return value


def load_rule(source: str) -> dict[str, Any]:
    text = sys.stdin.read() if source == "-" else _read_source(source)
    stripped = text.strip()
    if not stripped:
        raise RuleCodecError("empty input")

    if stripped.startswith("kazumi://"):
        return decode_payload(stripped)

    if stripped.startswith("{") or stripped.startswith("["):
        try:
            return require_rule_object(json.loads(stripped))
        except json.JSONDecodeError as exc:
            raise RuleCodecError(f"JSON parse failed: {exc}") from exc

    return decode_payload(stripped)


def _read_source(source: str) -> str:
    path = Path(source)
    if path.exists():
        return path.read_text(encoding="utf-8")
    return source


def validate_rule(rule: dict[str, Any]) -> list[str]:
    errors: list[str] = []

    missing = [field for field in CORE_FIELDS if field not in rule]
    if missing:
        errors.append("missing required fields: " + ", ".join(missing))

    if str(rule.get("type", "")) != "anime":
        errors.append('type should be "anime"')

    search_url = str(rule.get("searchURL", ""))
    if "@keyword" not in search_url:
        errors.append("searchURL must contain @keyword")

    for field in XPATH_FIELDS:
        value = rule.get(field, "")
        if value is None:
            value = ""
        if not isinstance(value, str):
            errors.append(f"{field} must be a string")
            continue
        xpath = value.strip()
        if not xpath:
            continue
        if "@keyword" in xpath:
            errors.append(f"{field} must not contain @keyword")
        if not xpath.startswith("//"):
            errors.append(f"{field} should start with //")
        for pattern, message in UNSUPPORTED_XPATH_PATTERNS:
            if pattern.search(xpath):
                errors.append(f"{field}: {message}")

    encoded = encode_rule(rule)
    decoded = decode_payload(encoded)
    if decoded != rule:
        errors.append("base64 round-trip decoded JSON does not match the input rule")

    return errors


def build_report(rule: dict[str, Any]) -> dict[str, Any]:
    encoded = encode_rule(rule)
    link = "kazumi://" + encoded
    errors = validate_rule(rule)
    return {
        "ok": not errors,
        "errors": errors,
        "name": rule.get("name"),
        "api": rule.get("api"),
        "base64": encoded,
        "importLink": link,
        "decodedMatchesInput": decode_payload(encoded) == rule,
        "payloadShape": "object",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Normalize a single Kazumi rule object and verify its kazumi:// base64 encoding.",
    )
    parser.add_argument("input", help="Rule JSON file, raw JSON, raw base64, kazumi:// link, or - for stdin")
    parser.add_argument("--output", "-o", help="Write normalized JSON object to this file")
    parser.add_argument("--link-output", help="Write kazumi:// import link to this file")
    parser.add_argument("--compact", action="store_true", help="Print compact JSON instead of pretty JSON")
    parser.add_argument("--report", action="store_true", help="Print machine-readable validation report")
    parser.add_argument("--quiet", action="store_true", help="Only print errors")
    args = parser.parse_args(argv)

    try:
        rule = load_rule(args.input)
        report = build_report(rule)
    except RuleCodecError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    json_text = (
        json.dumps(rule, ensure_ascii=False, separators=(",", ":"))
        if args.compact
        else pretty_json(rule)
    )
    link = report["importLink"]

    if args.output:
        Path(args.output).write_text(json_text + "\n", encoding="utf-8")
    if args.link_output:
        Path(args.link_output).write_text(link + "\n", encoding="utf-8")

    if report["errors"]:
        for error in report["errors"]:
            print(f"ERROR: {error}", file=sys.stderr)

    if not args.quiet:
        if args.report:
            print(json.dumps(report, ensure_ascii=False, indent=2))
        else:
            print("Normalized rule JSON:")
            print(json_text)
            print()
            print("Import link:")
            print(link)

    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
