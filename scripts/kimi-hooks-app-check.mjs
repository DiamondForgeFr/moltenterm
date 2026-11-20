// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Isolated running-app validation for #1693. Build first with task build:backend and npm run build:prod.
// Every agent, MoltenTerm and backup path lives beneath the Instance's disposable root; evidence is kept there.

/* global process, console, setTimeout, Buffer */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Instance, installCleanupHandlers } from "./perf/lib/instance.mjs";
import { Driver } from "./perf/lib/workspace.mjs";

installCleanupHandlers();
const inst = Instance.create(process.cwd(), "/private/tmp");
const driver = new Driver(inst);
const kimiHome = path.join(inst.root, "kimi-home");
const configPath = path.join(kimiHome, "config.toml");
const fakeHome = path.join(inst.root, "home");
const fakeBin = path.join(inst.root, "bin");
const fakeKimi = path.join(fakeBin, "kimi");
const shellPath = path.join(inst.root, "fixture-shell.sh");
const original = '# fixture user settings\nmodel = "k3"\n\n[[hooks]]\nevent = "Stop"\ncommand = "afplay done.wav"\n';
const evidence = [];
const statuses = {};
let blockId;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, description) {
  const deadline = Date.now() + 60000;
  for (;;) {
    const value = await fn();
    if (value) return value;
    assert(Date.now() < deadline, `timed out: ${description}`);
    await sleep(50);
  }
}
async function pageUntil(expression, description) {
  return until(() => driver.pageEval(expression, true), description);
}
function call(command, data, timeout = 15000) {
  return driver.pageEval(
    `TabRpcClient.wshRpcCall(${JSON.stringify(command)}, ${JSON.stringify(data)}, { route: "molten:agents", timeout: ${timeout} })`
  );
}
function offer() {
  return call("moltenagenthookoffer", { blockid: blockId });
}
async function shot(name) {
  await driver.withPage(async (page) => {
    const result = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    assert(result.error == null, result.error?.message);
    fs.writeFileSync(path.join(inst.root, `${name}.png`), Buffer.from(result.result.data, "base64"));
  });
}
async function closeDialog() {
  const closed =
    await driver.pageEval(`(() => { const dialog = document.querySelector('[data-role="molten-hook-offer-dialog"]');
        if (!dialog) return true; const button = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Close');
        if (!button) return false; button.click(); return true; })()`);
  assert(closed, "Close button not found");
  await pageUntil(`!document.querySelector('[data-role="molten-hook-offer-dialog"]')`, "dialog close");
}
async function reopenIntegration() {
  if (await driver.pageEval(`Boolean(document.querySelector('[data-testid="companion-integration"]'))`)) {
    await driver.pageEval(`document.querySelector('[data-testid="companion-integration-back"]').click()`);
  }
  await pageUntil(`Boolean(document.querySelector('[data-testid="companion-integrated"]'))`, "Integration badge");
  await driver.pageEval(`document.querySelector('[data-testid="companion-integrated"]').click()`);
  await pageUntil(
    `Boolean(document.querySelector('[data-testid="companion-persistent-hooks"]'))`,
    "persistent Integration"
  );
}
function fakeVersion(version) {
  fs.writeFileSync(
    fakeKimi,
    `#!/bin/sh\nif test "$1" = "--version"; then echo "kimi ${version}"; exit 0; fi\n/bin/sleep 86400\n`,
    { mode: 0o755 }
  );
}
function backups() {
  const cache = path.join(fakeHome, "Library", "Caches");
  if (!fs.existsSync(cache)) return [];
  return fs
    .readdirSync(cache, { recursive: true })
    .map((entry) => path.join(cache, String(entry)))
    .filter((file) => file.endsWith(".bak"));
}

