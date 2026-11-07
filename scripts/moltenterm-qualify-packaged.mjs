#!/usr/bin/env node
// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Qualifies a packaged build (#1975, FR-BRW-014): the app that electron-builder made, started in a test instance with
// data and configuration folders of its own under /tmp (the perf harness's Instance: a marked root, background mode, no
// keychain prompt), never the developer's data and never an installed app. It checks that:
//   - the fuses of the binary are the ones build/moltenterm/electron-fuses.cjs asks for (scripts/moltenterm-check-fuses.mjs);
//   - the app starts and shows its page, with the remote debugging port tests use (a Chromium switch, not a fuse);
//   - that port opens only on a test profile: not on the build's default profile, nor on an unmarked one (#2057);
//   - `--inspect`, `NODE_OPTIONS` and SIGUSR1 reach nothing, and `ELECTRON_RUN_AS_NODE=1` starts the app, not a script;
//   - a changed app.asar is refused (macOS and Windows; Linux has no asar integrity);
//   - the cookie database holds no value in clear, and a cookie an earlier version wrote in clear survives (#2058).
// A build with Electron's default fuses fails the same checks, which is how this script is proven.
//
// Usage: node scripts/moltenterm-qualify-packaged.mjs <MoltenTerm.app | executable> [--tmp dir] [--keep] [--no-tamper]

/* global console, process, setTimeout, fetch, Buffer */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPackagedApp } from "./moltenterm-check-fuses.mjs";
import { connect, evaluate, listTargets } from "./perf/lib/cdp.mjs";
import { installCleanupHandlers, Instance } from "./perf/lib/instance.mjs";

const StartTimeoutMs = 90000;
// The mark of a test profile (emain/moltenterm-remote-debugging.ts).
const TestProfileMarkName = "moltenterm-test-profile";
// The inspector a signal starts opens within a poll or two; this only bounds the wait when it never does.
const SettleMs = 8000;

// The executable inside a macOS app, or the path itself.
export function executableOf(target) {
  if (!target.endsWith(".app")) {
    return target;
  }
  const dir = path.join(target, "Contents", "MacOS");
  const names = fs.readdirSync(dir);
  if (names.length !== 1) {
    throw new Error(`${dir} holds ${names.length} files, expected the one executable`);
  }
  return path.join(dir, names[0]);
}

export function asarOf(target) {
  return target.endsWith(".app")
    ? path.join(target, "Contents", "Resources", "app.asar")
    : path.join(path.dirname(target), "resources", "app.asar");
}

// Changes one letter of package.json's description inside an app.asar, in place. Electron reads that file at start, so a
// build that checks the archive refuses to run; the change keeps the file valid JSON, so a build that does not check it
// starts. The asar layout: a size pickle (4 bytes of payload), the header pickle's size, then the header (a pickle with
// the JSON text) and the files' bytes after it.
export function tamperPackageJson(asar) {
  const fd = fs.openSync(asar, "r+");
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerPickleSize = head.readUInt32LE(4);
    const jsonLength = head.readUInt32LE(12);
    const json = Buffer.alloc(jsonLength);
    fs.readSync(fd, json, 0, jsonLength, 16);
    const entry = JSON.parse(json.toString("utf8")).files?.["package.json"];
    if (!entry || entry.offset == null) {
      throw new Error("package.json is not in the asar header");
    }
    const start = 8 + headerPickleSize + Number(entry.offset);
    const body = Buffer.alloc(entry.size);
    fs.readSync(fd, body, 0, entry.size, start);
    const at = body.indexOf('"description"');
    if (at === -1) {
      throw new Error("package.json has no description to change");
    }
    const letter = body.indexOf('"', body.indexOf(":", at)) + 1;
    const changed = Buffer.from(body[letter] === 0x58 ? "Y" : "X");
    fs.writeSync(fd, changed, 0, 1, start + letter);
    return { file: asar, offset: start + letter };
  } finally {
    fs.closeSync(fd);
  }
}

