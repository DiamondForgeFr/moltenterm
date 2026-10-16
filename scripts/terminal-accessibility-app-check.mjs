// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

/* global process, console, setTimeout */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Instance, freePort, installCleanupHandlers } from "./perf/lib/instance.mjs";
import { Driver } from "./perf/lib/workspace.mjs";

installCleanupHandlers();
const instance = Instance.create(process.cwd());
const driver = new Driver(instance);
// The existing harness owns cleanup; this launch also isolates Chromium's profile and applies accessory mode early.
instance.launch = async function () {
  assert.equal(this.child, null);
  this.port = await freePort();
  this.inspectPort = await freePort();
  const env = {
    ...process.env,
    MOLTENTERM_DATA_HOME: this.dataDir,
    MOLTENTERM_CONFIG_HOME: this.configDir,
    MOLTENTERM_HOME: path.join(this.root, "no-legacy-home"),
    WAVETERM_NOCONFIRMQUIT: "1",
    MOLTENTERM_SKIP_ONBOARDING: "1",
    MOLTENTERM_BACKGROUND: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const out = fs.openSync(path.join(this.root, `electron-${++this.launches}.out`), "a");
  this.startMs = Date.now();
  const child = spawn(
    this.electronBinary(),
    [
      "scripts/fixtures/accessibility-app-launch.cjs",
      `--user-data-dir=${path.join(this.root, "chromium")}`,
      "-ApplePersistenceIgnoreState",
      "YES",
      `--remote-debugging-port=${this.port}`,
      `--inspect=${this.inspectPort}`,
    ],
    { cwd: this.repoRoot, env, stdio: ["ignore", out, out] }
  );
  fs.closeSync(out);
  this.child = child;
  this.pid = child.pid;
  child.on("exit", () => {
    if (this.child === child) this.child = null;
  });
  return this.pid;
};
const until = async (expression, description) => {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await driver.pageEval(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out: ${description}`);
};
const preference = async (value) => {
  await driver.pageEval(
    `RpcApi.SetConfigCommand(TabRpcClient, { "moltenterm:terminalscreenreader": ${JSON.stringify(value)} })`
  );
  await until(
    `globalStore.get(globalAtoms.settingsAtom)["moltenterm:terminalscreenreader"] === ${JSON.stringify(value)}`,
    "settings update"
  );
};
const mode = async (enabled) =>
  until(`Boolean(document.querySelector('.xterm-accessibility')) === ${enabled}`, "terminal accessibility DOM");
try {
  instance.writeConfig("settings.json", {
    "app:language": "en",
    "moltenterm:terminalscreenreader": "on",
    "term:durable": false,
  });
  await instance.launch();
  assert.equal((await instance.waitReady()).timedOut, false);
  await driver.attach();
  await driver.pageEval(`(async () => {
        const tabid = globalStore.get(globalAtoms.staticTabId);
        globalThis.mt808Block = await RpcApi.CreateBlockCommand(TabRpcClient, { tabid, blockdef: { meta: { view: "term", controller: "shell" } } });
    })()`);
  await until("Boolean(document.querySelector('.xterm-helper-textarea'))", "new terminal");
  await mode(true);
  const native = await driver.pageEval("window.api.getAccessibilitySupport()");
  assert.equal(typeof native.available, "boolean");
  assert.equal(typeof native.revision, "number");
  await driver.pageEval(
    `globalThis.mt808Textarea = document.querySelector('.xterm-helper-textarea'); mt808Textarea.focus();`
  );
  for (const [value, enabled] of [
    ["off", false],
    ["on", true],
    ["auto", native.available && native.enabled],
  ]) {
    await preference(value);
    await mode(enabled);
    assert.equal(
      await driver.pageEval("document.querySelector('.xterm-helper-textarea') === mt808Textarea"),
      true,
      "terminal input survives setting change"
    );
    assert.equal(
      await driver.pageEval("document.activeElement === mt808Textarea"),
      true,
      "terminal focus survives setting change"
    );
  }
  await driver.mainEval('require("electron").app.emit("accessibility-support-changed", {}, true); 1');
  await mode(true);
  await preference("off");
  await driver.mainEval('require("electron").app.emit("accessibility-support-changed", {}, true); 1');
  await mode(false);
  await preference("on");
  await driver.pageEval('RpcApi.SetConfigCommand(TabRpcClient, { "app:language": "fr" })');
  await until("mt808Textarea.getAttribute('aria-label') === 'Saisie du terminal'", "live localized input label");
  const saved = JSON.parse(fs.readFileSync(path.join(instance.configDir, "settings.json"), "utf8"));
  assert.equal(saved["moltenterm:terminalscreenreader"], "on");
  driver.detach();
  await instance.stop();
  await instance.launch();
  assert.equal((await instance.waitReady()).timedOut, false);
  await driver.attach();
  await until("Boolean(document.querySelector('.xterm-helper-textarea'))", "terminal restored after relaunch");
  await mode(true);
  assert.equal(
    await driver.pageEval('globalStore.get(globalAtoms.settingsAtom)["moltenterm:terminalscreenreader"]'),
    "on"
  );
  assert.equal(
    await driver.pageEval("document.querySelector('.xterm-helper-textarea').getAttribute('aria-label')"),
    "Saisie du terminal"
  );
  const report = {
    result: "PASS",
    native,
    checks: [
      "new terminal explicit On",
      "live on/off/auto without input replacement or focus loss",
      "native event bridge and explicit override",
      "live French label",
      "setting persisted through restart",
    ],
    evidence: instance.root,
  };
  fs.writeFileSync(path.join(instance.root, "accessibility-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  driver.detach();
  await instance.dispose({ keep: true });
}
