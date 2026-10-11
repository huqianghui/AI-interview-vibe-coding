"""Run a command while holding the database boot lock (``app.db.boot_lock``).

    python scripts/with_boot_lock.py python scripts/import_rfcsm_bank.py --source-dir ...

entrypoint.sh runs the client bank importer before uvicorn starts, once per replica. With more than
one replica (docs/planning/spec-jobs-and-scale-out.md) two importers could run at once and both
create the same bank; under the lock the second waits, then finds the work done. On SQLite the lock
is a no-op. Exits with the command's exit code.
"""

import asyncio
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


async def _main(argv: list[str]) -> int:
    from app.db import boot_lock, engine

    async with boot_lock():
        code = await asyncio.to_thread(subprocess.call, argv)
    await engine.dispose()
    return code


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: with_boot_lock.py COMMAND [ARGS...]")
    sys.exit(asyncio.run(_main(sys.argv[1:])))