function portListens(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

// The TCP ports a process listens on (lsof, macOS and Linux), or null when lsof is not there.
function listeningPorts(pid) {
  const r = spawnSync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { encoding: "utf8" });
  if (r.error) {
    return null;
  }
  return new Set(
    r.stdout
      .split("\n")
      .map((l) => /^n.*:(\d+)$/.exec(l)?.[1])
      .filter(Boolean)
      .map(Number)
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) {
      return true;
    }
    await sleep(100);
  }
  return false;
}

async function run(target, { tmp, keep, tamper }) {
  const results = [];
  const note = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
  };
  const executable = executableOf(target);
  const inst = Instance.create(process.cwd(), tmp, { executable });
  const markerNodeOptions = path.join(inst.root, "node-options-ran");
  const markerRunAsNode = path.join(inst.root, "run-as-node-ran");
  const nodeOptionsScript = path.join(inst.root, "node-options.cjs");
  fs.writeFileSync(nodeOptionsScript, `require("fs").writeFileSync(${JSON.stringify(markerNodeOptions)}, "ran");\n`);
  try {
    const fuses = checkPackagedApp(target);
    note("fuses", fuses.problems.length === 0, fuses.problems.join("; ") || "as build/moltenterm/electron-fuses.cjs");

    // A plain start with the debugging port tests use. SIGUSR1 starts Node's inspector in a process that has none yet, so
    // this start has no --inspect.
    await inst.launch({ inspect: false });
    if (await started(inst, "start", note)) {
      await remoteDebugging(inst, note);
      await sigusr1(inst, note);
    }
    await inst.stop();

    // --inspect, NODE_OPTIONS and NODE_EXTRA_CA_CERTS together: the app comes up and reads none of them. Electron itself
    // refuses most NODE_OPTIONS in a packaged app and says so on stderr, and warns about an unreadable extra CA file:
    // either line, or the script having run, means the variables were read.
    await inst.launch({
      extraEnv: {
        NODE_OPTIONS: `--require ${nodeOptionsScript}`,
        NODE_EXTRA_CA_CERTS: path.join(inst.root, "no-ca.pem"),
      },
    });
    if (await started(inst, "start with the switches", note)) {
      note(
        "--inspect",
        !(await portListens(inst.inspectPort)),
        `nothing listens on the --inspect port ${inst.inspectPort}`
      );
      const output = outputOf(inst);
      const read =
        fs.existsSync(markerNodeOptions) || /NODE_OPTIONs are not supported|Ignoring extra certs/.test(output);
      note(
        "NODE_OPTIONS",
        !read,
        read ? "the main process read NODE_OPTIONS or NODE_EXTRA_CA_CERTS" : "neither was read"
      );
    }
    await inst.stop();

    // ELECTRON_RUN_AS_NODE=1: respected, the binary would run the script and exit; refused, it starts the app.
    const code = `require("fs").writeFileSync(${JSON.stringify(markerRunAsNode)}, "ran")`;
    await inst.launch({
      inspect: false,
      remoteDebugging: false,
      extraArgs: ["-e", code],
      extraEnv: { ELECTRON_RUN_AS_NODE: "1" },
    });
    const startedAsApp = await started(inst, null, note);
    const ranScript = fs.existsSync(markerRunAsNode);
    note(
      "ELECTRON_RUN_AS_NODE",
      startedAsApp && !ranScript,
      ranScript
        ? "the binary ran the script as Node"
        : startedAsApp
          ? "the app started, no script ran"
          : "the app did not start"
    );
    await inst.stop();

    // The cookie probe reads the cookies through the debugging port, which the policy check closes by removing the
    // test profile's mark: it runs first.
    await cookieProbe(inst, note);
    await debuggingPolicy(inst, note);

    if (tamper) {
      await tamperProbe(target, inst, note);
    }
  } finally {
    await inst.dispose({ keep });
  }
  return results;
}

