"""Fernet encryption helpers for at-rest secrets (Azure API keys in ``service_configs``).

Precedence for the key material:
1. ``ENCRYPTION_KEY`` setting (a urlsafe-base64 32-byte Fernet key) — set this in prod so encrypted
   values survive restarts and key rotation is explicit.
2. Dev fallback: a stable key *derived* from ``secret_key`` so local dev / tests round-trip without
   any extra config. This is NOT for production — it inherits ``secret_key``'s dev default; a real
   deploy sets both ``SECRET_KEY`` and ``ENCRYPTION_KEY``.

The dev fallback is deterministic (no random generation, no writing back to ``.env``) so tests are
reproducible and importing this module has no side effects.
"""

import base64
import hashlib
import logging

from cryptography.fernet import Fernet, InvalidToken

from app.config import get_settings

logger = logging.getLogger(__name__)

_fernet_instance: Fernet | None = None


class EncryptionKeyMissing(RuntimeError):
    """Raised when ENCRYPTION_KEY is required (debug off) but not set."""


def _derive_dev_key(secret_key: str) -> str:
    """Derive a stable Fernet key from ``secret_key`` (dev/test fallback only)."""
    digest = hashlib.sha256(f"ai-interview-encryption::{secret_key}".encode()).digest()
    return base64.urlsafe_b64encode(digest).decode()


def _get_fernet() -> Fernet:
    global _fernet_instance
    if _fernet_instance is not None:
        return _fernet_instance

    settings = get_settings()
    key = settings.encryption_key
    if not key:
        # Fail closed outside dev: a derivable key (from the possibly-default secret_key) makes
        # at-rest encryption cosmetic. Only fall back to the derived key when debug is on.
        if not settings.debug:
            raise EncryptionKeyMissing(
                "ENCRYPTION_KEY is not set and debug is off. Set ENCRYPTION_KEY (a urlsafe-base64 "
                "32-byte Fernet key) so stored secrets are not encrypted with a derivable key."
            )
        key = _derive_dev_key(settings.secret_key)
        logger.warning(
            "ENCRYPTION_KEY not set — using a key derived from SECRET_KEY (dev/test only). "
            "Set ENCRYPTION_KEY (a Fernet key) in production so secrets survive key changes."
        )
    _fernet_instance = Fernet(key.encode())
    return _fernet_instance


def reset_fernet_cache() -> None:
    """Drop the cached Fernet instance (tests that change ENCRYPTION_KEY/secret_key)."""
    global _fernet_instance
    _fernet_instance = None


def encrypt_value(plaintext: str) -> str:
    """Encrypt a string, returning a base64 Fernet token. Empty in → empty out."""
    if not plaintext:
        return ""
    return _get_fernet().encrypt(plaintext.encode()).decode()


def decrypt_value(token: str) -> str:
    """Decrypt a Fernet token back to plaintext. Empty in → empty out.

    Returns empty string on an invalid/undecryptable token (e.g. the key changed since it was
    written) rather than raising, so a rotated key degrades to "no secret" instead of a 500.
    """
    if not token:
        return ""
    try:
        return _get_fernet().decrypt(token.encode()).decode()
    except (InvalidToken, ValueError):
        logger.warning("Could not decrypt a stored secret (key changed?); treating as unset.")
        return ""
