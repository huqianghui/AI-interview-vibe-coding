"""A cited SOP document whose file is missing is a 404 like any other unservable id, never a 500."""

import os

import pytest
from sqlalchemy import select

from app.models.sop import SopDocument
from tests.test_interview_api import (
    _complete_interview,
    _new_candidate_headers,
    _seed_question_citing_doc,
)


async def _cited_doc_of_a_finished_interview(client, db_session):
    doc_id, _name = await _seed_question_citing_doc(db_session)
    headers = await _new_candidate_headers(client)
    interview_id = await _complete_interview(client, headers)
    doc = (
        await db_session.execute(select(SopDocument).where(SopDocument.id == doc_id))
    ).scalar_one()
    return headers, interview_id, doc


@pytest.mark.asyncio
async def test_a_cited_document_with_no_stored_file_is_a_404(client, db_session):
    headers, interview_id, doc = await _cited_doc_of_a_finished_interview(client, db_session)
    doc.blob_path = ""
    await db_session.commit()

    resp = await client.get(f"/candidate/interview/{interview_id}/sop/{doc.id}", headers=headers)
    assert resp.status_code == 404
    assert resp.json() == {"detail": "Document not found"}


@pytest.mark.asyncio
async def test_a_cited_document_whose_bytes_are_gone_is_a_404(client, db_session):
    headers, interview_id, doc = await _cited_doc_of_a_finished_interview(client, db_session)
    os.remove(doc.blob_path)  # the local store's blob_path is the file itself

    resp = await client.get(f"/candidate/interview/{interview_id}/sop/{doc.id}", headers=headers)
    assert resp.status_code == 404
    assert resp.json() == {"detail": "Document not found"}
