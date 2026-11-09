// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The npm packages that ship (#2126): the ones the bundler's module graph lists for Electron main, the preload and the
// renderer (frontend/moltenterm-shell/build/bundled-packages.ts), and the packages the tsunami scaffold carries whole.

import fs from "node:fs";
import path from "node:path";
import { readLicenseFiles } from "./files.mjs";
import { authorName } from "./templates.mjs";

export const GraphDir = "dist/licenses/graph";
// The targets every build writes.
export const RequiredTargets = ["main", "preload", "renderer"];
// The scaffold of tsunami apps is built apart (task build:tsunamiscaffold): its graph and its folder are required once
// the scaffold exists, which is what a package build has.
export const ScaffoldDir = "dist/tsunamiscaffold";
export const ScaffoldTarget = "tsunami";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function readGraph(root, target) {
  const file = path.join(root, GraphDir, `${target}.json`);
  if (!fs.existsSync(file)) {
    return null;
  }
  return readJson(file);
}

// What package.json says about the licence: an SPDX expression, or null when it says nothing usable.
export function declaredLicense(meta) {
  const entryOf = (value) => (typeof value === "string" ? value : typeof value?.type === "string" ? value.type : null);
  let declared = entryOf(meta.license);
  if (declared == null && Array.isArray(meta.licenses)) {
    const types = meta.licenses.map(entryOf).filter((type) => type != null);
    declared = types.length > 1 ? `(${types.join(" OR ")})` : (types[0] ?? null);
  }
  if (declared == null) {
    return null;
  }
  return declared.trim() === "" ? null : declared.trim();
}

function repositoryOf(meta) {
  const value = typeof meta.repository === "string" ? meta.repository : meta.repository?.url;
  if (typeof value !== "string") {
    return null;
  }
  return value
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/\.git$/, "");
}

export function readPackage(root, dir) {
  // A folder outside the repository (a linked package) is listed by its absolute path, which resolve keeps.
  const file = path.resolve(root, dir, "package.json");
  if (!fs.existsSync(file)) {
    return null;
  }
  const meta = readJson(file);
  if (typeof meta.name !== "string" || typeof meta.version !== "string") {
    return null;
  }
  return {
    ecosystem: "npm",
    name: meta.name,
    version: meta.version,
    declared: declaredLicense(meta),
    author: authorName(meta.author),
    url: typeof meta.homepage === "string" ? meta.homepage : repositoryOf(meta),
    files: readLicenseFiles(path.resolve(root, dir)),
    dir,
  };
}

// Every package folder of a node_modules tree: node_modules/<name>, node_modules/@scope/<name> and the nested ones.
export function packageDirsIn(root, nodeModules) {
  const dirs = [];
  const visit = (nm) => {
    const abs = path.join(root, nm);
    if (!fs.existsSync(abs)) {
      return;
    }
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      const names = entry.name.startsWith("@")
        ? fs
            .readdirSync(path.join(abs, entry.name), { withFileTypes: true })
            .filter((child) => child.isDirectory())
            .map((child) => `${entry.name}/${child.name}`)
        : [entry.name];
      for (const name of names) {
        const dir = `${nm}/${name}`;
        dirs.push(dir);
        visit(`${dir}/node_modules`);
      }
    }
  };
  visit(nodeModules);
  return dirs.sort();
}

// The graph manifests: { missing: [target], listed: Map<dir, { targets: Set }> }.
export function listedPackages(root, { scaffold }) {
  const targets = scaffold ? [...RequiredTargets, ScaffoldTarget] : RequiredTargets;
  const listed = new Map();
  const missing = [];
  for (const target of targets) {
    const graph = readGraph(root, target);
    if (graph == null) {
      missing.push(target);
      continue;
    }
    for (const pkg of graph.packages) {
      const entry = listed.get(pkg.dir) ?? { targets: new Set() };
      entry.targets.add(target);
      listed.set(pkg.dir, entry);
    }
  }
  return { listed, missing };
}

// The components, one per name and version, each with where it ships: { ...package, targets, dirs }.
export function collectNpm(root) {
  const scaffold = fs.existsSync(path.join(root, ScaffoldDir));
  const { listed, missing } = listedPackages(root, { scaffold });
  const problems = missing.map(
    (target) =>
      `no module graph for "${target}" (${GraphDir}/${target}.json): ` +
      (target === ScaffoldTarget ? "run task build:tsunamiscaffold" : "run npm run build:prod")
  );
  const places = new Map(listed);
  if (scaffold) {
    for (const dir of packageDirsIn(root, `${ScaffoldDir}/nm`)) {
      const entry = places.get(dir) ?? { targets: new Set() };
      entry.targets.add("tsunami scaffold");
      places.set(dir, entry);
    }
  }
  const byKey = new Map();
  for (const [dir, place] of [...places].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const pkg = readPackage(root, dir);
    if (pkg == null) {
      problems.push(`${dir} has no package.json with a name and a version`);
      continue;
    }
    const key = `${pkg.name}@${pkg.version}`;
    const known = byKey.get(key);
    if (known == null) {
      byKey.set(key, { ...pkg, targets: new Set(place.targets), dirs: [dir] });
      continue;
    }
    known.dirs.push(dir);
    for (const target of place.targets) {
      known.targets.add(target);
    }
    if (known.files.length === 0) {
      known.files = pkg.files;
    }
  }
  const components = [...byKey.values()].map((component) => ({
    ...component,
    targets: [...component.targets].sort(),
  }));
  return { components, problems };
}
