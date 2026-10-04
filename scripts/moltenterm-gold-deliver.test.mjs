// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deliverGold,
  GoldAppName,
  goldDir,
  linkLegacyGoldDir,
  makeManifest,
  migrateLegacyGoldDir,
  parseNotes,
} from "./moltenterm-gold-deliver.mjs";

function fakeApp(root, label) {
  const app = path.join(root, label, GoldAppName);
  fs.mkdirSync(path.join(app, "Contents"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents", "label.txt"), label);
  return app;
}

const read = (file) => fs.readFileSync(file, "utf8");

describe("gold delivery", () => {
  it("places the gold folder under Application Support unless overridden", () => {
    expect(goldDir({}, "/Users/a")).toBe("/Users/a/Library/Application Support/Moltenterm Local Builds/gold.noindex");
    expect(goldDir({ MOLTENTERM_GOLD_DIR: "/tmp/g" }, "/Users/a")).toBe("/tmp/g");
  });

  it("reads commit notes", () => {
    expect(parseNotes("abc\tfeat(#1): x\ndef\tfix: a\tb\n")).toEqual([
      { sha: "abc", subject: "feat(#1): x" },
      { sha: "def", subject: "fix: a\tb" },
    ]);
  });

  it("delivers a first gold, then keeps the previous one beside the next", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mt-gold-"));
    const dir = path.join(root, "Local Builds", "gold");
    const first = makeManifest({ version: "0.14.5", buildId: 100, builtAt: "t1", commit: "c1", notes: [] });
    deliverGold({ app: fakeApp(root, "one"), dir, manifest: first });
    expect(read(path.join(dir, GoldAppName, "Contents", "label.txt"))).toBe("one");
    expect(JSON.parse(read(path.join(dir, "manifest.json")))).toMatchObject({
      schema: 1,
      buildId: 100,
      app: GoldAppName,
    });
    expect(fs.existsSync(path.join(dir, "previous"))).toBe(false);

    const second = makeManifest({ version: "0.14.5", buildId: 200, builtAt: "t2", commit: "c2", notes: [] });
    deliverGold({ app: fakeApp(root, "two"), dir, manifest: second });
    expect(read(path.join(dir, GoldAppName, "Contents", "label.txt"))).toBe("two");
    expect(JSON.parse(read(path.join(dir, "manifest.json"))).buildId).toBe(200);
    expect(read(path.join(dir, "previous", GoldAppName, "Contents", "label.txt"))).toBe("one");
    expect(JSON.parse(read(path.join(dir, "previous", "manifest.json"))).buildId).toBe(100);
    expect(fs.readdirSync(path.dirname(dir)).sort()).toEqual(["gold"]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("moves an old delivery out of Spotlight's reach and keeps the old name as a link (#191)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gold-migrate-"));
    const legacy = path.join(root, "gold");
    fs.mkdirSync(path.join(legacy, GoldAppName), { recursive: true });
    fs.writeFileSync(path.join(legacy, "manifest.json"), "{}");
    const dir = path.join(root, "gold.noindex");
    migrateLegacyGoldDir(dir);
    expect(fs.existsSync(path.join(dir, "manifest.json"))).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
    linkLegacyGoldDir(dir);
    expect(fs.readlinkSync(legacy)).toBe("gold.noindex");
    expect(fs.existsSync(path.join(legacy, "manifest.json"))).toBe(true);
    migrateLegacyGoldDir(dir);
    linkLegacyGoldDir(dir);
    expect(fs.lstatSync(legacy).isSymbolicLink()).toBe(true);
    const other = path.join(root, "custom");
    migrateLegacyGoldDir(other);
    linkLegacyGoldDir(other);
    expect(fs.readlinkSync(legacy)).toBe("gold.noindex");
  });
});
