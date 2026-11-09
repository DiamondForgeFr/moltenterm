// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

/* global process */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Bsd3Text, GplText, IscText, makeRepository, MitText, PolicyJson, tempRoot, write } from "./fixtures.mjs";
import { buildNotices } from "./notices.mjs";
import { sortComponents } from "./render.mjs";

const Script = path.join(import.meta.dirname, "..", "moltenterm-notices.mjs");
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function repository(options) {
  const root = tempRoot();
  roots.push(root);
  makeRepository(root, options);
  return root;
}

const Packages = {
  "node_modules/zeta": { name: "zeta", version: "2.0.0", license: "MIT", files: { LICENSE: MitText } },
  "node_modules/alpha": { name: "alpha", version: "1.0.0", license: "ISC", files: { "LICENSE.md": IscText } },
  "node_modules/Beta": { name: "Beta", version: "3.1.0", files: { LICENCE: Bsd3Text } },
  "node_modules/alpha/node_modules/zeta": {
    name: "zeta",
    version: "1.5.0",
    license: "MIT",
    files: { LICENSE: MitText.replace("2020", "2018") },
  },
};
const Graph = {
  main: ["node_modules/zeta", "node_modules/alpha"],
  preload: [],
  renderer: ["node_modules/alpha", "node_modules/Beta", "node_modules/zeta", "node_modules/alpha/node_modules/zeta"],
};

