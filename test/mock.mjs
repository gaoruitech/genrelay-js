import http from "node:http";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GenRelay, JobFailedError, JobTimeout, InsufficientCreditsError, AuthenticationError } from "../dist/index.js";

let polls = 0;
let failMode = false;
let sawBody = null;
const server = http.createServer((req, res) => {
  const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.headers.authorization !== "Bearer good") return json(401, { error: { message: "bad key", code: "invalid_key" } });
  if (req.method === "POST" && req.url === "/v1/videos") {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      sawBody = JSON.parse(b);
      if (sawBody.prompt === "broke") return json(402, { error: { message: "no credits" } });
      failMode = sawBody.prompt === "fail";
      polls = 0; json(200, { id: "task_1", status: "queued", model: sawBody.model });
    }); return;
  }
  if (req.url === "/v1/videos/task_1") {
    polls++;
    if (polls < 2) return json(200, { id: "task_1", status: "in_progress", progress: 40 });
    if (failMode) return json(200, { id: "task_1", status: "failed", error: { message: "blocked", code: "moderation" } });
    return json(200, { id: "task_1", status: "completed", progress: 100 });
  }
  if (req.url === "/v1/videos/task_1/content") { res.writeHead(200); return res.end("VIDEOBYTES"); }
  json(404, { error: { message: "nf" } });
});
await new Promise((r) => server.listen(0, r));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); console.log("PASS", name); pass++; } catch (e) { console.log("FAIL", name, e); fail++; } };
const ok = (c, m) => { if (!c) throw new Error(m); };

const c = new GenRelay({ apiKey: "good", baseUrl, maxRetries: 0 });
await t("generate + progress + snake_case body", async () => {
  const seen = [];
  const v = await c.videos.generate({ model: "veo_3_1", prompt: "x", tier: "1080p", referenceImages: ["https://a/b.png"], pollInterval: 0.05, onProgress: (v) => seen.push(v.status) });
  ok(v.status === "completed" && v.id === "task_1", "status");
  ok(seen.length >= 2, "progress called");
  ok(sawBody.tier === "1080p" && sawBody.reference_images[0] === "https://a/b.png", "body mapping");
  ok(!("referenceImages" in sawBody) && !("timeout" in sawBody), "no leaked keys");
});
await t("download writes file", async () => {
  const out = join(tmpdir(), "genrelay-js-test");
  await c.videos.download("task_1", join(out, "x.mp4"));
  ok((await readFile(join(out, "x.mp4"), "utf8")) === "VIDEOBYTES", "content");
  await rm(out, { recursive: true });
});
await t("JobFailedError", async () => {
  try { await c.videos.generate({ model: "m", prompt: "fail", pollInterval: 0.05 }); ok(false, "no throw"); }
  catch (e) { ok(e instanceof JobFailedError && e.video.error.code === "moderation", "type"); }
});
await t("JobTimeout keeps taskId", async () => {
  polls = -1000; failMode = false;
  const j = await c.videos.create({ model: "m", prompt: "slow" }); polls = -1000;
  try { await c.videos.wait(j.id, { timeout: 0.3, pollInterval: 0.05 }); ok(false, "no throw"); }
  catch (e) { ok(e instanceof JobTimeout && e.taskId === "task_1", "taskId"); }
});
await t("InsufficientCreditsError on 402", async () => {
  try { await c.videos.create({ model: "m", prompt: "broke" }); ok(false, "no throw"); }
  catch (e) { ok(e instanceof InsufficientCreditsError && e.status === 402, "type"); }
});
await t("AuthenticationError on 401", async () => {
  try { await new GenRelay({ apiKey: "bad", baseUrl, maxRetries: 0 }).videos.retrieve("task_1"); ok(false, "no throw"); }
  catch (e) { ok(e instanceof AuthenticationError && e.code === "invalid_key", "type"); }
});
await t("missing key throws", async () => {
  const old = process.env.GENRELAY_API_KEY; delete process.env.GENRELAY_API_KEY;
  try { new GenRelay(); ok(false, "no throw"); } catch (e) { ok(e instanceof AuthenticationError, "type"); }
  if (old) process.env.GENRELAY_API_KEY = old;
});
server.close();
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
