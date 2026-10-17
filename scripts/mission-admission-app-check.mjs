// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Two real renderers, one real backend, only disposable fixture commands and data. Build first with
// task build:backend and npm run build:prod, then node scripts/mission-admission-app-check.mjs.
/* global process, console, setTimeout */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Instance } from "./perf/lib/instance.mjs";
import { connectMain, evaluate, OnScreenTabIdExpr, pageForTab, visiblePage } from "./perf/lib/cdp.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inst = Instance.create(repo, "/private/tmp");
const pages = [];
let main;
const project = path.join(inst.root, "project");
const alias = path.join(inst.root, "alias");
const evidence = [];

async function until(condition, description) {
  const deadline = Date.now() + 60000;
  for (;;) {
    const result = await condition();
    if (result) return result;
    assert(Date.now() < deadline, description);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function call(page, command, data) {
  return evaluate(page, `TabRpcClient.wshRpcCall(${JSON.stringify(command)}, ${JSON.stringify(data)}, { route: "molten:mission", timeout: 30000 })`);
}

async function race(command, request) {
  const results = await Promise.allSettled(pages.map((page, index) => call(page, command, { ...request, dir: index ? alias : project })));
  const accepted = results.filter((result) => result.status === "fulfilled");
  const refused = results.filter((result) => result.status === "rejected");
  assert.equal(accepted.length, 1, `expected exactly one accepted request: ${JSON.stringify(results)}`);
  assert.equal(refused.length, 1);
  assert.match(String(refused[0].reason), /running|on its way/i);
  return accepted[0].value;
}

try {
  fs.mkdirSync(path.join(project, ".molten"), { recursive: true });
  fs.symlinkSync(project, alias);
  const held = (name) => `echo child >> ${name}.launches; touch ${name}.ready; while ! test -f ${name}.done; do sleep 0.02; done`;
  fs.writeFileSync(path.join(project, ".molten", "project.json"), JSON.stringify({
    schema: 1, name: "Admission smoke",
    steps: [{ id: "held", title: "Held fixture", section: "timeline", run: held("step") }],
    release: { rc: [{ id: "prepare", title: "Prepare fixture", phase: "prepare", run: held("preparation") }, { id: "cut", title: "Cut fixture", phase: "cut", run: "echo cut" }] },
  }));
  for (const args of [["init", "-q", "-b", "develop"], ["add", "-A"], ["-c", "user.name=Admission fixture", "-c", "user.email=admission@example.invalid", "commit", "-q", "-m", "fixture"]]) {
    const result = spawnSync("git", args, { cwd: project, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  await inst.launch();
  assert.equal((await inst.waitReady()).timedOut, false);
  main = await connectMain(inst.inspectPort);
  const first = await visiblePage(inst.port, main);
  await evaluate(first, "window.api.openNewWindow(); true");
  first.close();
  const ids = await until(async () => {
    const current = await evaluate(main, OnScreenTabIdExpr);
    return current.length >= 2 ? current : null;
  }, "second application window did not open");
  for (const id of ids.slice(0, 2)) pages.push(await pageForTab(inst.port, id));
  for (let index = 0; index < pages.length; index++) {
    const dir = index ? alias : project;
    const review = await call(pages[index], "moltenmissionrun", { dir, kind: "step", id: "held" });
    assert(review.untrusted?.hash);
    await call(pages[index], "moltenmissiontrust", { dir, hash: review.untrusted.hash });
  }
  const accepted = await race("moltenmissionrun", { kind: "step", id: "held" });
  assert(accepted.run?.id);
  await until(() => fs.existsSync(path.join(project, "step.ready")), "fixture step did not start");
  assert.equal(fs.readFileSync(path.join(project, "step.launches"), "utf8"), "child\n");
  for (let index = 0; index < pages.length; index++) {
    const records = await call(pages[index], "moltenmissionruns", { dir: index ? alias : project });
    assert.equal(records.filter((record) => record.state === "running" && record.kind === "step").length, 1);
  }
  fs.writeFileSync(path.join(project, "step.done"), "release");
  await until(async () => (await call(pages[0], "moltenmissionruns", { dir: project })).find((record) => record.id === accepted.run.id && record.state === "success"), "step did not finish");
  evidence.push("two windows/aliases: one accepted step, one refusal, exactly one child, both list the same active run");

  const release = await race("moltenmissionreleasestart", { channel: "rc", tag: "v1.2.0-3" });
  assert(release.session?.tag === "v1.2.0-3" && release.run?.id);
  await until(() => fs.existsSync(path.join(project, "preparation.ready")), "preparation did not start");
  assert.equal(fs.readFileSync(path.join(project, "preparation.launches"), "utf8"), "child\n");
  fs.writeFileSync(path.join(project, "preparation.done"), "release");
  await until(async () => (await call(pages[0], "moltenmissionruns", { dir: project })).find((record) => record.id === release.run.id && record.state === "success"), "preparation did not finish");
  for (let index = 0; index < pages.length; index++) {
    const session = await call(pages[index], "moltenmissionrelease", { dir: index ? alias : project });
    assert.equal(session.tag, "v1.2.0-3");
  }
  evidence.push("two windows/aliases: one coherent release session and exactly one preparation child");
  console.log(JSON.stringify({ ok: true, root: inst.root, windows: ids.slice(0, 2), evidence }, null, 2));
} finally {
  for (const name of ["step", "preparation"]) {
    if (fs.existsSync(project)) fs.writeFileSync(path.join(project, `${name}.done`), "cleanup");
  }
  for (const page of pages) page.close();
  main?.close();
  await inst.dispose({ keep: true });
}
