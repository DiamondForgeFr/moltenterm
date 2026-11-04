// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

/* global process, URL */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  changedLines,
  commitReader,
  FixCommand,
  lockDrift,
  LockFile,
  manifestsOf,
  npmVersionNote,
  treeReader,
} from "./moltenterm-check-lockfile.mjs";

const ScriptFile = fileURLToPath(new URL("./moltenterm-check-lockfile.mjs", import.meta.url));
const RepoRoot = path.resolve(path.dirname(ScriptFile), "..");
// Every case starts npm, which a loaded machine makes slow: only the bound of a hung run.
const NpmTimeout = { timeout: 120_000 };
const WorkspaceManifest = "ws/package.json";

function fixture() {
  return {
    manifest: {
      name: "fixture",
      version: "1.0.0-1",
      license: "AGPL-3.0-only AND Apache-2.0",
      dependencies: { "is-odd": "^3.0.0" },
      overrides: { "is-number": "6.0.0" },
      workspaces: ["ws"],
    },
    workspace: {
      name: "fixture-ws",
      version: "0.1.0",
      license: "Apache-2.0",
      dependencies: { "left-pad": "^1.2.0" },
    },
    // As npm 10 wrote it for these manifests: a test run never reaches the registry.
    lock: {
      name: "fixture",
      version: "1.0.0-1",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "fixture",
          version: "1.0.0-1",
          license: "AGPL-3.0-only AND Apache-2.0",
          workspaces: ["ws"],
          dependencies: { "is-odd": "^3.0.0" },
        },
        "node_modules/fixture-ws": { resolved: "ws", link: true },
        "node_modules/is-number": {
          version: "6.0.0",
          resolved: "https://registry.npmjs.org/is-number/-/is-number-6.0.0.tgz",
          integrity: "sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==",
          license: "MIT",
          engines: { node: ">=0.10.0" },
        },
        "node_modules/is-odd": {
          version: "3.0.1",
          resolved: "https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz",
          integrity: "sha512-CQpnWPrDwmP1+SMHXZhtLtJv90yiyVfluGsX5iNCVkrhQtU3TQHsUWPG9wkdk9Lgd5yNpAg9jQEo90CBaXgWMA==",
          license: "MIT",
          dependencies: { "is-number": "^6.0.0" },
          engines: { node: ">=4" },
        },
        "node_modules/left-pad": {
          version: "1.3.0",
          resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
          integrity: "sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQGinBN9yTQT3bFlCBy/aVx2HrNcqQGsdot8ghrjyrvMCoEA==",
          deprecated: "use String.prototype.padStart()",
          license: "WTFPL",
        },
        ws: {
          name: "fixture-ws",
          version: "0.1.0",
          license: "Apache-2.0",
          dependencies: { "left-pad": "^1.2.0" },
        },
      },
    },
  };
}

function text(value) {
  return `${JSON.stringify(value, null, 4)}\n`;
}

function textsOf({ manifest, workspace, lock }) {
  return { "package.json": text(manifest), [WorkspaceManifest]: text(workspace), [LockFile]: text(lock) };
}

function readerOf(project) {
  const texts = textsOf(project);
  return (file) => texts[file];
}

function driftOf(mutate) {
  const project = fixture();
  mutate(project);
  return lockDrift(readerOf(project));
}

function setAt(value, keys, leaf) {
  const parent = keys.slice(0, -1).reduce((node, key) => node[key], value);
  parent[keys[keys.length - 1]] = leaf;
}

describe("manifestsOf", () => {
  it("lists the root manifest, then each workspace's", () => {
    expect(manifestsOf({ workspaces: ["docs", "tsunami/frontend"] })).toEqual([
      "package.json",
      "docs/package.json",
      "tsunami/frontend/package.json",
    ]);
  });

  it("is the root manifest alone without workspaces", () => {
    expect(manifestsOf({})).toEqual(["package.json"]);
  });
});

describe("changedLines", () => {
  it("shows what left and what came", () => {
    expect(changedLines('    "a": 1,\n    "b": 2,\n', '    "a": 1,\n    "b": 3,\n')).toEqual([
      '- "b": 2,',
      '+ "b": 3,',
    ]);
  });

  it("counts a repeated line, which a plain lookup would call unchanged", () => {
    expect(changedLines('"dev": true,\n"dev": true,\nend', '"dev": true,\nend')).toEqual(['- "dev": true,']);
  });

  it("is empty for the same text", () => {
    expect(changedLines("a\nb\n", "a\nb\n")).toEqual([]);
  });
});