// Waits for the launched app to log wave-ready. With a label, a start that fails is a failed check; without one, the
// caller reads the answer. An app that exits during start-up is not ready.
async function started(inst, label, note) {
  let reason = null;
  try {
    const ready = await inst.waitReady(StartTimeoutMs);
    reason = ready.timedOut ? `no wave-ready in ${StartTimeoutMs} ms` : null;
  } catch (e) {
    reason = e.message;
  }
  if (label) {
    note(label, reason == null, reason ?? "wave-ready logged");
  }
  return reason == null;
}

function outputOf(inst) {
  try {
    return fs.readFileSync(path.join(inst.root, `electron-${inst.launches}.out`), "utf8");
  } catch {
    return "";
  }
}

async function remoteDebugging(inst, note) {
  try {
    const version = await (await fetch(`http://127.0.0.1:${inst.port}/json/version`)).json();
    const pages = (await listTargets(inst.port)).filter((t) => t.type === "page" && t.url.startsWith("file://"));
    if (!pages.length) {
      note("remote debugging", false, "answers, but lists no page loaded from the app (file:)");
      return;
    }
    const client = await connect(pages[0].webSocketDebuggerUrl);
    try {
      const page = await evaluate(
        client,
        `({ state: document.readyState, protocol: location.protocol, packaged: window.api?.getIsDev?.() === false })`
      );
      note(
        "remote debugging",
        page.packaged,
        `${version.Browser}: the app page runs over ${page.protocol} (${page.state}), packaged=${page.packaged}`
      );
    } finally {
      client.close();
    }
  } catch (e) {
    note("remote debugging", false, e.message);
  }
}

// #2057: the debugging switches open a port only on a test profile. The first start, on the instance's new data
// folder, marked its profile and answered on the port (the "remote debugging" check). Here the same folder is seen as
// the build's default one, through a home of the instance's own whose default data folders link to it: the app runs on
// its default profile without the user's ever being opened. Then the mark goes, as on a profile some other start made.
async function debuggingPolicy(inst, note) {
  const profile = path.join(inst.dataDir, "electron");
  const mark = path.join(profile, TestProfileMarkName);
  const marked = fs.existsSync(mark);
  note(
    "test profile",
    marked,
    marked ? "the first start marked its new profile" : `no ${TestProfileMarkName} in ${profile}`
  );
  if (process.platform !== "darwin" && process.platform !== "linux") {
    note("debugging on the default profile", true, `not checked on ${process.platform}`);
    return;
  }
  const home = path.join(inst.root, "home");
  const dataBase =
    process.platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : path.join(home, ".local", "share");
  fs.mkdirSync(dataBase, { recursive: true });
  for (const name of ["moltenterm", "moltenterm-gold"]) {
    fs.symlinkSync(inst.dataDir, path.join(dataBase, name));
  }
  await debuggingRefused(
    inst,
    note,
    "debugging on the default profile",
    { HOME: home, XDG_DATA_HOME: "" },
    "default-profile"
  );
  if (marked) {
    fs.rmSync(mark);
  }
  await debuggingRefused(inst, note, "debugging on an unmarked profile", {}, "unmarked-profile");
}

async function debuggingRefused(inst, note, label, extraEnv, reason) {
  await inst.launch({ inspect: false, extraEnv });
  if (await started(inst, null, note)) {
    const open = await portListens(inst.port);
    const said = inst.log().some((l) => l.s.includes(`remote debugging: ignored (${reason})`));
    note(
      label,
      !open && said,
      open
        ? `the debugging port ${inst.port} answers`
        : said
          ? `no port, and the main log says why (${reason})`
          : `no port, but the main log has no "remote debugging: ignored (${reason})"`
    );
  } else {
    note(label, false, "the app did not start");
  }
  await inst.stop();
}

