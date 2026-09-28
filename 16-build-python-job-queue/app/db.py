import os

import psycopg


def _password():
    path = os.environ.get("DB_PASSWORD_FILE")
    if path:
        with open(path) as f:
            return f.read().strip()
    return os.environ["DB_PASSWORD"]


def connect():
    return psycopg.connect(
        host=os.environ.get("DB_HOST", "localhost"),
        dbname=os.environ.get("DB_NAME", "app"),
        user=os.environ.get("DB_USER", "app"),
        password=_password(),
    )
