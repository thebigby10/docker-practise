const { spawn } = require("child_process");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function doWork() {
  return sleep(5000);
}

function spawnEphemeralChild() {
  const child = spawn("true", [], { stdio: "ignore" });
  child.on("error", () => {});
}

async function run() {
  let n = 0;
  while (true) {
    n++;
    console.log(`picked up job ${n}`);
    await doWork();
    spawnEphemeralChild();
    console.log(`finished job ${n}`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});