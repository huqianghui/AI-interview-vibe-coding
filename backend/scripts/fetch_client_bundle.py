"""Deploy-time fetch of the gitignored client interview bundle from private blob storage.

The client interview material — the importer script ``import_rfcsm_bank.py`` and its ~12 MB of
source SOP/WI/JD documents (``EU_avatar_inspector_interview/``) — is **gitignored**: it is absent
from the PUBLIC repo and therefore absent from the CI-built container image. To auto-seed the real
interview at boot (the app runs on ephemeral SQLite reseeded every start), the bundle is delivered
through a **private channel**: a one-time upload to the deployment Storage Account's private
``client-bundle`` container, pulled here at container start.

This downloads a single ``.zip`` blob and extracts it into ``--dest``. Auth is **managed identity**
via ``DefaultAzureCredential`` (no storage account keys) — the backend MI is granted
``Storage Blob Data Reader`` on the account by the infra Bicep. The layout expected inside the zip::

    import_rfcsm_bank.py                     # the gitignored importer
    EU_avatar_inspector_interview/           # the gitignored source docs
        GCO_Inspection_Training_Bank_rf_CSM.md
        Data_Sources_AI_Inspector/*.pdf|*.docx

``entrypoint.sh`` copies the importer into ``scripts/`` and invokes it with ``--source-dir``
pointing at the extracted ``EU_avatar_inspector_interview`` directory (the importer's default is
wrong inside the image — see the importer's ``_repo_root()``).

Usage (invoked by ``entrypoint.sh`` when ``CLIENT_BUNDLE_BLOB`` is set)::

    python scripts/fetch_client_bundle.py \
        --account-url "$AZURE_STORAGE_ACCOUNT_URL" \
        --container "$CLIENT_BUNDLE_CONTAINER" \
        --blob "$CLIENT_BUNDLE_BLOB" \
        --dest /app/_client_bundle

Best-effort by contract: any failure exits non-zero with a clear message, and ``entrypoint.sh``
treats a missing/failed bundle as "generic demo only" rather than blocking boot.
"""

from __future__ import annotations

import argparse
import sys
import zipfile
from pathlib import Path


def _download_blob(account_url: str, container: str, blob: str, dest_zip: Path) -> None:
    """Download ``blob`` from ``container`` to ``dest_zip`` using managed-identity auth."""
    # Imported lazily so the script only requires the [azure] extra when actually fetching.
    from azure.identity import DefaultAzureCredential
    from azure.storage.blob import BlobServiceClient

    credential = DefaultAzureCredential()
    service = BlobServiceClient(account_url=account_url, credential=credential)
    blob_client = service.get_blob_client(container=container, blob=blob)

    dest_zip.parent.mkdir(parents=True, exist_ok=True)
    with dest_zip.open("wb") as fh:
        stream = blob_client.download_blob()
        stream.readinto(fh)


def _extract_zip(zip_path: Path, dest: Path) -> None:
    """Extract ``zip_path`` into ``dest``, refusing entries that escape the destination root."""
    dest.mkdir(parents=True, exist_ok=True)
    dest_root = dest.resolve()
    with zipfile.ZipFile(zip_path) as zf:
        for member in zf.namelist():
            target = (dest / member).resolve()
            # Guard against Zip-Slip path traversal (a member like "../../etc/x").
            if not str(target).startswith(str(dest_root)):
                raise ValueError(f"Refusing to extract entry outside dest: {member!r}")
        zf.extractall(dest)


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch the private client interview bundle.")
    parser.add_argument(
        "--account-url",
        required=True,
        help="Blob endpoint, e.g. https://acct.blob.core.windows.net",
    )
    parser.add_argument(
        "--container", required=True, help="Private container holding the bundle zip."
    )
    parser.add_argument("--blob", required=True, help="Bundle blob name (a .zip).")
    parser.add_argument("--dest", required=True, help="Directory to extract the bundle into.")
    args = parser.parse_args()

    dest = Path(args.dest)
    zip_path = dest / "_bundle.zip"

    try:
        _download_blob(args.account_url, args.container, args.blob, zip_path)
    except Exception as exc:  # noqa: BLE001 — surface a clear message; caller decides to proceed
        print(f"fetch_client_bundle: download failed: {exc}", file=sys.stderr)
        return 1

    try:
        _extract_zip(zip_path, dest)
    except Exception as exc:  # noqa: BLE001
        print(f"fetch_client_bundle: extract failed: {exc}", file=sys.stderr)
        return 1
    finally:
        # The zip is a transient artifact; don't leave it in the ephemeral layer.
        zip_path.unlink(missing_ok=True)

    print(f"fetch_client_bundle: extracted bundle into {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
