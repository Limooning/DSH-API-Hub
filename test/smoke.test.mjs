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
