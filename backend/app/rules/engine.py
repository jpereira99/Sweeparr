"""Pure rule engine (§6).

Evaluation is pure Python over a ``facts`` dict — no live API calls, no DB
access. This is the highest-value test surface in the project: given facts,
does the condition tree match? Deterministic and fast.

A condition tree is a JSON-serialisable boolean tree::

    {"op": "AND", "conditions": [
        {"field": "age_days", "cmp": ">=", "value": 180},
        {"op": "OR", "conditions": [...]},
    ]}
"""

from __future__ import annotations

from typing import Any

# --------------------------------------------------------------------------- #
# Field catalog (§6.1)
# --------------------------------------------------------------------------- #
# type: number | bool | string | tag ; applies: which unit kinds can use it.
FIELD_CATALOG: list[dict[str, Any]] = [
    # Age
    {
        "field": "age_days",
        "category": "Age",
        "type": "number",
        "applies": ["movie", "season", "series"],
    },
    {
        "field": "release_age_days",
        "category": "Age",
        "type": "number",
        "applies": ["movie", "season", "series"],
    },
    # Watch
    {
        "field": "last_watched_days",
        "category": "Watch",
        "type": "number",
        "applies": ["movie", "series"],
    },
    {
        "field": "total_plays",
        "category": "Watch",
        "type": "number",
        "applies": ["movie", "season", "series"],
    },
    {
        "field": "distinct_watchers",
        "category": "Watch",
        "type": "number",
        "applies": ["movie", "season", "series"],
    },
    {
        "field": "max_completion_pct",
        "category": "Watch",
        "type": "number",
        "applies": ["movie", "series"],
    },
    {
        "field": "watched_by_requester",
        "category": "Watch",
        "type": "bool",
        "applies": ["movie", "season", "series"],
    },
    {
        "field": "is_favorite_any_user",
        "category": "Watch",
        "type": "bool",
        "applies": ["movie", "series"],
    },
    # Request
    {
        "field": "was_requested",
        "category": "Request",
        "type": "bool",
        "applies": ["movie", "season", "series"],
    },
    {
        "field": "requested_days_ago",
        "category": "Request",
        "type": "number",
        "applies": ["movie", "season", "series"],
    },
    {
        "field": "requester_inactive_days",
        "category": "Request",
        "type": "number",
        "applies": ["movie", "season", "series"],
    },
    # File
    {
        "field": "size_gb",
        "category": "File",
        "type": "number",
        "applies": ["movie", "series"],
    },
    {
        "field": "quality",
        "category": "File",
        "type": "string",
        "applies": ["movie", "series"],
    },
    {
        "field": "video_resolution",
        "category": "File",
        "type": "string",
        "applies": ["movie", "series"],
    },
    # Series-level
    {
        "field": "series_status",
        "category": "Series",
        "type": "string",
        "applies": ["season", "series"],
    },
    {
        "field": "pct_episodes_watched",
        "category": "Series",
        "type": "number",
        "applies": ["season", "series"],
    },
    # Season-level
    {
        "field": "season_age_days",
        "category": "Season",
        "type": "number",
        "applies": ["season"],
    },
    {
        "field": "season_last_watched_days",
        "category": "Season",
        "type": "number",
        "applies": ["season"],
    },
    {
        "field": "pct_season_watched",
        "category": "Season",
        "type": "number",
        "applies": ["season"],
    },
    {
        "field": "season_size_gb",
        "category": "Season",
        "type": "number",
        "applies": ["season"],
    },
    {
        "field": "season_number",
        "category": "Season",
        "type": "number",
        "applies": ["season"],
    },
    {
        "field": "is_latest_season",
        "category": "Season",
        "type": "bool",
        "applies": ["season"],
    },
    # Tags
    {
        "field": "has_tag",
        "category": "Tags",
        "type": "tag",
        "applies": ["movie", "season", "series"],
    },
    {
        "field": "not_has_tag",
        "category": "Tags",
        "type": "tag",
        "applies": ["movie", "season", "series"],
    },
    # Context
    {
        "field": "disk_usage_pct",
        "category": "Context",
        "type": "number",
        "applies": ["movie", "season", "series"],
    },
    {
        "field": "library",
        "category": "Context",
        "type": "string",
        "applies": ["movie", "season", "series"],
    },
]

