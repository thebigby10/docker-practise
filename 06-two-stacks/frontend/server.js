const express = require("express");
const app = express();

app.get("/", async (_req, res) => {
  try {
    const r = await fetch(`${process.env.API_URL}/health`);
    res.json({ frontend: "ok", backend: await r.json() });
  } catch (err) {
    res.status(502).json({ error: err.message, apiUrl: process.env.API_URL });
  }
});

app.listen(3000, () => console.log("frontend listening on 3000"));