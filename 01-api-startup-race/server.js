const { Client } = require("pg");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectWithRetry(retries = 15, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    try {
      await client.connect();
      console.log("connected to database");
      return client;
    } catch (err) {
      console.error(`attempt ${attempt}/${retries} failed: ${err.message}`);
      await client.end().catch(() => {});
      if (attempt === retries) throw err;
      await sleep(delayMs);
    }
  }
}

async function main() {
  const client = await connectWithRetry();
  const { rows } = await client.query("SELECT version()");
  console.log(rows[0]);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});