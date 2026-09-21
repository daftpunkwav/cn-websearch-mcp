// Drain stdin by reading from it in a loop with a fresh handler — proves whether
// the child process even sees what we wrote.
import { spawn } from "node:child_process";
import process from "node:process";

const proc = spawn(process.execPath, ["dist/index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
});

proc.stderr.on("data", (c) => process.stderr.write("[STDERR] " + c));
proc.stdout.on("data", (c) => process.stdout.write("[STDOUT] " + c));
proc.on("exit", (c, s) => console.log("[EXIT]", c, s));

// Burst 1: send immediately at t=0
const init = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "probe", version: "0.0.0" },
  },
});
const frame = `Content-Length: ${Buffer.byteLength(init, "utf8")}\r\n\r\n${init}`;

console.log("[T+0] write");
proc.stdin.write(frame);

// Burst 2: keep stdin open for 5 seconds
setTimeout(() => {
  console.log("[T+2] re-write");
  proc.stdin.write(frame);
}, 2000);

setTimeout(() => {
  console.log("[T+5] end");
  try { proc.kill(); } catch {}
}, 5000);