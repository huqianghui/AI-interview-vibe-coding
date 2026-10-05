"""``build_connect_kwargs`` — which brain-attach path a session really opens.

Three paths share one ``connect()`` call and two of them share the ``model=`` slot, so the only
thing distinguishing native (path ①) from BYOM (path ②) on the wire is the ``query`` profile pair.
That makes this assembly easy to get subtly wrong and invisible when it is, hence a pure
function and these tests. ``run_proxy`` itself needs a live Azure connect and stays uncovered.

Azure-free: ``voice_live_proxy`` imports the SDK lazily inside ``run_proxy`` (same reason
``test_voice_live_plan`` needs no importorskip).
"""

from app.services.voice_live_proxy import build_connect_kwargs

BASE = {
    "endpoint": "https://x.services.ai.azure.com",
    "credential": object(),
    "api_version": "2026-01-01-preview",
    "ssl_ctx": object(),
    "project": "proj",
}


def test_native_model_path_sends_a_model_and_no_profile():
    kwargs = build_connect_kwargs(
        **BASE, is_agent=False, agent_name=None, agent_version="", default_model="gpt-5-mini"
    )
    assert kwargs["model"] == "gpt-5-mini"
    assert "query" not in kwargs, "a native session must not carry a BYOM profile"
    assert "agent_name" not in kwargs


def test_byom_path_keeps_the_deployment_in_model_and_adds_the_profile_query():
    # BYOM reuses model= for YOUR deployment name; the profile rides as a query param, which the SDK
    # maps straight onto the WebSocket URL. Measured live: gpt-5.4-mini is rejected natively and
    # accepted this way.
    kwargs = build_connect_kwargs(
        **BASE,
        is_agent=False,
        agent_name=None,
        agent_version="",
        default_model="gpt-5.4-mini",
        byom_profile="byom-azure-openai-chat-completion",
    )
    assert kwargs["model"] == "gpt-5.4-mini"
    assert kwargs["query"] == {"profile": "byom-azure-openai-chat-completion"}


def test_agent_path_never_carries_a_profile_or_a_model():
    # Path ③ has no profile concept at all — the agent's model is configured on the Foundry side.
    # Passing one here (e.g. a stale stored value) must not reach the wire.
    kwargs = build_connect_kwargs(
        **BASE,
        is_agent=True,
        agent_name="interviewer-x",
        agent_version="3",
        default_model="gpt-5-mini",
        byom_profile="byom-azure-openai-chat-completion",
    )
    assert kwargs["agent_name"] == "interviewer-x"
    assert kwargs["agent_version"] == "3"
    assert kwargs["project_name"] == "proj"
    assert "model" not in kwargs
    assert "query" not in kwargs


def test_the_transport_options_are_identical_on_every_path():
    # The certifi SSL context and api-version must not depend on which brain is attached.
    common = {"is_agent": False, "agent_name": None, "agent_version": "", "default_model": "m"}
    native = build_connect_kwargs(**BASE, **common)
    byom = build_connect_kwargs(**BASE, **common, byom_profile="byom-azure-openai-realtime")
    agent = build_connect_kwargs(
        **BASE, is_agent=True, agent_name="a", agent_version="", default_model="m"
    )
    for kwargs in (native, byom, agent):
        assert kwargs["endpoint"] == BASE["endpoint"]
        assert kwargs["api_version"] == BASE["api_version"]
        assert kwargs["connection_options"]["vendor_options"]["ssl"] is BASE["ssl_ctx"]