describe("npmVersionNote", () => {
  it("says nothing under the pinned npm, or when none is pinned", () => {
    expect(npmVersionNote("npm@10.9.2", "10.9.2")).toBeNull();
    expect(npmVersionNote(undefined, "10.9.2")).toBeNull();
  });

  it("names both versions otherwise", () => {
    const note = npmVersionNote("npm@10.9.2", "11.0.0");
    expect(note).toContain("npm 11.0.0");
    expect(note).toContain("npm@10.9.2");
  });
});

describe("lockDrift", NpmTimeout, () => {
  it("accepts a lock npm would leave as it is, without the network", () => {
    expect(driftOf(() => {})).toBeNull();
  });

  it("accepts a manifest change the lock does not record", () => {
    expect(driftOf(({ manifest }) => (manifest.description = "changed"))).toBeNull();
  });

  it("shows the lines npm would rewrite", () => {
    const drift = driftOf(({ lock }) => (lock.packages[""].license = "Apache-2.0"));
    expect(drift.message).toContain("would rewrite");
    expect(drift.lines).toEqual(['- "license": "Apache-2.0",', '+ "license": "AGPL-3.0-only AND Apache-2.0",']);
  });

  it("names what npm cannot find offline", () => {
    const drift = driftOf(({ manifest }) => (manifest.dependencies["not-in-the-lock"] = "^1.0.0"));
    expect(drift.message).toContain("cannot settle");
    expect(drift.lines.join("\n")).toContain("not-in-the-lock");
  });

  it.each([
    ["the root licence", ({ lock }) => (lock.packages[""].license = "Apache-2.0")],
    ["the lock's name", ({ lock }) => (lock.name = "other")],
    ["the root entry's name", ({ lock }) => (lock.packages[""].name = "other")],
    ["the lock's version", ({ lock }) => (lock.version = "0.0.1")],
    ["the root entry's version", ({ lock }) => (lock.packages[""].version = "0.0.1")],
    ["package.json's name alone", ({ manifest }) => (manifest.name = "renamed")],
    ["package.json's version alone", ({ manifest }) => (manifest.version = "1.0.0-2")],
    ["package.json's licence alone", ({ manifest }) => (manifest.license = "MIT")],
    ["a dependency the lock lacks", ({ manifest }) => (manifest.dependencies["not-in-the-lock"] = "^1.0.0")],
    ["a dependency removed", ({ manifest }) => delete manifest.dependencies["is-odd"]],
    ["a range still satisfied", ({ manifest }) => (manifest.dependencies["is-odd"] = "^3.0.1")],
    ["a range no longer satisfied", ({ manifest }) => (manifest.dependencies["is-odd"] = "^2.0.0")],
    ["an override changed", ({ manifest }) => (manifest.overrides["is-number"] = "6.0.1")],
    ["a locked version edited by hand", ({ lock }) => (lock.packages["node_modules/is-odd"].version = "1.0.0")],
    ["a package no manifest reaches", ({ lock }) => (lock.packages["node_modules/orphan"] = { version: "1.0.0" })],
    ["a workspace's version", ({ workspace }) => (workspace.version = "0.2.0")],
    ["a workspace's licence", ({ workspace }) => (workspace.license = "MIT")],
    ["a workspace's range", ({ workspace }) => (workspace.dependencies["left-pad"] = "^1.3.0")],
    ["a workspace's dependency the lock lacks", ({ workspace }) => (workspace.dependencies["not-locked"] = "^1.0.0")],
    ["a workspace dropped from the root", ({ manifest }) => (manifest.workspaces = [])],
  ])("refuses a drift of %s", (_, mutate) => {
    expect(driftOf(mutate)).not.toBeNull();
  });

  it("refuses a lock left with merge conflict markers", () => {
    const project = fixture();
    const texts = textsOf(project);
    const conflicted = texts[LockFile].replace(
      '    "version": "1.0.0-1",\n    "lockfileVersion"',
      '<<<<<<< HEAD\n    "version": "1.0.0-1",\n=======\n    "version": "1.0.0-0",\n>>>>>>> other\n    "lockfileVersion"'
    );
    expect(conflicted).not.toBe(texts[LockFile]);
    expect(lockDrift((file) => (file === LockFile ? conflicted : texts[file]))).not.toBeNull();
  });

  it("throws when a file cannot be read, rather than calling the lock fine", () => {
    const readable = readerOf(fixture());
    const missing = (file) => {
      if (file === WorkspaceManifest) {
        throw new Error(`no ${file}`);
      }
      return readable(file);
    };
    expect(() => lockDrift(missing)).toThrow(`no ${WorkspaceManifest}`);
  });
});

