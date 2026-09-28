import os
import time

from celery import Celery

from app.db import connect

celery = Celery("jobs", broker=os.environ.get("REDIS_URL", "redis://localhost:6379/0"))


@celery.task
def process(job_id: int):
    time.sleep(2)  # pretend to do real work
    with connect() as conn:
        conn.execute("UPDATE jobs SET status = 'done' WHERE id = %s", (job_id,))
