"""Session-memory follow-up synthesis (SPEC F7) — pure, no LLM/DB."""

from app.interview.memory import build_follow_up_prompt

BASE = "Can you walk me through that in a bit more detail?"


def test_follow_up_cites_prior_answer_en():
    out = build_follow_up_prompt(BASE, "I automated the nightly deploy pipeline.", locale="en-US")
    assert "I automated the nightly deploy pipeline." in out
    assert BASE in out
    assert out.startswith("You mentioned")


def test_follow_up_cites_prior_answer_zh():
    out = build_follow_up_prompt(BASE, "我负责了夜间部署流水线的自动化。", locale="zh-CN")
    assert "我负责了夜间部署流水线的自动化。" in out
    assert BASE in out
    assert out.startswith("你刚才提到")


def test_long_answer_is_snippeted():
    long_answer = "word " * 100
    out = build_follow_up_prompt(BASE, long_answer, locale="en-US")
    assert "…" in out
    assert BASE in out


def test_empty_prior_answer_falls_back_to_base():
    assert build_follow_up_prompt(BASE, "", locale="en-US") == BASE
    assert build_follow_up_prompt(BASE, "   ", locale="zh-CN") == BASE


def test_whitespace_is_collapsed_in_snippet():
    out = build_follow_up_prompt(BASE, "line one\n\n  line two", locale="en-US")
    assert "line one line two" in out
