import express from "express";

const app = express();
const port = process.env.PORT || 3000;

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "fat-image-slow-build" });
});

app.listen(port, () => {
  console.log(`listening on ${port}`);
});
