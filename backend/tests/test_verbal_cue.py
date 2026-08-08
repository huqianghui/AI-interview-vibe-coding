"""Verbal end-of-answer cue detection tests (SPEC F6 AC #3).

Pure string logic — the guard that a cue phrase terminates an answer but is not itself scored as
answer content, and that cue-like words mid-answer are left alone.
"""

import pytest

from app.interview.verbal_cue import detect_verbal_cue, strip_verbal_cue


@pytest.mark.parametrize(
    "text",
    [
        "我答完了",
        "这就是我的回答,我答完了。",
        "That is my answer. Done.",
        "I think that covers it, I'm done",
        "...and that's all",
        "结束",
    ],
)
def test_detects_trailing_cue(text):
    assert detect_verbal_cue(text) is True


@pytest.mark.parametrize(
    "text",
    [
        "I'm done explaining the first step, then we verify the seal",  # cue-like, but mid-answer
        "The procedure is finished when the light turns green",
        "我需要先说完准备工作",
        "",
        None,
    ],
)
def test_no_cue_when_absent_or_midsentence(text):
    assert detect_verbal_cue(text) is False


def test_strip_removes_only_trailing_cue():
    assert strip_verbal_cue("这是我的回答,我答完了") == "这是我的回答,"
    assert strip_verbal_cue("Here is my answer. Done.") == "Here is my answer."


def test_strip_leaves_midsentence_cue_words_intact():
    text = "I'm done explaining step one, and step two follows"
    assert strip_verbal_cue(text) == text


def test_strip_handles_empty():
    assert strip_verbal_cue("") == ""
    assert strip_verbal_cue(None) == ""


def test_strip_of_pure_cue_is_empty():
    assert strip_verbal_cue("我答完了") == ""
    assert strip_verbal_cue("done") == ""
