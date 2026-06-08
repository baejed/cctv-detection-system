#!/usr/bin/env python3
"""Generate fresh secrets for a production .env.prod file.

Usage:
    python scripts/generate_secrets.py >> .env.prod
"""
import secrets
import sys

try:
    from cryptography.fernet import Fernet
    fernet_key = Fernet.generate_key().decode()
except ImportError:
    import base64, os
    fernet_key = base64.urlsafe_b64encode(os.urandom(32)).decode()

super_key   = secrets.token_urlsafe(32)
db_password = secrets.token_urlsafe(24)

print("# --- Generated secrets (paste into .env.prod) ---")
print(f"SUPER_KEY={super_key}")
print(f"FERNET_KEY={fernet_key}")
print(f"DB_PASSWORD={db_password}")
print("#")
print("# DB_PASSWORD must also be set in POSTGRES_PASSWORD and DATABASE_URL:")
print(f"# POSTGRES_PASSWORD={db_password}")
print(f"# DATABASE_URL=postgresql://postgres:{db_password}@pgbouncer:5432/traffic")
