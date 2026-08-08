"""Citation shaping + the strict full-field gate (SPEC F1 traceability spine).

The Foundry IQ / Azure AI Search ``retrieve`` API returns
``{"references": [{"sourceData": {...}}, ...]}``. This module turns that raw shape into
candidate-safe citations and enforces the invariant the demo leads with:

    A citation missing ANY required field is silently dropped.

No partial citation ever leaves this layer, so the UI can never show a half-attributed claim.
A zero-length result is the "no match" signal (drives refusal upstream) — never a fabrication.

WHICH fields are required is configurable (``required_fields`` + ``field_map``). This is a
direct result of the F1 live spike (see docs/SPIKE-F1-foundry-iq.md): real KBs do NOT all
expose ``title``/``url``/``page`` — the fields live in a per-index ``sourceData`` schema, and a
hardcoded gate would drop 100% of a valid KB's references. We build our own SOP index, so we
map its schema to the canonical citation fields here rather than assume the reference's.

This function is pure and provider-agnostic on purpose: the live Azure call lives in the
coverage-omitted ``adapters/azure_retrieval.py``, but the gate logic is exercised in CI here.
"""

# Canonical citation fields the UI renders. Overridable per-index via ``required_fields``.
REQUIRED_CITATION_FIELDS = ("title", "url", "page")
DEFAULT_MAX_CITATIONS = 3


def shape_citations(
    references: list[dict] | None,
    *,
    required_fields: tuple[str, ...] = REQUIRED_CITATION_FIELDS,
    field_map: dict[str, str] | None = None,
    max_citations: int = DEFAULT_MAX_CITATIONS,
) -> list[dict]:
    """Apply the strict full-field gate to raw retrieve ``references``.

    - read each ref's ``sourceData`` dict (fields are nested there — and only present when the
      caller passes ``includeReferenceSourceData: true``, per the live spike);
    - for each canonical field in ``required_fields``, read ``sourceData[field_map.get(field,
      field)]``; keep the ref only if EVERY required field is present and truthy;
    - emit citations keyed by the canonical field names, preserving source order, first
      ``max_citations`` valid ones win;
    - return ``[]`` when nothing qualifies (the no-match signal).

    Truthy semantics match the reference (``if title and url and page``): a falsy value such as
    ``page`` 0 or ``""`` drops the ref. Use a ``field_map`` to point canonical names at a KB's
    actual ``sourceData`` field names (e.g. ``{"url": "source", "page": "product_model"}``).
    """
    if max_citations <= 0:
        return []
    field_map = field_map or {}
    citations: list[dict] = []
    for ref in references or []:
        data = ref.get("sourceData") or {}
        citation: dict = {}
        complete = True
        for field in required_fields:
            value = data.get(field_map.get(field, field))
            if not value:
                complete = False
                break
            citation[field] = value
        if complete:
            citations.append(citation)
            if len(citations) == max_citations:
                break
    return citations