async function sigusr1(inst, note) {
  const before = listeningPorts(inst.pid);
  if (before == null) {
    note("SIGUSR1", true, "not checked: lsof is not available");
    return;
  }
  process.kill(inst.pid, "SIGUSR1");
  const opened = await waitFor(() => [...listeningPorts(inst.pid)].some((p) => !before.has(p)), SettleMs);
  note("SIGUSR1", !opened, opened ? "the signal opened an inspector port" : "the signal opened no port");
}

// The browser's cookies on disk (#2058): a cookie the app stores holds no clear value, and a row written in clear the way
// an earlier version (fuse off) wrote it is still sent after the update, then stored encrypted. Cookies are set and read
// in the default session (the browser panel's) through the browser's CDP target.
async function cookieProbe(inst, note) {
  const db = path.join(inst.dataDir, "electron", "Cookies");
  const marker = path.join(inst.dataDir, "electron", "moltenterm-cookies-encrypted.json");
  const fresh = { name: "mtqualify", value: `fresh-${process.pid}-${Date.now()}` };
  const old = { name: "mtqualifyold", value: `old-${process.pid}-${Date.now()}` };

  await inst.launch({ inspect: false });
  if (!(await started(inst, null, note))) {
    note("cookie encryption", false, "the app did not start");
    await inst.stop();
    return;
  }
  const set = await browserCdp(inst, (client) =>
    client.send("Storage.setCookies", {
      cookies: [{ ...fresh, domain: "qualify.test", path: "/", httpOnly: true, expires: Date.now() / 1000 + 86400 }],
    })
  );
  await inst.stop();
  if (set?.error) {
    note("cookie encryption", false, `Storage.setCookies: ${set.error.message}`);
    return;
  }
  const stored = await encryptedOnDisk(db, [fresh]);
  note(
    "cookie encryption",
    stored.ok,
    stored.ok ? "a cookie the app stored is encrypted on disk (no clear value, no clear bytes)" : stored.detail
  );
  if (!stored.ok) {
    return;
  }

  // An earlier version's row: the same columns, the value in clear and no encrypted value. The marker goes, as in a
  // profile an earlier version wrote.
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(db);
  try {
    const columns = sqlite
      .prepare("PRAGMA table_info(cookies)")
      .all()
      .map((c) => c.name);
    const pick = columns.map((c) => (c === "name" ? "?" : c === "value" ? "?" : c === "encrypted_value" ? "X''" : c));
    sqlite
      .prepare(`INSERT INTO cookies (${columns.join(", ")}) SELECT ${pick.join(", ")} FROM cookies WHERE name = ?`)
      .run(...columns.flatMap((c) => (c === "name" ? [old.name] : c === "value" ? [old.value] : [])), fresh.name);
  } finally {
    sqlite.close();
  }
  fs.rmSync(marker, { force: true });

  await inst.launch({ inspect: false });
  if (!(await started(inst, null, note))) {
    note("cookie migration", false, "the app did not start on a profile with a clear cookie");
    await inst.stop();
    return;
  }
  const got = await browserCdp(inst, (client) => client.send("Storage.getCookies"));
  await inst.stop();
  const values = Object.fromEntries((got?.result?.cookies ?? []).map((c) => [c.name, c.value]));
  const kept = values[fresh.name] === fresh.value && values[old.name] === old.value;
  const after = await encryptedOnDisk(db, [fresh, old]);
  note(
    "cookie migration",
    kept && after.ok && fs.existsSync(marker),
    !kept
      ? `a cookie was lost or changed after the update (${got?.error?.message ?? "read back"})`
      : !after.ok
        ? after.detail
        : !fs.existsSync(marker)
          ? "the session was not marked as migrated"
          : "the cookie written in clear is still sent and is now stored encrypted"
  );
}

