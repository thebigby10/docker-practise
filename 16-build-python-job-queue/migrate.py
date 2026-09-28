from app.db import connect

with connect() as conn:
    conn.execute("CREATE TABLE IF NOT EXISTS jobs (id serial PRIMARY KEY, status text NOT NULL)")
print("migrations applied")
