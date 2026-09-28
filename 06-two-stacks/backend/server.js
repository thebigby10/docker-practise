const express = require("express");
const app = express();

app.get("/health", (_req, res) => res.json({ ok: true, service: "api" }));

app.listen(8000, () => console.log("api listening on 8000"));