// Runs `fn` with a CDP client on the browser target, the default session's cookie store.
async function browserCdp(inst, fn) {
  try {
    const version = await (await fetch(`http://127.0.0.1:${inst.port}/json/version`)).json();
    const client = await connect(version.webSocketDebuggerUrl);
    try {
      return await fn(client);
    } finally {
      client.close();
    }
  } catch (e) {
    return { error: { message: e.message } };
  }
}

// Each of `cookies` is a row of the database with an encrypted value and no clear one, and none of their values is
// anywhere in the file's bytes (a freed page included).
async function encryptedOnDisk(db, cookies) {
  if (!fs.existsSync(db)) {
    return { ok: false, detail: `${db} does not exist` };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const sqlite = new DatabaseSync(db, { readOnly: true });
  try {
    for (const { name } of cookies) {
      const row = sqlite
        .prepare("SELECT value, length(encrypted_value) AS encrypted FROM cookies WHERE name = ?")
        .get(name);
      if (!row) {
        return { ok: false, detail: `the cookie ${name} is not in the database` };
      }
      if (row.value !== "" || !(row.encrypted > 0)) {
        return { ok: false, detail: `the cookie ${name} is stored in clear` };
      }
    }
  } finally {
    sqlite.close();
  }
  const bytes = fs.readFileSync(db);
  const inBytes = cookies.filter((c) => bytes.includes(Buffer.from(c.value)));
  if (inBytes.length) {
    return { ok: false, detail: `the cookie database file holds ${inBytes.length} value(s) in clear` };
  }
  return { ok: true };
}

// A copy of the app with a changed app.asar must not start. The copy keeps the original seal of the code signature, which
// macOS does not check for a program run from a terminal, so the refusal is the asar integrity check's.
async function tamperProbe(target, inst, note) {
  const copyDir = path.join(inst.root, "tampered");
  fs.mkdirSync(copyDir);
  const copy = path.join(copyDir, path.basename(target));
  fs.cpSync(target, copy, { recursive: true, verbatimSymlinks: true });
  tamperPackageJson(asarOf(copy));
  const tampered = Instance.create(process.cwd(), path.dirname(inst.root), { executable: executableOf(copy) });
  try {
    await tampered.launch({ inspect: false, remoteDebugging: false });
    const exit = new Promise((resolve) => tampered.child.once("exit", (code, signal) => resolve({ code, signal })));
    // A refused app exits at once; one that is merely slow is still running at the deadline, which proves nothing.
    const upOrDown = await Promise.race([
      tampered.waitReady(StartTimeoutMs).then(
        (r) => (r.timedOut ? "slow" : "up"),
        () => "down"
      ),
      exit,
    ]);
    const exited = upOrDown === "down" || typeof upOrDown === "object";
    const how = exited ? await exit : null;
    note(
      "asar integrity",
      exited,
      exited
        ? `an app with a changed app.asar exited (code ${how.code}, signal ${how.signal})`
        : upOrDown === "up"
          ? "an app with a changed app.asar started"
          : "no verdict: the changed app was still starting at the deadline"
    );
  } finally {
    await tampered.dispose({ keep: false });
  }
}

async function main(argv) {
  const target = argv.find((a) => !a.startsWith("--"));
  if (!target || !fs.existsSync(target)) {
    console.error(
      "usage: node scripts/moltenterm-qualify-packaged.mjs <MoltenTerm.app | executable> [--tmp dir] [--keep] [--no-tamper]"
    );
    return 2;
  }
  const tmpAt = argv.indexOf("--tmp");
  installCleanupHandlers();
  const results = await run(path.resolve(target), {
    tmp: tmpAt === -1 ? "/tmp" : argv[tmpAt + 1],
    keep: argv.includes("--keep"),
    tamper: !argv.includes("--no-tamper"),
  });
  const failed = results.filter((r) => !r.ok);
  console.log(
    failed.length ? `${failed.length} of ${results.length} checks failed` : `${results.length} checks passed`
  );
  return failed.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
