#!/usr/bin/env node
// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Reads the Electron fuses of a packaged build and compares them with the set build/moltenterm/electron-fuses.cjs asks
// for (#1975, FR-BRW-014). A fuse is a byte in the Electron binary (the Electron Framework on macOS, the executable
// elsewhere) behind a sentinel string, so the check needs neither Electron nor @electron/fuses and reads what the
// packaged app really has, not what the config said. The release workflow runs it on every packaged app.
//
// A macOS app also has to carry the hash of its app.asar (`ElectronAsarIntegrity` in Info.plist) when the integrity
// fuse is on: electron-builder writes it, and an app with the fuse and without the hash cannot start.
//
// Usage: node scripts/moltenterm-check-fuses.mjs <MoltenTerm.app | executable> [--print]   (exit code 1 on drift)

/* global console, process, Buffer */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { ElectronFuses, FuseWireOrder } = require("../build/moltenterm/electron-fuses.cjs");

export { ElectronFuses, FuseWireOrder };
export const Sentinel = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
export const FuseEnabled = 0x31;
export const FuseDisabled = 0x30;
export const FuseRemoved = 0x72;
const SentinelBytes = Buffer.from(Sentinel);

export function stateName(byte) {
  if (byte === FuseEnabled) {
    return "on";
  }
  if (byte === FuseDisabled) {
    return "off";
  }
  if (byte === FuseRemoved) {
    return "removed";
  }
  return `0x${byte.toString(16)}`;
}

// The file that holds the fuse wire: the framework inside a macOS app, any other path as it is.
export function fuseFile(target) {
  if (target.endsWith(".app")) {
    return path.join(target, "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework");
  }
  return target;
}

// Every fuse wire in the binary: a universal macOS binary has one per slice, and each one must be right.
export function readFuseWires(binary) {
  const wires = [];
  let at = binary.indexOf(SentinelBytes);
  while (at !== -1) {
    const start = at + SentinelBytes.length;
    const version = binary[start];
    const length = binary[start + 1];
    if (version !== undefined && length !== undefined && start + 2 + length <= binary.length) {
      wires.push({ offset: at, version, states: [...binary.subarray(start + 2, start + 2 + length)] });
    }
    at = binary.indexOf(SentinelBytes, start);
  }
  return wires;
}

// The fuses by name, for a wire.
export function namedStates(wire) {
  return Object.fromEntries(wire.states.map((state, i) => [FuseWireOrder[i] ?? `fuse${i}`, state]));
}

// What differs from the expected set, as lines for a person. A fuse the set does not name is not checked.
export function fuseDrift(wires, expected = ElectronFuses) {
  if (!wires.length) {
    return ["no Electron fuse wire found: this is not an Electron binary (or the sentinel was changed)"];
  }
  const problems = [];
  for (const wire of wires) {
    const states = namedStates(wire);
    if (wire.version !== 1) {
      problems.push(`fuse wire at ${wire.offset} has version ${wire.version}, this check reads version 1`);
      continue;
    }
    for (const [name, on] of Object.entries(expected)) {
      const state = states[name];
      if (state === undefined) {
        problems.push(`${name} is not in the fuse wire at ${wire.offset} (length ${wire.states.length})`);
      } else if (state !== (on ? FuseEnabled : FuseDisabled)) {
        problems.push(`${name} is ${stateName(state)}, expected ${on ? "on" : "off"} (wire at ${wire.offset})`);
      }
    }
  }
  return problems;
}

// ElectronAsarIntegrity of a macOS app, or null when the key is absent. `plutil` is macOS only: undefined elsewhere.
export function asarIntegrityOf(app) {
  const plist = path.join(app, "Contents", "Info.plist");
  const r = spawnSync("plutil", ["-extract", "ElectronAsarIntegrity", "json", "-o", "-", plist], { encoding: "utf8" });
  if (r.error) {
    return undefined;
  }
  try {
    return r.status === 0 ? JSON.parse(r.stdout) : null;
  } catch {
    return null;
  }
}

export function integrityProblems(integrity, expected = ElectronFuses) {
  if (!expected.enableEmbeddedAsarIntegrityValidation || integrity === undefined) {
    return [];
  }
  const entry = integrity?.["Resources/app.asar"];
  if (entry?.algorithm !== "SHA256" || !/^[0-9a-f]{64}$/.test(entry?.hash ?? "")) {
    return ["Info.plist has no ElectronAsarIntegrity hash for Resources/app.asar, but the integrity fuse is on"];
  }
  return [];
}

export function checkPackagedApp(target) {
  const file = fuseFile(target);
  if (!fs.existsSync(file)) {
    return { problems: [`${file} does not exist`], wires: [] };
  }
  const wires = readFuseWires(fs.readFileSync(file));
  const problems = fuseDrift(wires);
  if (target.endsWith(".app")) {
    problems.push(...integrityProblems(asarIntegrityOf(target)));
  }
  return { problems, wires };
}

function main(argv) {
  const target = argv.find((a) => !a.startsWith("--"));
  if (!target) {
    console.error("usage: node scripts/moltenterm-check-fuses.mjs <MoltenTerm.app | executable> [--print]");
    return 2;
  }
  const { problems, wires } = checkPackagedApp(target);
  if (argv.includes("--print") || problems.length) {
    for (const wire of wires) {
      const named = Object.entries(namedStates(wire))
        .map(([name, state]) => `${name}=${stateName(state)}`)
        .join(" ");
      console.log(`fuses (wire at ${wire.offset}): ${named}`);
    }
  }
  if (problems.length) {
    for (const p of problems) {
      console.error(`fuses: ${p}`);
    }
    console.error(`fuses: ${target} does not carry the fuses of build/moltenterm/electron-fuses.cjs`);
    return 1;
  }
  console.log(`fuses: ${target} carries the fuses of build/moltenterm/electron-fuses.cjs`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
