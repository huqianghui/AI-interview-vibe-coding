"""Azure endpoint URL helpers for the Voice Live broker (SPEC F9).

Pure string transforms — no network, fully CI-tested. The one that has bitten this integration
in the reference project is :func:`to_cognitive_services_endpoint`: Voice Live's realtime
signaling path lives on the ``*.cognitiveservices.azure.com`` host, and an AI Foundry
``*.services.ai.azure.com`` endpoint returns 404 for it. The STS token-exchange call must also
hit the cognitiveservices host, so both the broker and the token exchange normalize through here.
"""

import re


def to_cognitive_services_endpoint(endpoint: str) -> str:
    """Normalize an AI Foundry endpoint to its Cognitive Services form for Voice Live.

    ``https://foo.services.ai.azure.com/`` → ``https://foo.cognitiveservices.azure.com/``.
    Endpoints already on ``cognitiveservices`` / ``openai`` hosts pass through unchanged.
    """
    return re.sub(r"\.services\.ai\.azure\.com", ".cognitiveservices.azure.com", endpoint)


def endpoint_host(endpoint: str) -> str:
    """Return the bare host of ``endpoint`` (scheme + path stripped), for building a ``wss://`` URL.

    ``https://foo.cognitiveservices.azure.com/`` → ``foo.cognitiveservices.azure.com``.
    """
    from urllib.parse import urlparse

    parsed = urlparse(endpoint)
    return parsed.hostname or parsed.netloc or endpoint
