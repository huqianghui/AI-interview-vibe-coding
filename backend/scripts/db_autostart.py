"""Start the PostgreSQL server if it is stopped. Run every 5 minutes by an Azure Container Apps
scheduled job (infra/azure/modules/db-autostart-job.bicep), with the backend's managed identity.

Why: the subscription's governance automation stops the server every night (measured: 16:05 UTC
daily, an identity outside this tenant's directory, 2026-10-07 and -08), and the GitHub-scheduled
keepalive did not run for 12+ hours at a time (GitHub cron is best effort). Who stops it does not
matter (owner, 2026-10-09); this job, on Azure's own scheduler, starts it again within minutes.

Environment: ``AZURE_SUBSCRIPTION_ID``, ``POSTGRES_RESOURCE_GROUP``, ``POSTGRES_SERVER_NAME``,
``AZURE_CLIENT_ID`` (the managed identity). Exit 0 when the server is (or comes) up, 1 otherwise,
so a failed execution shows in the job's history.
"""

from __future__ import annotations

import os
import sys
import time

import httpx
from azure.identity import ManagedIdentityCredential

API_VERSION = "2024-08-01"
READY_TIMEOUT_S = 600


def main() -> int:
    server = (
        f"https://management.azure.com/subscriptions/{os.environ['AZURE_SUBSCRIPTION_ID']}"
        f"/resourceGroups/{os.environ['POSTGRES_RESOURCE_GROUP']}/providers"
        f"/Microsoft.DBforPostgreSQL/flexibleServers/{os.environ['POSTGRES_SERVER_NAME']}"
    )
    credential = ManagedIdentityCredential(client_id=os.environ.get("AZURE_CLIENT_ID"))
    token = credential.get_token("https://management.azure.com/.default").token
    headers = {"Authorization": f"Bearer {token}"}
    with httpx.Client(timeout=60) as client:

        def state() -> str:
            resp = client.get(server, params={"api-version": API_VERSION}, headers=headers)
            resp.raise_for_status()
            return resp.json()["properties"]["state"]

        current = state()
        print(f"server state: {current}", flush=True)
        if current == "Ready":
            return 0
        if current == "Stopped":
            resp = client.post(
                f"{server}/start", params={"api-version": API_VERSION}, headers=headers
            )
            print(f"start requested: HTTP {resp.status_code}", flush=True)
            if resp.status_code not in (200, 202):
                print(resp.text[:500], flush=True)
                return 1
        deadline = time.monotonic() + READY_TIMEOUT_S
        while time.monotonic() < deadline:
            time.sleep(20)
            current = state()
            print(f"server state: {current}", flush=True)
            if current == "Ready":
                return 0
        return 1


if __name__ == "__main__":
    sys.exit(main())
