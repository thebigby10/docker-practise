const fs = require("fs");
const path = require("path");
const express = require("express");

const app = express();
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

app.get("/", (_req, res) => res.json({ ok: true }));

app.post("/upload", (req, res) => {
  const file = path.join(uploadDir, `upload-${Date.now()}.txt`);
  fs.writeFileSync(file, "hello");
  res.json({ file });
});

app.listen(3000, () => console.log("listening on 3000"));