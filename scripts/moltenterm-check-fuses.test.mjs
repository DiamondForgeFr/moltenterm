// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

/* global process, Buffer */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkPackagedApp,
  ElectronFuses,
  FuseDisabled,
  fuseDrift,
  FuseEnabled,
  fuseFile,
  FuseRemoved,
  FuseWireOrder,
  integrityProblems,
  namedStates,
  readFuseWires,
  Sentinel,
} from "./moltenterm-check-fuses.mjs";
import { asarOf, executableOf, tamperPackageJson } from "./moltenterm-qualify-packaged.mjs";
import { connectMain } from "./perf/lib/cdp.mjs";
import { freePort, Instance } from "./perf/lib/instance.mjs";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// Loaded while the file is collected: electron-builder takes seconds to load, more than a test's timeout.
const builderConfig = require("../electron-builder.config.cjs");
const dirs = [];
// A test that starts a process only bounds a failing run: a loaded machine takes seconds to start one.
const GenerousMs = 60000;

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mt-fuses-"));
  dirs.push(dir);
  return dir;
}

// The wire of a binary: Electron's defaults, as in node_modules/electron, with `changes` applied by fuse name.
const ElectronDefaults = {
  runAsNode: true,
  enableCookieEncryption: false,
  enableNodeOptionsEnvironmentVariable: true,
  enableNodeCliInspectArguments: true,
  enableEmbeddedAsarIntegrityValidation: false,
  onlyLoadAppFromAsar: false,
  loadBrowserProcessSpecificV8Snapshot: false,
  grantFileProtocolExtraPrivileges: true,
};

function binaryWith(changes = {}, { slices = 1, extra = 1 } = {}) {
  const wire = { ...ElectronDefaults, ...changes };
  const states = [...FuseWireOrder.map((name) => (wire[name] ? FuseEnabled : FuseDisabled))];
  for (let i = 0; i < extra; i++) {
    states.push(FuseEnabled);
  }
  const slice = Buffer.concat([
    Buffer.from("not a fuse "),
    Buffer.from(Sentinel),
    Buffer.from([1, states.length, ...states]),
    Buffer.from(" more bytes"),
  ]);
  return Buffer.concat(Array.from({ length: slices }, () => slice));
}

