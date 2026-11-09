// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The licence policy (#2126): which licences MoltenTerm may ship, and the reviewed cases that are shipped anyway.
// build/moltenterm/license-policy.json holds both; a change to it is a change someone reviews.

import fs from "node:fs";
import path from "node:path";
import { detectLicenses } from "./classify.mjs";
import { evaluate, formatExpression, parseExpression } from "./spdx.mjs";

export const PolicyFile = "build/moltenterm/license-policy.json";
export const Ecosystems = ["npm", "go", "asset"];

export function parsePolicy(text) {
  const raw = JSON.parse(text);
  const problems = [];
  if (!Array.isArray(raw.allowed) || raw.allowed.length === 0 || raw.allowed.some((id) => typeof id !== "string")) {
    problems.push('"allowed" must be a non-empty list of SPDX identifiers');
  }
  const exceptions = Array.isArray(raw.exceptions) ? raw.exceptions : [];
  exceptions.forEach((entry, i) => {
    const at = `exceptions[${i}]`;
    if (!Ecosystems.includes(entry.ecosystem)) {
      problems.push(`${at}: "ecosystem" must be one of ${Ecosystems.join(", ")}`);
    }
    for (const field of ["name", "license", "reason"]) {
      if (typeof entry[field] !== "string" || entry[field].trim() === "") {
        problems.push(`${at}: "${field}" is required`);
      }
    }
    if (typeof entry.license === "string") {
      try {
        parseExpression(entry.license);
      } catch (err) {
        problems.push(`${at}: "license" is not an SPDX expression (${err.message})`);
      }
    }
  });
  if (problems.length > 0) {
    throw new Error(`${PolicyFile} is invalid:\n  ${problems.join("\n  ")}`);
  }
  return { allowed: new Set(raw.allowed), exceptions };
}

export function loadPolicy(root) {
  return parsePolicy(fs.readFileSync(path.join(root, PolicyFile), "utf8"));
}

export function findException(policy, component) {
  return (
    policy.exceptions.find(
      (entry) =>
        entry.ecosystem === component.ecosystem &&
        entry.name === component.name &&
        (entry.version == null || entry.version === component.version)
    ) ?? null
  );
}

// The licence a component ships under and whether the policy accepts it:
//   { expression, source: "declared" | "detected" | "exception", allowed, relied, exception, problem }
// A reviewed exception decides on its own. Otherwise the licence the package declares counts, then the one its licence
// files name; a component that has neither, or whose licence is not on the allow-list, is a problem.
export function judge(component, policy) {
  const exception = findException(policy, component);
  if (exception != null) {
    return {
      expression: formatExpression(parseExpression(exception.license)),
      source: "exception",
      allowed: true,
      relied: [],
      exception,
      problem: null,
    };
  }
  let tree = null;
  let source = null;
  let declaredError = null;
  if (component.declared != null) {
    try {
      tree = parseExpression(component.declared);
      source = "declared";
    } catch (err) {
      declaredError = err.message;
    }
  }
  if (tree == null) {
    const detected = [...new Set(component.files.flatMap((file) => detectLicenses(file.text)))].sort();
    if (detected.length > 0) {
      tree = parseExpression(detected.join(" AND "));
      source = "detected";
    }
  }
  if (tree == null) {
    const why =
      component.declared != null
        ? `declares "${component.declared}", which is not an SPDX expression (${declaredError}), and no licence file names a known licence`
        : "declares no licence and no licence file names a known licence";
    return { expression: null, source: null, allowed: false, relied: [], exception: null, problem: why };
  }
  const verdict = evaluate(tree, policy.allowed);
  const expression = formatExpression(tree);
  return {
    expression,
    source,
    allowed: verdict.allowed,
    relied: verdict.relied,
    exception: null,
    problem: verdict.allowed ? null : `${expression} (${source}) is not on the allow-list`,
  };
}

// The exceptions no shipped component uses, from the ecosystems that were collected.
export function staleExceptions(policy, components, ecosystems) {
  return policy.exceptions.filter(
    (entry) =>
      ecosystems.includes(entry.ecosystem) && !components.some((c) => findException({ exceptions: [entry] }, c) != null)
  );
}