describe("buildNotices", () => {
  it("lists every package of the module graphs once per version, sorted, with where it ships", () => {
    const root = repository({ packages: Packages, graph: Graph });
    const result = buildNotices(root, { sources: ["npm"] });
    expect(result.problems).toEqual([]);
    expect(sortComponents(result.entries).map((e) => `${e.component.name}@${e.component.version}`)).toEqual([
      "alpha@1.0.0",
      "Beta@3.1.0",
      "zeta@1.5.0",
      "zeta@2.0.0",
    ]);
    const alpha = result.entries.find((e) => e.component.name === "alpha").component;
    expect(alpha.targets).toEqual(["main", "renderer"]);
    expect(result.text).toContain("alpha 1.0.0 - ISC [main, renderer]");
    expect(result.text).toContain("Beta 3.1.0 - BSD-3-Clause [renderer]");
    expect(result.text).toContain("Demo 1.2.3 - third-party notices");
  });

  it("writes a licence text once for the packages that share it", () => {
    const packages = {
      "node_modules/one": { name: "one", version: "1.0.0", license: "MIT", files: { LICENSE: MitText } },
      "node_modules/two": {
        name: "two",
        version: "1.0.0",
        license: "MIT",
        files: { LICENSE: MitText.replace(/\n/g, "\r\n") + "\n\n" },
      },
    };
    const root = repository({
      packages,
      graph: { main: ["node_modules/one", "node_modules/two"], preload: [], renderer: [] },
    });
    const { text } = buildNotices(root, { sources: ["npm"] });
    expect(text.split("Permission is hereby granted").length - 1).toBe(1);
    expect(text).toMatch(/Applies to:\n {2}one 1\.0\.0\n {2}two 1\.0\.0\n/);
  });

  it("gives the same bytes whatever the order of the manifests, the clock and the machine", () => {
    const first = buildNotices(repository({ packages: Packages, graph: Graph }), { sources: ["npm"] }).text;
    const reversed = {
      main: [...Graph.main].reverse(),
      preload: [],
      renderer: [...Graph.renderer].reverse(),
    };
    const rootB = repository({ packages: Packages, graph: reversed });
    const old = new Date("2001-01-01T00:00:00Z");
    fs.utimesSync(path.join(rootB, "node_modules/zeta/LICENSE"), old, old);
    const second = buildNotices(rootB, { sources: ["npm"] }).text;
    expect(second).toBe(first);
    expect(first).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
    expect(first).not.toContain(rootB);
  });

  it("fails on a package whose licence is not on the allow-list", () => {
    const packages = {
      ...Packages,
      "node_modules/copyleft": {
        name: "copyleft",
        version: "9.0.0",
        license: "GPL-3.0-only",
        files: { COPYING: GplText },
      },
    };
    const graph = { ...Graph, renderer: [...Graph.renderer, "node_modules/copyleft"] };
    const result = buildNotices(repository({ packages, graph }), { sources: ["npm"] });
    expect(result.problems).toEqual(["npm copyleft@9.0.0: GPL-3.0-only (declared) is not on the allow-list"]);
  });

  it("fails on a package whose licence is unknown", () => {
    const packages = {
      "node_modules/mystery": { name: "mystery", version: "0.1.0", files: { LICENSE: "Do what you like." } },
    };
    const root = repository({ packages, graph: { main: ["node_modules/mystery"], preload: [], renderer: [] } });
    const result = buildNotices(root, { sources: ["npm"] });
    expect(result.problems).toEqual([
      "npm mystery@0.1.0: declares no licence and no licence file names a known licence",
    ]);
  });

  it("accepts a reviewed exception and shows its note", () => {
    const policy = {
      ...PolicyJson,
      exceptions: [
        {
          ecosystem: "npm",
          name: "mystery",
          license: "LicenseRef-Mystery",
          reason: "Reviewed: the author confirmed the terms by mail.",
          note: "Used with the author's permission.",
        },
      ],
    };
    const packages = {
      "node_modules/mystery": { name: "mystery", version: "0.1.0", files: { LICENSE: "Do what you like." } },
    };
    const root = repository({ packages, policy, graph: { main: ["node_modules/mystery"], preload: [], renderer: [] } });
    const result = buildNotices(root, { sources: ["npm"] });
    expect(result.problems).toEqual([]);
    expect(result.text).toContain("mystery 0.1.0 - LicenseRef-Mystery [main]");
    expect(result.text).toContain("Used with the author's permission.");
  });

  it("says which target has no module graph, and how to make it", () => {
    const root = repository({ packages: Packages, graph: { main: Graph.main, preload: [] } });
    const result = buildNotices(root, { sources: ["npm"] });
    expect(result.problems).toEqual([
      'no module graph for "renderer" (dist/licenses/graph/renderer.json): run npm run build:prod',
    ]);
  });

  it("requires the graph and the packages of the tsunami scaffold once the scaffold exists", () => {
    const root = repository({ packages: Packages, graph: Graph });
    write(
      root,
      "dist/tsunamiscaffold/nm/zeta/package.json",
      JSON.stringify({ name: "zeta", version: "2.0.0", license: "MIT" })
    );
    write(root, "dist/tsunamiscaffold/nm/zeta/LICENSE", MitText);
    write(
      root,
      "dist/tsunamiscaffold/nm/@scope/inner/package.json",
      JSON.stringify({ name: "@scope/inner", version: "1.0.0", license: "ISC" })
    );
    const missing = buildNotices(root, { sources: ["npm"] });
    expect(missing.problems).toEqual([
      'no module graph for "tsunami" (dist/licenses/graph/tsunami.json): run task build:tsunamiscaffold',
    ]);
    write(root, "dist/licenses/graph/tsunami.json", JSON.stringify({ target: "tsunami", packages: [] }));
    const found = buildNotices(root, { sources: ["npm"] });
    expect(found.problems).toEqual([]);
    const names = found.entries.map((e) => `${e.component.name}@${e.component.version}`).sort();
    expect(names).toContain("@scope/inner@1.0.0");
    const zeta = found.entries.find((e) => e.component.name === "zeta" && e.component.version === "2.0.0").component;
    expect(zeta.targets).toEqual(["main", "renderer", "tsunami scaffold"]);
  });

  it("gives a package that ships no licence file the standard text of its declared licence, with its author", () => {
    const packages = {
      "node_modules/bare": {
        name: "bare",
        version: "1.0.0",
        license: "MIT",
        author: "Jane Doe <jane@example.com> (https://example.com)",
      },
    };
    const root = repository({ packages, graph: { main: ["node_modules/bare"], preload: [], renderer: [] } });
    const result = buildNotices(root, { sources: ["npm"] });
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([
      "npm bare@1.0.0 ships no licence file: the notices hold the standard text of its declared MIT licence, with the author its package.json names",
    ]);
    expect(result.text).toContain("Copyright (c) Jane Doe\n");
    expect(result.text).toContain("bare ships no licence file. It declares the MIT licence");
    expect(result.text).not.toContain("jane@example.com");
    expect(result.text).not.toContain("no licence text is part of this component's package");
  });

  it("names no author it was not given", () => {
    const packages = { "node_modules/bare": { name: "bare", version: "1.0.0", license: "ISC" } };
    const root = repository({ packages, graph: { main: ["node_modules/bare"], preload: [], renderer: [] } });
    const { text } = buildNotices(root, { sources: ["npm"] });
    expect(text).toContain("Copyright (c) the authors of bare");
    expect(text).toContain("its package.json names no author");
  });

  it("warns about a package with no licence file and no standard text for its licence, and still names it", () => {
    const policy = { ...PolicyJson, allowed: [...PolicyJson.allowed, "MPL-2.0"] };
    const packages = { "node_modules/bare": { name: "bare", version: "1.0.0", license: "MPL-2.0" } };
    const root = repository({ packages, policy, graph: { main: ["node_modules/bare"], preload: [], renderer: [] } });
    const result = buildNotices(root, { sources: ["npm"] });
    expect(result.problems).toEqual([]);
    expect(result.warnings).toEqual([
      "npm bare@1.0.0 (MPL-2.0) has no licence file: its notice is the name and the licence only",
    ]);
    expect(result.text).toContain("no licence text is part of this component's package");
  });
});