describe("the fuses a packaged build carries (#1975)", () => {
  it("are set in electron-builder's config, from the one file that says why", () => {
    expect(builderConfig.electronFuses).toBe(require("../build/moltenterm/electron-fuses.cjs").ElectronFuses);
  });

  it("turn run-as-node, NODE_OPTIONS and the CLI inspector off, and the asar checks on", () => {
    expect(ElectronFuses).toMatchObject({
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
    });
  });

  it("keep the file protocol privileges while an app page is loaded with loadFile()", () => {
    const loadsFromFile = ["emain-tabview.ts", "emain-builder.ts"].some((file) =>
      /\.loadFile\(/.test(fs.readFileSync(path.join(root, "emain", file), "utf8"))
    );
    expect(ElectronFuses.grantFileProtocolExtraPrivileges).toBe(loadsFromFile);
  });

  it("name only fuses the wire has", () => {
    for (const name of Object.keys(ElectronFuses)) {
      expect(FuseWireOrder).toContain(name);
    }
  });
});

describe("reading the fuse wire", () => {
  it("finds the sentinel, the version and every fuse by name", () => {
    const [wire, ...others] = readFuseWires(binaryWith({ runAsNode: false }));
    expect(others).toEqual([]);
    expect(wire.version).toBe(1);
    expect(namedStates(wire)).toMatchObject({ runAsNode: FuseDisabled, enableNodeCliInspectArguments: FuseEnabled });
    expect(namedStates(wire).fuse8).toBe(FuseEnabled);
  });

  it("finds one wire per slice of a universal binary", () => {
    expect(readFuseWires(binaryWith({}, { slices: 2 }))).toHaveLength(2);
  });

  it("finds nothing in a file that is not Electron", () => {
    expect(readFuseWires(Buffer.from("just a program"))).toEqual([]);
  });

  it("ignores a sentinel cut short by the end of the file", () => {
    expect(readFuseWires(Buffer.concat([Buffer.from(Sentinel), Buffer.from([1, 9, 0x31])]))).toEqual([]);
  });
});

describe("the drift from the expected fuses", () => {
  const hardened = {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
  };

  it("is empty for a build with the fuses flipped", () => {
    expect(fuseDrift(readFuseWires(binaryWith(hardened)))).toEqual([]);
  });

  it("names every fuse of a build left at Electron's defaults", () => {
    const drift = fuseDrift(readFuseWires(binaryWith({})));
    expect(drift).toHaveLength(5);
    expect(drift.join("\n")).toMatch(/runAsNode is on, expected off/);
    expect(drift.join("\n")).toMatch(/enableNodeOptionsEnvironmentVariable is on, expected off/);
    expect(drift.join("\n")).toMatch(/enableNodeCliInspectArguments is on, expected off/);
    expect(drift.join("\n")).toMatch(/enableEmbeddedAsarIntegrityValidation is off, expected on/);
    expect(drift.join("\n")).toMatch(/onlyLoadAppFromAsar is off, expected on/);
  });

  it("catches a single fuse flipped back", () => {
    const drift = fuseDrift(readFuseWires(binaryWith({ ...hardened, runAsNode: true })));
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatch(/runAsNode is on/);
  });

  it("checks every slice of a universal binary", () => {
    const good = binaryWith(hardened);
    const bad = binaryWith({ ...hardened, enableNodeCliInspectArguments: true });
    expect(fuseDrift(readFuseWires(Buffer.concat([good, bad])))).toHaveLength(1);
    expect(fuseDrift(readFuseWires(Buffer.concat([bad, good])))).toHaveLength(1);
  });

  it("says what is wrong with a file without a wire", () => {
    expect(fuseDrift([])[0]).toMatch(/no Electron fuse wire/);
  });

  it("reports a fuse that Electron removed from the wire as not on", () => {
    const binary = binaryWith(hardened);
    const at = binary.indexOf(Buffer.from(Sentinel)) + Sentinel.length + 2;
    binary[at] = FuseRemoved;
    expect(fuseDrift(readFuseWires(binary))[0]).toMatch(/runAsNode is removed, expected off/);
  });

  it("asks the macOS app for its asar hash when the integrity fuse is on", () => {
    const hash = "a".repeat(64);
    expect(integrityProblems({ "Resources/app.asar": { algorithm: "SHA256", hash } })).toEqual([]);
    expect(integrityProblems(null)).toHaveLength(1);
    expect(integrityProblems({ "Resources/app.asar": { algorithm: "SHA256", hash: "short" } })).toHaveLength(1);
    expect(integrityProblems(undefined)).toEqual([]);
  });
});

describe("a packaged app on disk", () => {
  it("reads the framework inside a macOS app and the file itself elsewhere", () => {
    expect(fuseFile("/x/MoltenTerm.app")).toBe(
      "/x/MoltenTerm.app/Contents/Frameworks/Electron Framework.framework/Electron Framework"
    );
    expect(fuseFile("/x/moltenterm")).toBe("/x/moltenterm");
  });

  it(
    "checks an executable and the command line exits 0, 1 or 2",
    () => {
      const dir = tempDir();
      const good = path.join(dir, "good");
      const bad = path.join(dir, "bad");
      fs.writeFileSync(
        good,
        binaryWith({
          runAsNode: false,
          enableNodeOptionsEnvironmentVariable: false,
          enableNodeCliInspectArguments: false,
          enableEmbeddedAsarIntegrityValidation: true,
          onlyLoadAppFromAsar: true,
        })
      );
      fs.writeFileSync(bad, binaryWith({}));
      expect(checkPackagedApp(good).problems).toEqual([]);
      expect(checkPackagedApp(bad).problems).toHaveLength(5);
      expect(checkPackagedApp(path.join(dir, "missing")).problems[0]).toMatch(/does not exist/);

      const script = path.join(root, "scripts", "moltenterm-check-fuses.mjs");
      const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
      expect(run(good).status).toBe(0);
      const failed = run(bad);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toMatch(/runAsNode is on, expected off/);
      expect(run().status).toBe(2);
    },
    GenerousMs
  );
});

describe("the qualification of a packaged app", () => {
  it("finds the executable and the asar of a macOS app and of a Linux build", () => {
    const dir = tempDir();
    const app = path.join(dir, "MoltenTerm.app");
    fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(app, "Contents", "MacOS", "MoltenTerm"), "");
    expect(executableOf(app)).toBe(path.join(app, "Contents", "MacOS", "MoltenTerm"));
    expect(asarOf(app)).toBe(path.join(app, "Contents", "Resources", "app.asar"));
    expect(executableOf("/opt/moltenterm/moltenterm")).toBe("/opt/moltenterm/moltenterm");
    expect(asarOf("/opt/moltenterm/moltenterm")).toBe("/opt/moltenterm/resources/app.asar");
  });

  it("changes one letter of package.json in an asar and keeps the archive's layout", () => {
    const dir = tempDir();
    const asar = path.join(dir, "app.asar");
    const pkg = '{"name":"x","description":"A terminal","main":"index.js"}';
    const other = "console.log(1)";
    const header = JSON.stringify({
      files: {
        "index.js": { size: other.length, offset: "0" },
        "package.json": { size: pkg.length, offset: String(other.length) },
      },
    });
    const json = Buffer.from(header);
    const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4)]);
    const headerPickle = Buffer.alloc(8);
    headerPickle.writeUInt32LE(4 + padded.length, 0);
    headerPickle.writeUInt32LE(json.length, 4);
    const size = Buffer.alloc(8);
    size.writeUInt32LE(4, 0);
    size.writeUInt32LE(headerPickle.length + padded.length, 4);
    const original = Buffer.concat([size, headerPickle, padded, Buffer.from(other), Buffer.from(pkg)]);
    fs.writeFileSync(asar, original);

    const { offset } = tamperPackageJson(asar);
    const changed = fs.readFileSync(asar);
    expect(changed).toHaveLength(original.length);
    const diff = [...changed].flatMap((byte, i) => (byte === original[i] ? [] : [i]));
    expect(diff).toEqual([offset]);
    expect(changed.subarray(-pkg.length).toString()).toBe(pkg.replace('"A terminal"', '"X terminal"'));
    expect(() => JSON.parse(changed.subarray(-pkg.length).toString())).not.toThrow();
  });
});

