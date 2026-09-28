const express = require("express");
const app = express();

const leaked = [];

app.get("/", (_req, res) => res.json({ ok: true, leaked: leaked.length }));

app.get("/leak", (_req, res) => {
  for (let i = 0; i < 1000; i++) {
    leaked.push(Buffer.alloc(64 * 1024));
  }
  res.json({ leaked: leaked.length, rss: process.memoryUsage().rss });
});

app.listen(3000, () => console.log("listening on 3000"));