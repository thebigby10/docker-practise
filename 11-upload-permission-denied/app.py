import os
import sqlite3

from flask import Flask, request
from werkzeug.utils import secure_filename

app = Flask(__name__)
UPLOAD_DIR = "/app/uploads"
DB_PATH = "/app/data/app.db"


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("CREATE TABLE IF NOT EXISTS uploads (name TEXT)")
    return conn


@app.post("/upload")
def upload():
    f = request.files["file"]
    name = secure_filename(f.filename)
    f.save(os.path.join(UPLOAD_DIR, name))
    with db() as conn:
        conn.execute("INSERT INTO uploads VALUES (?)", (name,))
    return {"saved": name}, 201


@app.get("/uploads")
def list_uploads():
    with db() as conn:
        return {"files": [r[0] for r in conn.execute("SELECT name FROM uploads")]}