describe("the perf harness and a packaged app", () => {
  it("says why a packaged app has no main-process inspector", async () => {
    await expect(connectMain(await freePort())).rejects.toThrow(/EnableNodeCliInspectArguments fuse/);
  });

  // A program that records how it was started, standing in for the packaged app.
  async function launched(options) {
    const dir = tempDir();
    const record = path.join(dir, "record.json");
    const fake = path.join(dir, "fake-app");
    fs.writeFileSync(
      fake,
      `#!${process.execPath}\nrequire("fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env }));\n`,
      { mode: 0o755 }
    );
    const inst = Instance.create(root, dir, { executable: fake });
    try {
      process.env.ELECTRON_RUN_AS_NODE = "1";
      await inst.launch(options);
      await new Promise((resolve) => inst.child.once("exit", resolve));
      return { ...JSON.parse(fs.readFileSync(record, "utf8")), inst };
    } finally {
      delete process.env.ELECTRON_RUN_AS_NODE;
      await inst.dispose();
    }
  }

  it(
    "starts a packaged app without the checkout as its app, from its own root",
    async () => {
      const { args, cwd, inst, env } = await launched({ extraArgs: ["-e", "1"] });
      expect(args).not.toContain(".");
      expect(args).toEqual(
        expect.arrayContaining([`--remote-debugging-port=${inst.port}`, `--inspect=${inst.inspectPort}`])
      );
      expect(args.slice(-2)).toEqual(["-e", "1"]);
      expect(cwd).toBe(inst.root);
      expect(env.MOLTENTERM_DATA_HOME).toBe(inst.dataDir);
      expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    },
    GenerousMs
  );

  it(
    "leaves the inspector and the debugging port out when a probe asks, and adds the environment it names",
    async () => {
      const { args, env } = await launched({
        inspect: false,
        remoteDebugging: false,
        extraEnv: { ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--no-warnings" },
      });
      expect(args.some((a) => a.startsWith("--inspect") || a.startsWith("--remote-debugging-port"))).toBe(false);
      expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(env.NODE_OPTIONS).toBe("--no-warnings");
    },
    GenerousMs
  );
});