try {
  fs.mkdirSync(kimiHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(fakeHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(fakeBin, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, original, { mode: 0o640 });
  fakeVersion("2.6.3");
  fs.writeFileSync(shellPath, "#!/bin/sh\nexec /bin/sh\n", { mode: 0o755 });
  inst.writeConfig("settings.json", { "app:language": "en", "term:durable": false });
  await inst.launch({
    extraEnv: {
      HOME: fakeHome,
      KIMI_CODE_HOME: kimiHome,
      PATH: `${fakeBin}:${path.join(inst.repoRoot, "dist", "bin")}:${process.env.PATH}`,
      MOLTENTERM_FAKE_KIMI_ROOT: inst.root,
    },
  });
  assert.equal((await inst.waitReady()).timedOut, false, "application startup");
  await driver.attach();
  blockId = await driver.pageEval(`(async () => {
        const tabid = globalStore.get(globalAtoms.staticTabId);
        const oref = await RpcApi.CreateBlockCommand(TabRpcClient, { tabid, blockdef: { meta: {
            view: "term", controller: "shell", "term:localshellpath": ${JSON.stringify(shellPath)}
        } } });
        return String(oref).replace(/^block:/, ""); })()`);
  await sleep(1500);
  await call("moltenagentstateset", { blockid: blockId, state: "done", agent: "kimi", turnend: true });
  statuses.absent = await until(async () => {
    const value = await offer();
    return value.status === "absent" && value.canapply ? value : null;
  }, "qualified absent offer");
  assert.equal(statuses.absent.file, configPath);
  assert.equal(statuses.absent.events.length, 11);
  assert.equal(fs.readFileSync(configPath, "utf8"), original);
  await offer();
  evidence.push("status probes are read-only; exact isolated target and 11 qualified events");

  await pageUntil(
    `Boolean(document.querySelector('.block-frame-settings.molten-has-proposal'))`,
    "hook proposal marker"
  );
  await driver.pageEval(`document.querySelector('.block-frame-settings.molten-has-proposal').click()`);
  await pageUntil(
    `[...document.querySelectorAll('.molten-cmdpanel-chip')].some((b) => b.textContent.includes("Set up Kimi Code"))`,
    "hook proposal chip"
  );
  await driver.pageEval(
    `[...document.querySelectorAll('.molten-cmdpanel-chip')].find((b) => b.textContent.includes("Set up Kimi Code")).click()`
  );
  await pageUntil(
    `document.querySelector('[data-role="molten-hook-offer-dialog"]')?.textContent.includes("Install MoltenTerm hooks")`,
    "shared Install dialog"
  );
  const installDialog = await driver.pageEval(
    `document.querySelector('[data-role="molten-hook-offer-dialog"]').textContent`
  );
  assert(installDialog.includes(configPath));
  assert.match(installDialog, /backup/);
  assert.match(installDialog, /next Kimi Code start/);
  await shot("01-command-install");
  await driver.pageEval(`document.querySelector('[data-testid="agent-hooks-apply"]').click()`);
  statuses.restart = await until(async () => {
    const value = await offer();
    return value.status === "installed-not-reporting" && !value.canapply && value.canremove ? value : null;
  }, "restart-required installation");
  await pageUntil(
    `document.querySelector('[data-testid="agent-hooks-status"]')?.textContent.includes("Hooks installed — restart Kimi Code")`,
    "localized restart-required status"
  );
  await shot("02-restart-required");
  const installedBytes = fs.readFileSync(configPath, "utf8");
  assert(installedBytes.startsWith(`${original}\n# >>> MoltenTerm managed Kimi hooks`));
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o640);
  evidence.push(
    "command proposal installed through the shared dialog; restart-required, no second Install, mode 0640 preserved"
  );

  await closeDialog();
  await call("moltenagentstateset", {
    blockid: blockId,
    state: "idle",
    agent: "kimi",
    start: true,
  });
  statuses.reporting = await until(async () => {
    const value = await offer();
    return value.status === "reporting" && !value.show ? value : null;
  }, "real hook handler report");
  evidence.push(
    "simulated SessionStart through the real local agent-states route changed status to reporting and hid ordinary setup"
  );

  await driver.pageEval(`(async () => {
        const tabid = globalStore.get(globalAtoms.staticTabId);
        await RpcApi.CreateBlockCommand(TabRpcClient, { tabid, blockdef: { meta: {
            view: "molten-companion", "molten:companion:block": ${JSON.stringify(blockId)}
        } } }); })()`);
  await reopenIntegration();
  await pageUntil(
    `document.querySelector('[data-testid="companion-persistent-status"]')?.textContent.includes("Hooks active/reporting")`,
    "active Integration status"
  );
  assert.equal(
    await driver.pageEval(`Boolean(document.querySelector('[data-testid="companion-integration-turnoff-agent"]'))`),
    false
  );
  await shot("03-integration-active");
  await driver.pageEval(`document.querySelector('[data-testid="companion-persistent-manage"]').click()`);
  await pageUntil(
    `document.querySelector('[data-role="molten-hook-offer-dialog"]')?.textContent.includes("Hooks active/reporting")`,
    "Integration shared dialog"
  );
  await shot("04-integration-shared-dialog");
  await closeDialog();
  evidence.push(
    "Integration remains available without a visible proposal or launcher controls and opens the same dialog role/status"
  );

  fs.writeFileSync(
    configPath,
    installedBytes.replace("timeout = 15", "timeout = 14") + "# later user edit outside managed block\n"
  );
  const driftBytes = fs.readFileSync(configPath, "utf8");
  statuses.drift = await until(async () => {
    const value = await offer();
    return value.status === "drift" && value.canapply && value.canremove ? value : null;
  }, "managed drift after reporting");
  await reopenIntegration();
  await driver.pageEval(`document.querySelector('[data-testid="companion-persistent-manage"]').click()`);
  await pageUntil(
    `document.querySelector('[data-testid="agent-hooks-apply"]')?.textContent.includes("Repair MoltenTerm hooks")`,
    "Repair action"
  );
  await shot("05-drift-repair");
  await driver.pageEval(`document.querySelector('[data-testid="agent-hooks-apply"]').click()`);
  await until(async () => (await offer()).status === "reporting", "repair completion");
  const repairedBytes = fs.readFileSync(configPath, "utf8");
  assert(repairedBytes.includes("timeout = 15"));
  assert(repairedBytes.endsWith("# later user edit outside managed block\n"));
  assert(!repairedBytes.includes("timeout = 14"));
  evidence.push("drift Repair won over reporting and restored definitions without discarding the later outside edit");

  await closeDialog();
  fakeVersion("9.9.9");
  statuses.compatibility = await until(async () => {
    const value = await offer();
    return value.status === "compatibility-review" && !value.canapply && value.canremove ? value : null;
  }, "compatibility review after executable update");
  await reopenIntegration();
  await driver.pageEval(`document.querySelector('[data-testid="companion-persistent-remove"]').click()`);
  await pageUntil(
    `document.querySelector('[data-role="molten-hook-offer-dialog"]')?.textContent.includes("Review Kimi Code compatibility")`,
    "compatibility dialog"
  );
  assert.equal(await driver.pageEval(`Boolean(document.querySelector('[data-testid="agent-hooks-apply"]'))`), false);
  await shot("06-compatibility-remove");
  await driver.pageEval(`document.querySelector('[data-testid="agent-hooks-remove"]').click()`);
  await until(async () => {
    const value = await offer();
    return !value.managed && !value.canremove ? value : null;
  }, "safe removal under unknown version");
  const afterRemoval = fs.readFileSync(configPath, "utf8");
  assert(!afterRemoval.includes("MoltenTerm managed Kimi hooks"));
  assert(afterRemoval.includes("afplay done.wav"));
  assert(afterRemoval.endsWith("# later user edit outside managed block\n"));
  evidence.push("unknown-version review exposed no Apply; Remove preserved user settings and later outside edits");

  await closeDialog();
  const manual = `${afterRemoval}[[hooks]]\nevent = "Stop"\ncommand = ${JSON.stringify('[ -n "$WAVETERM_BLOCKID" ] && molten agent hook --agent kimi || true')}\n`;
  fs.writeFileSync(configPath, manual, { mode: 0o640 });
  statuses.manual = await until(async () => {
    const value = await offer();
    return value.status === "manual" && !value.canapply && !value.canremove ? value : null;
  }, "legacy manual configuration");
  await reopenIntegration();
  await driver.pageEval(`document.querySelector('[data-testid="companion-persistent-manage"]').click()`);
  await pageUntil(
    `document.querySelector('[data-role="molten-hook-offer-dialog"]')?.textContent.includes("Manual configuration detected")`,
    "manual dialog"
  );
  assert.equal(await driver.pageEval(`Boolean(document.querySelector('[data-testid="agent-hooks-apply"]'))`), false);
  assert.equal(await driver.pageEval(`Boolean(document.querySelector('[data-testid="agent-hooks-remove"]'))`), false);
  await shot("07-manual-untouched");
  await closeDialog();
  await reopenIntegration();
  assert.equal(fs.readFileSync(configPath, "utf8"), manual);
  evidence.push(
    "legacy manual hooks show manual configuration with no managed mutation and unchanged bytes after dialogs/Integration"
  );

  const backupFiles = backups();
  assert(backupFiles.length >= 3, `expected install, repair and removal backups: ${backupFiles}`);
  assert(backupFiles.every((file) => file.startsWith(inst.root)));
  const backupContents = backupFiles.map((file) => fs.readFileSync(file, "utf8"));
  assert(backupContents.includes(original));
  assert(backupContents.includes(driftBytes));
  assert(backupContents.includes(repairedBytes));
  const installationState = JSON.parse(
    fs.readFileSync(path.join(inst.dataDir, "molten", "kimi-hook-installations.json"), "utf8")
  );
  assert.equal(Object.keys(installationState.installations).length, 0);
  const report = {
    result: "PASS",
    root: inst.root,
    target: configPath,
    home: fakeHome,
    kimiHome,
    backups: backupFiles,
    screenshots: fs.readdirSync(inst.root).filter((name) => name.endsWith(".png")),
    statuses: Object.fromEntries(
      Object.entries(statuses).map(([key, value]) => [
        key,
        {
          status: value.status,
          action: value.action,
          canapply: value.canapply,
          canremove: value.canremove,
          show: value.show,
          managed: value.managed,
          version: value.currentkimiversion,
        },
      ])
    ),
    evidence,
    isolation:
      "HOME, KIMI_CODE_HOME, MoltenTerm data/config, fake binary and all backups are beneath root; no real Kimi path was queried",
  };
  fs.writeFileSync(path.join(inst.root, "kimi-hooks-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(`fixture root: ${inst.root}`);
  try {
    console.error(
      await driver.pageEval(
        `JSON.stringify({ text: document.body.innerText.slice(-12000), panels: [...document.querySelectorAll('[data-role], [role="dialog"], .molten-cmdpanel-chip')].map((e) => ({ role: e.getAttribute('data-role') || e.getAttribute('role'), text: e.textContent })) })`,
        true
      )
    );
    await shot("failure");
  } catch (diagnosticError) {
    console.error(diagnosticError);
  }
  throw error;
} finally {
  driver.detach();
  await inst.dispose({ keep: true });
}
