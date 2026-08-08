"""Citation shaping + the strict full-field gate (SPEC F1 traceability spine).

Ported from the reference ``avatar_search_service.retrieve_citations`` gate. The Foundry IQ
/ Azure AI Search ``retrieve`` API returns ``{"references": [{"sourceData": {...}}, ...]}``;
each ``sourceData`` may carry ``title`` / ``url`` / ``page``. This module turns that raw shape
into candidate-safe citations and enforces the invariant the demo leads with:

    A citation missing ANY of title / url / page is silently dropped.

No partial citation ever leaves this layer, so the UI can never show a half-attributed claim.
A zero-length result is the "no match" signal (drives refusal upstream) — never a fabrication.

This function is pure and provider-agnostic on purpose: the live Azure call lives in the
coverage-omitted ``azure_retrieval.py`` adapter, but the gate logic is exercised in CI here.
"""

# Full set of fields a citation must carry to be candidate-visible.
REQUIRED_CITATION_FIELDS = ("title", "url", "page")
DEFAULT_MAX_CITATIONS = 3


def shape_citations(
    references: list[dict] | None, *, max_citations: int = DEFAULT_MAX_CITATIONS
) -> list[dict]:
    """Apply the strict full-field gate to raw retrieve ``references``.

    Mirrors the reference contract exactly:
    - read each ref's ``sourceData`` dict (fields are nested there, not top-level);
    - keep only refs where title AND url AND page are all present (truthy — note ``page`` 0
      is dropped, matching the reference's ``if title and url and page`` semantics);
    - preserve source order, first ``max_citations`` valid ones win;
    - return ``[]`` when nothing qualifies (the no-match signal).
    """
    if max_citations <= 0:
        return []
    citations: list[dict] = []
    for ref in references or []:
        data = ref.get("sourceData") or {}
        title, url, page = data.get("title"), data.get("url"), data.get("page")
        if title and url and page:
            citations.append({"title": title, "url": url, "page": page})
            if len(citations) == max_citations:
                break
    return citations
