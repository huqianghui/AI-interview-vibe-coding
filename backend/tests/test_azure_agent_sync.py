"""Tests for the pure/testable pieces of the Foundry agent-sync adapter (Phase 2.5) — zero Azure.

The create/update/delete paths need a live Foundry endpoint (coverage-omitted); these tests pin
the transient-error classifier that decides retry-vs-recover, and the project-client error mapping.
"""

from app.services.agents.adapters.azure_agent_sync import AgentSyncError, _is_transient_error


class TestIsTransientError:
    def test_connection_drops_are_transient(self):
        for msg in (
            "('Connection aborted.', RemoteDisconnected('Remote end closed connection'))",
            "ConnectionError: [Errno 104] ConnectionResetError",
            "requests.exceptions.ConnectionError",
        ):
            assert _is_transient_error(Exception(msg)) is True

    def test_server_and_auth_errors_are_not_transient(self):
        # A 500 / auth failure must NOT be retried — it flows to the recovery path instead.
        assert _is_transient_error(Exception("server_error: 500")) is False
        assert _is_transient_error(Exception("(401) Unauthorized")) is False
        assert _is_transient_error(Exception("some other failure")) is False


class TestErrorTypes:
    def test_agent_sync_error_is_runtime_error(self):
        assert issubclass(AgentSyncError, RuntimeError)
