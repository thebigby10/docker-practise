import os

import psycopg
from flask import Flask

app = Flask(__name__)


@app.get("/health")
def health():
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        conn.execute("SELECT 1")
    return {"db": "ok"}
