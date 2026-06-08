#!/usr/bin/env python3
"""First-run admin user setup.

Usage (direct):
    DATABASE_URL=postgresql://... python scripts/setup_admin.py

Usage (Docker):
    docker compose -f docker-compose.prod.yml run --rm setup-admin

Prompts for username and password interactively if not passed as arguments.
Safe to re-run: prints a warning if the username already exists.
"""
import os
import sys
import getpass
import argparse

# Allow running from the repo root without installing the package
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv
load_dotenv()

from bcrypt import hashpw, gensalt
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session


def main() -> None:
    parser = argparse.ArgumentParser(description="Create the first EyeGila admin user")
    parser.add_argument("--username", "-u", help="Admin username")
    parser.add_argument("--password", "-p", help="Admin password (omit to be prompted)")
    args = parser.parse_args()

    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        print("ERROR: DATABASE_URL environment variable is not set.", file=sys.stderr)
        sys.exit(1)

    username = args.username or input("Admin username: ").strip()
    if not username:
        print("ERROR: username cannot be empty.", file=sys.stderr)
        sys.exit(1)

    password = args.password or getpass.getpass("Admin password: ")
    if len(password) < 8:
        print("ERROR: password must be at least 8 characters.", file=sys.stderr)
        sys.exit(1)

    pw_hash = hashpw(password.encode(), gensalt()).decode()

    engine = create_engine(db_url)
    with Session(engine) as db:
        existing = db.execute(
            text("SELECT id FROM users WHERE username = :u"), {"u": username}
        ).fetchone()

        if existing:
            print(f"User '{username}' already exists (id={existing.id}). No changes made.")
            return

        db.execute(
            text("INSERT INTO users (username, hash) VALUES (:u, :h)"),
            {"u": username, "h": pw_hash},
        )
        db.commit()

    print(f"Admin user '{username}' created successfully.")
    print("You can now log in at the EyeGila web interface.")


if __name__ == "__main__":
    main()
