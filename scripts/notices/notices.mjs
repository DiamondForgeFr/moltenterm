// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Third-party notices (#2126): what ships, which licence each part is under, whether the policy accepts it, and the
// THIRD-PARTY-NOTICES.txt that says so. scripts/moltenterm-notices.mjs is the command line.

import fs from "node:fs";
import path from "node:path";
import { collectAssets } from "./assets.mjs";
import { collectGo } from "./golang.mjs";
import { collectNpm } from "./npm.mjs";
import { judge, loadPolicy, staleExceptions } from "./policy.mjs";
import { renderNotices } from "./render.mjs";
import { standardNotice } from "./templates.mjs";

export const NoticesFile = "dist/licenses/THIRD-PARTY-NOTICES.txt";
export const Sources = ["npm", "go", "assets"];

const Collectors = { npm: collectNpm, go: collectGo, assets: collectAssets };
// The policy's name for the ecosystem each source yields.
const EcosystemOfSource = { npm: "npm", go: "go", assets: "asset" };

export function nameOf(component) {
  return `${component.ecosystem} ${component.name}${component.version === "" ? "" : `@${component.version}`}`;
}

// A package that ships no licence file gets the standard text of the one licence it declares, when there is a template.
function withStandardNotice(component, verdict) {
  if (component.files.length > 0 || verdict.source !== "declared" || verdict.relied.length !== 1) {
    return component;
  }
  const notice = standardNotice(component, verdict.relied[0]);
  return notice == null ? component : { ...component, files: [notice], standard: true };
}

// A verdict for every component, and the problems: a licence that is unknown or not allowed.
export function assess(components, policy) {
  const entries = components.map((component) => {
    const verdict = judge(component, policy);
    return { component: withStandardNotice(component, verdict), verdict };
  });
  const problems = entries
    .filter((entry) => !entry.verdict.allowed)
    .map((entry) => `${nameOf(entry.component)}: ${entry.verdict.problem}`);
  return { entries, problems };
}

export function warningsOf(entries) {
  const warnings = [];
  for (const { component, verdict } of entries) {
    if (component.standard) {
      warnings.push(
        `${nameOf(component)} ships no licence file: the notices hold the standard text of its declared ${verdict.expression} licence, with the author its package.json names`
      );
    } else if (component.files.length === 0 && verdict.exception?.noText !== true) {
      warnings.push(
        `${nameOf(component)} (${verdict.expression}) has no licence file: its notice is the name and the licence only`
      );
    }
  }
  return warnings;
}

export function collect(root, sources = Sources) {
  const components = [];
  const problems = [];
  for (const source of sources) {
    const result = Collectors[source](root);
    components.push(...result.components);
    problems.push(...result.problems);
  }
  return { components, problems };
}

export function readProduct(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  return { product: pkg.productName ?? pkg.name, version: pkg.version };
}

// Everything a run needs: { entries, problems, warnings, stale, text }.
export function buildNotices(root, { sources = Sources, policy = loadPolicy(root) } = {}) {
  const collected = collect(root, sources);
  const { entries, problems } = assess(collected.components, policy);
  const ecosystems = sources.map((source) => EcosystemOfSource[source]);
  const stale = staleExceptions(policy, collected.components, ecosystems);
  const { product, version } = readProduct(root);
  return {
    entries,
    problems: [...collected.problems, ...problems],
    warnings: warningsOf(entries),
    stale,
    text: renderNotices({ product, version, entries }),
  };
}
