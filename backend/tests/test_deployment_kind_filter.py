"""Which deployments a dropdown may offer, per consumer. Azure-free, pure filter.

Every item below is VERBATIM from the real project deployments API (swedencentral, 2026-10-05).
That matters more than usual here, because the shape is the whole point: the API returns **no
positive "realtime" capability**. Across all 18 deployments on that resource the only capability
keys that ever appear are ``chat_completion``, ``completion`` and ``embeddings``, and a realtime
deployment is indistinguishable from "neither chat nor embeddings". Inventing a ``realtime: true``
flag in a
fixture would make these tests pass while the product kept showing an empty dropdown.

That empty dropdown was the actual bug: the BYOM voice model reused the chat-only list, so the two
live-verified realtime deployments (``gpt-realtime-1.5`` / ``gpt-realtime-2.1``, both ACCEPTED under
``byom-azure-openai-realtime``) could not be selected at all, making that profile unreachable from
the UI.
"""

from app.api.admin_config import DEPLOYMENT_KINDS, _deployment_options

# Verbatim payload items (trimmed to the fields the filter reads).
CHAT = {
    "name": "gpt-5-mini",
    "modelName": "gpt-5-mini",
    "modelPublisher": "OpenAI",
    "capabilities": {"chat_completion": "true", "completion": "false"},
}
CHAT2 = {
    "name": "gpt-5.4-mini",
    "modelName": "gpt-5.4-mini",
    "modelPublisher": "OpenAI",
    "capabilities": {"chat_completion": "true", "completion": "false"},
}
REALTIME_15 = {
    "name": "gpt-realtime-1.5",
    "modelName": "gpt-realtime-1.5",
    "modelPublisher": "OpenAI",
    "capabilities": {"chat_completion": "false", "completion": "false"},
}
REALTIME_21 = {
    "name": "gpt-realtime-2.1",
    "modelName": "gpt-realtime-2.1",
    "modelPublisher": "OpenAI",
    "capabilities": {"chat_completion": "false", "completion": "false"},
}
EMBEDDING = {
    "name": "text-embedding-3-large",
    "modelName": "text-embedding-3-large",
    "modelPublisher": "OpenAI",
    "capabilities": {"embeddings": "true"},
}
# The resource's image deployment: capabilities is an EMPTY object, not "chat_completion: false".
# That structural difference is what separates it from a realtime deployment, and missing it made
# the live endpoint offer gpt-image-2-1 under the realtime profile.
IMAGE = {"name": "gpt-image-2-1", "modelName": "gpt-image-2", "capabilities": {}}
UNNAMED = {"modelName": "orphan", "capabilities": {"chat_completion": "true"}}

ALL = [CHAT, CHAT2, REALTIME_15, REALTIME_21, EMBEDDING, IMAGE, UNNAMED]


def values(kind: str) -> list[str]:
    return [o.value for o in _deployment_options(ALL, kind)]


def test_chat_is_the_default_and_excludes_realtime_and_embeddings():
    # judge / scoring / the Foundry agent address models by deployment name and need a CHAT one.
    assert values("chat") == ["gpt-5-mini", "gpt-5.4-mini"]
    assert [o.value for o in _deployment_options(ALL)] == values("chat")


def test_realtime_finds_the_realtime_deployments_without_a_realtime_flag():
    # The regression guard: these two must be offerable, and they carry no positive flag.
    assert values("realtime") == ["gpt-realtime-1.5", "gpt-realtime-2.1"]
    for item in (REALTIME_15, REALTIME_21):
        assert "realtime" not in str(item["capabilities"]).lower(), (
            "fixture must keep the REAL shape — a realtime deployment advertises no realtime "
            "capability, which is exactly why the filter is negative"
        )


def test_realtime_excludes_embeddings_and_images_not_just_non_chat():
    # Negative identification is the only option, so it must rule out the other non-chat kinds. The
    # image one is the subtle case: it is excluded by DECLARING no capabilities at all, which is why
    # the filter requires the chat_completion key to be present and false.
    assert "text-embedding-3-large" not in values("realtime")
    assert "gpt-image-2-1" not in values("realtime")
    assert values("realtime") == ["gpt-realtime-1.5", "gpt-realtime-2.1"]


def test_all_is_what_the_anthropic_profile_uses():
    # No filter is invented for Claude: this tenant cannot deploy one, so there is nothing to
    # measure, and a wrong guess would empty the dropdown — the very bug being fixed. Too wide is
    # recoverable (the save-time probe rejects a bad pairing); too narrow is not.
    assert values("all") == [
        "gpt-5-mini",
        "gpt-5.4-mini",
        "gpt-realtime-1.5",
        "gpt-realtime-2.1",
        "text-embedding-3-large",
        "gpt-image-2-1",
    ]


def test_unnamed_items_are_dropped_everywhere():
    # The dropdown's value IS the deployment name; an item without one cannot be selected.
    for kind in DEPLOYMENT_KINDS:
        assert all(v for v in values(kind))


def test_an_older_payload_without_capabilities_still_fills_the_chat_dropdown():
    # Older API shape: rather than an empty dropdown, fall back to listing what came back.
    legacy = [{"name": "gpt-4o", "modelName": "gpt-4o"}]
    assert [o.value for o in _deployment_options(legacy, "chat")] == ["gpt-4o"]


def test_labels_carry_the_underlying_model():
    # Two deployments can point at the same model (the resource has gpt-4o-mini and
    # gpt-4o-mini-2), so the label has to disambiguate.
    labels = {o.value: o.label for o in _deployment_options(ALL, "all")}
    assert labels["gpt-realtime-1.5"] == "gpt-realtime-1.5 (gpt-realtime-1.5)"
