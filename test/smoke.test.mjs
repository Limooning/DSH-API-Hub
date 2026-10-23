// Smoke tests for the panel backend.
//
// The backend resolves its data directory through os.homedir(), so every test
// runs the handler in a child process with a throwaway HOME. That keeps the
// developer's real ~/.dsh/api-hub/providers.json untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SERVER_URL = pathToFileURL(fileURLToPath(new URL("../lib/server.mjs", import.meta.url))).href;

const PROBE = `
import { handleRequest } from ${JSON.stringify(SERVER_URL)};
const call = async (path) => {
  const res = { code: 0, body: "", writeHead(c) { this.code = c; }, end(b) { this.body = b; } };
  const req = { method: "GET", url: path, headers: {}, on(event, cb) { if (event === "end") cb(); return this; } };
  await handleRequest(req, res, "");
  return { code: res.code, body: res.body };
};
const out = {};
for (const path of ["/api/health", "/api/state", "/api/skills", "/api/nope"]) out[path] = await call(path);
console.log("PROBE " + JSON.stringify(out));
`;

function probeInFreshHome() {
  const home = mkdtempSync(join(tmpdir(), "api-hub-test-"));
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", PROBE], {
    env: { ...process.env, USERPROFILE: home, HOME: home },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, "probe failed:\n" + result.stderr);
  const line = result.stdout.split("\n").find((row) => row.startsWith("PROBE "));
  assert.ok(line, "probe produced no result:\n" + result.stdout);
  return { home, out: JSON.parse(line.slice("PROBE ".length)) };
}

test("a fresh home gets a seeded registry and healthy routes", () => {
  const { home, out } = probeInFreshHome();
  try {
    assert.equal(out["/api/health"].code, 200);
    assert.equal(JSON.parse(out["/api/health"].body).ok, true);

    assert.equal(out["/api/state"].code, 200);
    const state = JSON.parse(out["/api/state"].body);
    assert.equal(state.providers.length, 1, "the example registry ships one provider");
    assert.equal(state.providers[0].id, "deepseek-api");
    assert.equal(state.providers[0].kind, "llm");
    assert.equal(state.defaults.llm, "deepseek-api");

    // No ~/.dsh/skills on a fresh machine must stay a 200 with an empty list.
    assert.equal(out["/api/skills"].code, 200);
    assert.deepEqual(JSON.parse(out["/api/skills"].body).skills, []);

    assert.equal(existsSync(join(home, ".dsh", "api-hub", "providers.json")), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the seeded registry is a copy of the bundled example", () => {
  const { home, out } = probeInFreshHome();
  try {
    const seeded = JSON.parse(readFileSync(join(home, ".dsh", "api-hub", "providers.json"), "utf8"));
    const example = JSON.parse(readFileSync(new URL("../providers.example.json", import.meta.url), "utf8"));
    assert.deepEqual(seeded.providers.map((p) => p.id), example.providers.map((p) => p.id));
    assert.equal(seeded.providers.length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("unknown routes answer 404 instead of crashing", () => {
  const { home, out } = probeInFreshHome();
  try {
    assert.equal(out["/api/nope"].code, 404);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// A discovered endpoint must be callable before it may enter the registry, so
// this test spins up a throwaway relay that only answers with the right key.
const VERIFY = `
import http from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleRequest } from ${JSON.stringify(SERVER_URL)};

const relay = http.createServer((req, res) => {
  if (!req.url.startsWith("/v1/models")) { res.writeHead(404); return res.end("{}"); }
  const ok = req.headers.authorization === "Bearer good-key";
  res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
  res.end(ok ? JSON.stringify({ data: [{ id: "probe-a" }, { id: "probe-b" }] }) : "{}");
});
await new Promise((done) => relay.listen(0, "127.0.0.1", done));
const port = relay.address().port;

const panel = http.createServer(async (req, res) => {
  try { await handleRequest(req, res, ""); } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise((done) => panel.listen(0, "127.0.0.1", done));

const home = process.env.USERPROFILE || process.env.HOME;
const file = join(home, "relay-config.json");
writeFileSync(file, JSON.stringify({ relay: { apiKey: "good-key" }, wrong: { apiKey: "bad-key" } }));

const api = async (path, body) => {
  const res = await fetch("http://127.0.0.1:" + panel.address().port + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { code: res.status, body: await res.json() };
};

const base = "http://127.0.0.1:" + port + "/v1";
const good = { source: "file", path: file, jsonPath: ["relay", "apiKey"], baseURL: base };
const out = {
  verifyOk: await api("/api/discover/verify", good),
  verifyBadKey: await api("/api/discover/verify", { ...good, jsonPath: ["wrong", "apiKey"] }),
  verifyBadPath: await api("/api/discover/verify", { ...good, baseURL: "http://127.0.0.1:" + port + "/nope" }),
  importBadKey: await api("/api/discover/import", { ...good, jsonPath: ["wrong", "apiKey"], name: "坏 Key" }),
  importOk: await api("/api/discover/import", { ...good, name: "验证中转" }),
};
relay.close(); panel.close();
console.log("VERIFY " + JSON.stringify(out));
`;

function verifyInFreshHome() {
  const home = mkdtempSync(join(tmpdir(), "api-hub-verify-"));
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", VERIFY], {
    env: { ...process.env, USERPROFILE: home, HOME: home },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, "verify probe failed:\n" + result.stderr);
  const line = result.stdout.split("\n").find((row) => row.startsWith("VERIFY "));
  assert.ok(line, "verify probe produced no result:\n" + result.stdout);
  return { home, out: JSON.parse(line.slice("VERIFY ".length)) };
}

test("a live call decides whether a discovered endpoint can be imported", () => {
  const { home, out } = verifyInFreshHome();
  try {
    assert.equal(out.verifyOk.code, 200);
    assert.equal(out.verifyOk.body.ok, true);
    assert.deepEqual(out.verifyOk.body.models.map((m) => m.id), ["probe-a", "probe-b"]);

    assert.equal(out.verifyBadKey.body.ok, false);
    assert.match(out.verifyBadKey.body.error, /401/);

    assert.equal(out.verifyBadPath.body.ok, false);
    assert.match(out.verifyBadPath.body.error, /Base URL/);

    assert.equal(out.importBadKey.code, 400);
    assert.match(out.importBadKey.body.error, /调不通/);

    assert.equal(out.importOk.code, 200);
    assert.equal(out.importOk.body.provider.cachedCount, 2);

    // The provider must point at the original file instead of copying the secret.
    const reg = JSON.parse(readFileSync(join(home, ".dsh", "api-hub", "providers.json"), "utf8"));
    const added = reg.providers.find((p) => p.name === "验证中转");
    assert.ok(added, "the verified provider was written");
    assert.equal(added.keySource.type, "json");
    assert.equal(added.keySource.path, join(home, "relay-config.json"));
    assert.equal(reg.providers.some((p) => p.name === "坏 Key"), false, "a dead endpoint is never written");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
