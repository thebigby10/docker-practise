from fastapi import FastAPI, HTTPException

from app.db import connect
from app.worker import process

app = FastAPI()


@app.get("/health")
def health():
    with connect() as conn:
        conn.execute("SELECT 1")
    return {"ok": True}


@app.post("/jobs", status_code=201)
def create_job():
    with connect() as conn:
        job_id = conn.execute(
            "INSERT INTO jobs (status) VALUES ('queued') RETURNING id"
        ).fetchone()[0]
    process.delay(job_id)
    return {"id": job_id, "status": "queued"}


@app.get("/jobs/{job_id}")
def get_job(job_id: int):
    with connect() as conn:
        row = conn.execute("SELECT status FROM jobs WHERE id = %s", (job_id,)).fetchone()
    if row is None:
        raise HTTPException(404)
    return {"id": job_id, "status": row[0]}