describe("moltenterm-notices.mjs", () => {
  const run = (root, ...args) => spawnSync(process.execPath, [Script, "--root", root, ...args], { encoding: "utf8" });

  it("writes the notices file and says what it holds", () => {
    const root = repository({ packages: Packages, graph: Graph });
    const out = path.join(root, "out", "notices.txt");
    const result = run(root, "--sources", "npm", "--out", out);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/4 components \(npm\)/);
    expect(fs.readFileSync(out, "utf8")).toContain("alpha 1.0.0 - ISC");
  });

  it("exits 1 and writes nothing when a licence is not allowed", () => {
    const packages = { "node_modules/copyleft": { name: "copyleft", version: "9.0.0", license: "GPL-3.0-only" } };
    const root = repository({ packages, graph: { main: ["node_modules/copyleft"], preload: [], renderer: [] } });
    const out = path.join(root, "notices.txt");
    const result = run(root, "--sources", "npm", "--out", out);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("npm copyleft@9.0.0: GPL-3.0-only (declared) is not on the allow-list");
    expect(result.stderr).toContain("build/moltenterm/license-policy.json");
    expect(fs.existsSync(out)).toBe(false);
  });

  it("only checks with --check", () => {
    const root = repository({ packages: Packages, graph: Graph });
    const result = run(root, "--check", "--sources", "npm");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("third-party licences: 4 components (npm), all allowed");
    expect(fs.existsSync(path.join(root, "dist/licenses/THIRD-PARTY-NOTICES.txt"))).toBe(false);
  });

  it("refuses to write a subset where the package takes its file from", () => {
    const root = repository({ packages: Packages, graph: Graph });
    const result = run(root, "--sources", "npm");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("holds every source");
    expect(fs.existsSync(path.join(root, "dist/licenses/THIRD-PARTY-NOTICES.txt"))).toBe(false);
  });

  it("refuses an unknown source and an unknown argument", () => {
    const root = repository({ packages: Packages, graph: Graph });
    expect(run(root, "--check", "--sources", "pip").status).toBe(2);
    expect(run(root, "--frobnicate").status).toBe(2);
  });
});
