// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

/* global process, console, setTimeout */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Instance, installCleanupHandlers } from "./perf/lib/instance.mjs";
import { Driver } from "./perf/lib/workspace.mjs";

installCleanupHandlers();
const instance = Instance.create(process.cwd());
const driver = new Driver(instance);
const alpha = path.join(instance.root, "project-alpha");
const beta = path.join(instance.root, "project-beta");
for (const dir of [alpha, beta]) {
  fs.mkdirSync(dir);
  execFileSync("git", ["init", "--initial-branch=main", dir], { stdio: "ignore" });
  execFileSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { stdio: "ignore" }
  );
}
const until = async (expression, description) => {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await driver.pageEval(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${description}`);
};
const link = (dir) =>
  driver.pageEval(`RpcApi.SetMetaCommand(TabRpcClient, {
    oref: "workspace:" + globalStore.get(globalAtoms.workspace).oid,
    meta: { "molten:project": ${JSON.stringify(dir)} }
})`);
try {
  instance.writeConfig("settings.json", { "moltenterm:language": "en" });
  await instance.launch();
  assert.equal((await instance.waitReady()).timedOut, false, "app starts");
  await driver.attach();
  await driver.pageEval(`(async () => {
        const tabid = globalStore.get(globalAtoms.staticTabId);
        const tab = await WOS.callBackendService("object", "GetObject", ["tab:" + tabid]);
        await RpcApi.CreateBlockCommand(TabRpcClient, { tabid, blockdef: { meta: { view: "molten-cicd" } } });
        for (const blockid of tab.blockids) await RpcApi.DeleteBlockCommand(TabRpcClient, { blockid });
        globalThis.mt815OriginalCall = TabRpcClient.wshRpcCall.bind(TabRpcClient);
        globalThis.mt815Held = [];
        TabRpcClient.wshRpcCall = async (command, data, opts) => {
            const value = await mt815OriginalCall(command, data, opts);
            if (command === "moltenmissionget" && data.dir === ${JSON.stringify(alpha)}) {
                return new Promise((resolve, reject) => mt815Held.push({ value, resolve, reject }));
            }
            return value;
        };
    })()`);
  await link(alpha);
  await until("mt815Held.length > 0", "deferred Alpha snapshot");
  await link(beta);
  await until(
    `Array.from(document.querySelectorAll('[title]')).some(e => e.title === ${JSON.stringify(beta)} && e.textContent.includes('project-beta'))`,
    "Beta identity in Mission Control"
  );
  await until(
    `Array.from(document.querySelectorAll('[title]')).some(e => e.title === ${JSON.stringify(beta)} && e.textContent.includes('main'))`,
    "Beta snapshot loaded"
  );
  await driver.pageEval(`(() => {
        for (const item of mt815Held.splice(0)) item.resolve({ ...item.value, git: { ...item.value.git, trunk: "MT815_OBSOLETE_ALPHA" } });
        return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
  const text = await driver.pageEval("document.body.innerText");
  assert.ok(text.includes("project-beta"));
  assert.ok(!text.includes("MT815_OBSOLETE_ALPHA"), "obsolete Alpha snapshot cannot appear under Beta identity");
  await link(alpha);
  await until("mt815Held.length > 0", "second Alpha request");
  await link(beta);
  await until(
    `Array.from(document.querySelectorAll('[title]')).some(e => e.title === ${JSON.stringify(beta)} && e.textContent.includes('main'))`,
    "Beta restored"
  );
  await driver.pageEval(`(() => {
        for (const item of mt815Held.splice(0)) item.reject(new Error("MT815_OBSOLETE_ERROR"));
        return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    })()`);
  assert.ok(!(await driver.pageEval("document.body.innerText")).includes("MT815_OBSOLETE_ERROR"));
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        checks: [
          "built app relinks project while Mission Control stays open",
          "deferred Alpha success cannot replace Beta snapshot",
          "deferred Alpha error cannot affect Beta",
        ],
        evidence: instance.root,
      },
      null,
      2
    )
  );
} finally {
  driver.detach();
  await instance.dispose({ keep: true });
}
