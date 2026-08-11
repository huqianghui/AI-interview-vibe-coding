"""Checklist draft shaping + validation (SPEC F3) — pure, provider-agnostic, CI-tested.

The AI-drafting service hands the LLM an SOP + a question and gets back candidate rubric items.
LLM output is untrusted shape, so this module owns the gate that turns it into persistable items:

- keep only items with a valid ``kind`` (``required`` / ``recommended`` / ``forbidden``) and text;
- normalize weights so a checklist's weights **sum to exactly 100** (F3 AC #3) — proportionally
  when weights are given, evenly when they're missing, with the rounding remainder folded into the
  last item so the total is exactly 100 (never 99/101);
- carry each item's SOP source (``source_quote`` / ``source_document_id`` / ``source_page``).

Pure functions, no LLM and no DB — the drafting service (which does call the LLM + write rows)
composes these, so the invariant the demo leans on (weights sum to 100, every item
source-attributed) is verified without any Azure call.
"""

from dataclasses import dataclass, field

from app.models.checklist import CHECKLIST_ITEM_KINDS


@dataclass
class DraftItem:
    kind: str
    text: str
    weight: int = 0
    source_quote: str = ""
    source_document_id: str | None = None
    source_page: str | None = None
    order_index: int = 0


@dataclass
class ChecklistDraft:
    prompt_version: str
    items: list[DraftItem] = field(default_factory=list)


def _coerce_weight(raw: object) -> float:
    try:
        w = float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0
    return w if w > 0 else 0.0


def normalize_weights(items: list[DraftItem]) -> list[DraftItem]:
    """Scale item weights so they sum to exactly 100 (integers), preserving relative proportions.

    Only ``required`` / ``recommended`` items carry score weight; ``forbidden`` items are gates
    (a triggered forbidden item forces ``violated`` in F4) and always get weight 0 — they don't
    consume the 100-point budget. When no weighted item has a positive weight, distribute evenly.
    Returns the same list (weights mutated); a checklist with no weighted items is left untouched.
    """
    weighted = [it for it in items if it.kind in ("required", "recommended")]
    for it in items:
        if it.kind == "forbidden":
            it.weight = 0
    if not weighted:
        return items

    raw = [_coerce_weight(it.weight) for it in weighted]
    total = sum(raw)
    if total <= 0:
        # No usable weights → even split.
        raw = [1.0] * len(weighted)
        total = float(len(weighted))

    # Proportional scale to 100, floor each, then hand the remainder to the largest items so the
    # sum is exactly 100 (largest-remainder method — avoids 99/101 rounding drift).
    scaled = [w / total * 100 for w in raw]
    floors = [int(s) for s in scaled]
    remainder = 100 - sum(floors)
    # Order items by fractional part descending; give +1 to the top `remainder` of them.
    order = sorted(range(len(weighted)), key=lambda i: scaled[i] - floors[i], reverse=True)
    for i in order[:remainder]:
        floors[i] += 1
    for it, w in zip(weighted, floors, strict=True):
        it.weight = w
    return items


def parse_draft_items(
    raw_items: list[dict],
    *,
    source_document_id: str | None = None,
) -> list[DraftItem]:
    """Turn raw LLM item dicts into validated :class:`DraftItem`s (invalid ones dropped).

    Each raw item may carry ``kind`` / ``text`` / ``weight`` / ``source_quote`` / ``source_page``.
    Items missing a valid kind or non-empty text are dropped (never persisted). Weights are NOT
    normalized here — call :func:`normalize_weights` after, so the caller can add/derive items
    first. ``order_index`` is assigned by surviving order.
    """
    items: list[DraftItem] = []
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        kind = str(raw.get("kind", "")).strip().lower()
        text = str(raw.get("text", "")).strip()
        if kind not in CHECKLIST_ITEM_KINDS or not text:
            continue
        items.append(
            DraftItem(
                kind=kind,
                text=text,
                weight=int(_coerce_weight(raw.get("weight"))),
                source_quote=str(raw.get("source_quote", "")).strip(),
                source_document_id=source_document_id,
                source_page=(str(raw["source_page"]) if raw.get("source_page") else None),
                order_index=len(items),
            )
        )
    return items


def gate_source_citations(items: list[DraftItem]) -> list[DraftItem]:
    """Strip a half-attributed SOP citation so no partial claim ships to the report (Phase 5).

    The drafting LLM's ``source_quote`` / ``source_page`` are untrusted. Reusing the F1 strict
    full-field gate (:func:`app.services.agents.citations.shape_citations`), a citation is kept only
    when BOTH quote and page are present and truthy; a partial pair (the hallucination-shaped case,
    e.g. a quote with no page) has both fields — and ``source_document_id`` — cleared.

    The item itself is NEVER dropped: an item with neither field is a legitimate unsourced item (a
    recommended point with no SOP anchor), and dropping items would silently reduce checklist
    coverage against the P7 "never under-count" spirit. Only the attribution is stripped. Mutates
    and returns the same list.
    """
    from app.services.agents.citations import shape_citations

    for it in items:
        ref = [{"sourceData": {"quote": it.source_quote, "page": it.source_page}}]
        if not shape_citations(ref, required_fields=("quote", "page")):
            it.source_quote = ""
            it.source_page = None
            it.source_document_id = None
    return items


def fallback_items_from_points(expected_points: tuple[str, ...]) -> list[DraftItem]:
    """Build required items from ``expected_points`` when the LLM yields nothing usable.

    Keeps the drafting flow deterministic + useful with zero Azure: each expected point becomes a
    ``required`` item (weights normalized to 100 by the caller). Empty points → empty list (the
    caller then persists a checklist with no items, which the API surfaces as needs-authoring).
    """
    return [
        DraftItem(kind="required", text=point, order_index=i)
        for i, point in enumerate(p for p in expected_points if p and p.strip())
    ]


def weights_sum(items: list[DraftItem]) -> int:
    """Total weight across items (should be 100 after normalization, or 0 if unweighted)."""
    return sum(it.weight for it in items)
