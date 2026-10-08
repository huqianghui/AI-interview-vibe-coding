# Spec: rubric versioning (pinned at assignment and at interview start)

Owner decisions, 2026-10-08:

- Every change to a bank's rubric produces an **immutable version**.
- Assigning a bank to a user **defaults to that bank's latest version**; the admin may pick another.
- An interview **pins its version at start**; scoring, the coverage audit and the SOP-citation
  guard read only that version. Re-scoring an old interview therefore reproduces its original
  standard.
- Fixed in the same change: saving a rubric in the admin editor dropped every item's
  `source_document_id` and `advisory` flag.

## Why

Before this change the rubric was edited in place and every reader used the question's current
`is_default` checklist (`scoring_service.py`, `sop_coverage.py`, `state_machine.cited_document_ids`,
`judge_flow.py`). Editing a rubric therefore re-scored every old interview on the next re-score,
and could make an old report's SOP link answer 404 (the citation guard reads the rubric too).

And the editor round-trip carried neither `source_document_id` nor `advisory`
(`ChecklistItemIn`, frontend `ChecklistItem`), so one save of an imported rf-CSM rubric:

- removed every clickable SOP link (and the SOP passage the scorer reads beside each item);
- turned every advisory forbidden item ("Disclosure: … does not reduce the score") into a scored
  one, which **changes scores**.

## Model

| Table | Change |
|---|---|
| `rubric_versions` (new) | `id`, `bank_id` → `question_banks` (CASCADE), `version_no` (unique per bank), `content_json`, `content_hash`, `reason` (`initial` / `edit` / `draft` / `import`), `created_by`, timestamps |
| `users` | `assigned_rubric_version_id` → `rubric_versions` (SET NULL) |
| `interview_sessions` | `rubric_version_id` → `rubric_versions` (SET NULL) |

`content_json` is the bank's whole rubric at that moment, keyed by question id:

```json
{"questions": {"<question_id>": [
  {"kind": "required", "text": "…", "weight": 25, "advisory": false,
   "source_quote": "…", "source_document_id": "…", "source_page": "4.2", "order_index": 0}
]}}
```

The version is per **bank**, not per question: a user is assigned a bank, so the thing they are
assigned is the bank's rubric as a whole. The `checklists` / `checklist_items` tables stay the
editable working copy. A version is a frozen copy of it.

## When a version is created

`rubric_version_service.snapshot(bank_id, reason)` builds the content from the bank's current
default checklists. **It does not create a version when the content hash equals the latest
version's**, so an idempotent re-save or re-import adds nothing. Callers:

- the editor saving items (`checklist_service.update_items`) → `edit`
- an AI draft becoming the default (`checklist_service._persist_draft`) → `draft`
- a bank bundle import (`bank_bundle_service`) → `import`
- the migration, once for every existing bank → `initial`

A concurrent snapshot that loses the `(bank_id, version_no)` race retries once on the new latest.

## Which version an interview uses

At start (`assignment_service.resolve_for_candidate`):

1. the user's `assigned_rubric_version_id`, **if it belongs to the bank the interview starts on**;
2. otherwise the latest version of that bank (created on the spot if the bank has none).

The result is written to `interview_sessions.rubric_version_id`. A restart starts a new session and
resolves again.

Assignment (`PUT /admin/users/{id}/assignment`): a `bank_id` with no `rubric_version_id` stores the
bank's latest version (the "default" the owner asked for). A `rubric_version_id` must belong to
that bank, or the request gets a 422. Clearing the bank clears the version.

## Readers

All four read `session.rubric_version_id` first. A session with no version is a legacy one, from
before this change, and keeps today's behaviour (the current default checklist):

- `scoring_service.prepare_scoring`
- `sop_coverage` (the opt-in coverage audit)
- `state_machine.cited_document_ids` (the IDOR guard behind the report's SOP links)
- `judge_flow.judge`

## Editor fix

`source_document_id` and `advisory` are carried both ways: in `ChecklistItemOut` and
`ChecklistItemIn`, and preserved by the frontend editor. A `source_document_id` that names no SOP
document is cleared on save rather than stored. A client that omits the field entirely (a stale
tab running the old bundle) keeps the id of the existing item with the same text and quote, so an
old tab cannot strip links either.

## API

- `GET /admin/question-banks/{bank_id}/rubric-versions`: newest first, with `version_no`,
  `created_at`, `reason`, `question_count`, `is_latest`.
- `PUT /admin/users/{id}/assignment` accepts `rubric_version_id`.
- `AdminUserResponse` gains `assigned_rubric_version_id` and `assigned_rubric_version_no`.
- The admin interview list and detail gain `rubric_version_no`.

## UI

- **Users tab**: next to the bank picker, a version picker for that bank (`v3 · 2026-10-08 ·
  latest`). It resets to the latest when the bank changes.
- **Rubric editor**: shows the version the last save produced.
- **Interview results**: shows which version an interview was scored against.

## Out of scope

- Versioning the question TEXT. Questions are still edited in place; a version freezes only the
  rubric.
- Re-scoring an old interview against a newer version (an explicit button was discussed and not
  chosen).
- A diff view between versions.