describe("the release flow", NpmTimeout, () => {
  const { versions } = JSON.parse(fs.readFileSync(path.join(RepoRoot, ".molten/project.json"), "utf8"));
  const targetOf = (project, file) => (file === LockFile ? project.lock : project.manifest);
  const bumps = versions.files.flatMap(({ path: file, keys }) => keys.map((key) => ({ file, key })));

  it("declares a bump of package.json and of both version keys of the lock", () => {
    expect(bumps).toEqual([
      { file: "package.json", key: ["version"] },
      { file: LockFile, key: ["version"] },
      { file: LockFile, key: ["packages", "", "version"] },
    ]);
  });

  it("stays green after the keys .molten/project.json bumps", () => {
    const project = fixture();
    for (const { file, key } of bumps) {
      setAt(targetOf(project, file), key, "1.0.0-2");
    }
    expect(lockDrift(readerOf(project))).toBeNull();
  });

  it.each(bumps.map((bump) => [`${bump.file} ${JSON.stringify(bump.key)}`, bump]))(
    "turns red when the bump forgets %s",
    (_, forgotten) => {
      const project = fixture();
      for (const bump of bumps.filter((b) => b !== forgotten)) {
        setAt(targetOf(project, bump.file), bump.key, "1.0.0-2");
      }
      expect(lockDrift(readerOf(project))).not.toBeNull();
    }
  );
});

describe("the command", NpmTimeout, () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function write(root, texts) {
    for (const [file, content] of Object.entries(texts)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    }
  }

  function checkoutOf(texts) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lockfile-test-"));
    roots.push(root);
    write(root, texts);
    fs.mkdirSync(path.join(root, "scripts"));
    fs.copyFileSync(ScriptFile, path.join(root, "scripts", path.basename(ScriptFile)));
    return root;
  }

  function commitAll(root) {
    const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "--quiet");
    git("add", "--all");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "x");
  }

  function run(root, ...args) {
    return spawnSync(process.execPath, [path.join("scripts", path.basename(ScriptFile)), ...args], {
      cwd: root,
      encoding: "utf8",
    });
  }

  function drifted() {
    const project = fixture();
    project.lock.packages[""].license = "Apache-2.0";
    return textsOf(project);
  }

  it("exits 0 on a lock in sync and leaves the checkout untouched", () => {
    const root = checkoutOf(textsOf(fixture()));
    const before = fs.readdirSync(root).sort();
    const result = run(root);
    expect(result.stdout).toContain("matches package.json");
    expect(result.status).toBe(0);
    expect(fs.readdirSync(root).sort()).toEqual(before);
  });

  it("exits 1 on drift, with the changed lines and the way out", () => {
    const root = checkoutOf(drifted());
    const before = fs.readFileSync(path.join(root, LockFile), "utf8");
    const result = run(root);
    expect(result.stdout).toContain('- "license": "Apache-2.0",');
    expect(result.stdout).toContain(FixCommand);
    expect(result.status).toBe(1);
    expect(fs.readFileSync(path.join(root, LockFile), "utf8")).toBe(before);
  });

  it("exits 2 when it cannot run, so a missing lock never reads as a green check", () => {
    const texts = textsOf(fixture());
    delete texts[LockFile];
    const result = run(checkoutOf(texts));
    expect(result.stderr).toContain("cannot run");
    expect(result.status).toBe(2);
  });

  it("sees through an install that healed the lock, with --committed", () => {
    const root = checkoutOf(drifted());
    commitAll(root);
    write(root, textsOf(fixture()));
    expect(run(root).status).toBe(0);
    const committed = run(root, "--committed");
    expect(committed.stdout).toContain('- "license": "Apache-2.0",');
    expect(committed.status).toBe(1);
  });

  it("reads a lock in sync from HEAD whatever the tree holds, with --committed", () => {
    const root = checkoutOf(textsOf(fixture()));
    commitAll(root);
    write(root, drifted());
    expect(run(root, "--committed").status).toBe(0);
    expect(lockDrift(commitReader(root))).toBeNull();
    expect(lockDrift(treeReader(root))).not.toBeNull();
  });
});