FIELD_TYPES = {f["field"]: f["type"] for f in FIELD_CATALOG}

# Comparison operators available per field type.
OPERATORS_BY_TYPE = {
    "number": [">=", "<=", ">", "<", "==", "!="],
    "bool": ["==", "!="],
    "string": ["==", "!=", "in", "not_in"],
    "tag": ["has", "not_has"],
}


class RuleEvalError(ValueError):
    pass


def _coerce_number(v: Any) -> float:
    if v is None:
        # A missing/None numeric fact is treated as "infinitely large" for
        # never-watched style fields so `last_watched_days >= 90` matches an
        # item that was never watched. Callers that need the opposite must
        # supply an explicit value in the facts dict.
        return float("inf")
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    return float(v)


def _apply(cmp: str, left: Any, right: Any) -> bool:
    if cmp == "has":
        tags = left or []
        return right in tags
    if cmp == "not_has":
        tags = left or []
        return right not in tags
    if cmp == "in":
        return str(left) in (right or [])
    if cmp == "not_in":
        return str(left) not in (right or [])

    # bool / string equality
    if cmp in ("==", "!="):
        if isinstance(right, bool) or isinstance(left, bool):
            l, r = bool(left), bool(right)
        elif isinstance(right, str):
            l, r = (str(left).lower() if left is not None else None), right.lower()
        else:
            l, r = _coerce_number(left), _coerce_number(right)
        return (l == r) if cmp == "==" else (l != r)

    # numeric ordering
    l, r = _coerce_number(left), _coerce_number(right)
    if cmp == ">=":
        return l >= r
    if cmp == "<=":
        return l <= r
    if cmp == ">":
        return l > r
    if cmp == "<":
        return l < r
    raise RuleEvalError(f"Unknown comparison operator: {cmp}")


def evaluate_condition(cond: dict, facts: dict[str, Any]) -> bool:
    field = cond.get("field")
    cmp = cond.get("cmp")
    value = cond.get("value")
    if field is None or cmp is None:
        raise RuleEvalError(f"Malformed condition: {cond!r}")
    return _apply(cmp, facts.get(field), value)


def evaluate_tree(node: dict, facts: dict[str, Any]) -> bool:
    """Recursively evaluate an AND/OR tree of conditions against facts."""
    if node is None:
        return False
    if "op" in node:
        op = str(node["op"]).upper()
        children = node.get("conditions", [])
        if not children:
            return False
        results = (evaluate_tree(c, facts) for c in children)
        if op == "AND":
            return all(results)
        if op == "OR":
            return any(results)
        if op == "NOT":
            return not evaluate_tree(children[0], facts)
        raise RuleEvalError(f"Unknown group operator: {op}")
    return evaluate_condition(node, facts)


def matched_snapshot(node: dict, facts: dict[str, Any]) -> dict[str, Any]:
    """Flatten every leaf condition into a snapshot of the values that were
    evaluated, plus whether each passed — the audit-gold structure surfaced by
    the "Why?" popover and QC (§7.1)."""
    out: dict[str, Any] = {}

    def walk(n: dict) -> None:
        if n is None:
            return
        if "op" in n:
            for c in n.get("conditions", []):
                walk(c)
        else:
            field = n.get("field")
            if field is None:
                return
            val = facts.get(field)
            out[field] = {
                "value": val if val != float("inf") else "never",
                "cmp": n.get("cmp"),
                "threshold": n.get("value"),
                "passed": evaluate_condition(n, facts),
            }

    walk(node)
    return out


def count_condition_matches(
    node: dict, fact_rows: list[dict[str, Any]]
) -> dict[str, int]:
    """Per-leaf selectivity: how many rows each individual condition matches.
    Powers the per-row match counts in the builder (§05)."""
    counts: dict[str, int] = {}

    def walk(n: dict) -> None:
        if n is None:
            return
        if "op" in n:
            for c in n.get("conditions", []):
                walk(c)
        else:
            key = f"{n.get('field')} {n.get('cmp')} {n.get('value')}"
            counts[key] = sum(1 for f in fact_rows if evaluate_condition(n, f))

    walk(node)
    return counts
