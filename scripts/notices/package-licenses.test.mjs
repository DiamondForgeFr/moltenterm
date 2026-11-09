// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempRoot, write } from "./fixtures.mjs";

const require = createRequire(import.meta.url);
const Root = path.join(import.meta.dirname, "..", "..");
const {
  expectedLicenseFiles,
  missingLicenseFiles,
  verifyPackagedLicenses,
} = require("../../build/moltenterm/package-licenses.cjs");
// Loaded while the file is collected: electron-builder takes seconds to load, more than a test's timeout.
const builderConfig = require("../../electron-builder.config.cjs");
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function context(platform, productFilename = "MoltenTerm") {
  const appOutDir = tempRoot("mt-package-");
  roots.push(appOutDir);
  return { electronPlatformName: platform, appOutDir, packager: { appInfo: { productFilename } } };
}

// What electron-builder 26 leaves for a macOS app, and for a Linux directory, plus the notices extraResources puts.
function fillMac(ctx, { productFilename = "MoltenTerm" } = {}) {
  const resources = `${productFilename}.app/Contents/Resources`;
  write(ctx.appOutDir, `${resources}/licenses/THIRD-PARTY-NOTICES.txt`, "notices");
  write(ctx.appOutDir, `${resources}/LICENSE.electron.txt`, "electron");
  write(ctx.appOutDir, `${resources}/LICENSES.chromium.html`, "<html></html>");
}

function fillLinux(ctx) {
  write(ctx.appOutDir, "resources/licenses/THIRD-PARTY-NOTICES.txt", "notices");
  write(ctx.appOutDir, "LICENSE.electron.txt", "electron");
  write(ctx.appOutDir, "LICENSES.chromium.html", "<html></html>");
}

describe("verifyPackagedLicenses", () => {
  it("accepts a macOS app that holds the three files in its Resources folder", () => {
    const ctx = context("darwin");
    fillMac(ctx);
    expect(() => verifyPackagedLicenses(ctx)).not.toThrow();
  });

  it("accepts a Linux build that holds the notices in resources and Electron's files next to the executable", () => {
    const ctx = context("linux");
    fillLinux(ctx);
    expect(() => verifyPackagedLicenses(ctx)).not.toThrow();
  });

  it("follows the product name, the gold being MoltenTerm Gold", () => {
    const ctx = context("darwin", "MoltenTerm Gold");
    fillMac(ctx, { productFilename: "MoltenTerm Gold" });
    expect(() => verifyPackagedLicenses(ctx)).not.toThrow();
    expect(() => verifyPackagedLicenses({ ...ctx, packager: { appInfo: { productFilename: "MoltenTerm" } } })).toThrow(
      /missing licence files/
    );
  });

  it("refuses a package without the notices, and says how to make them", () => {
    const ctx = context("linux");
    fillLinux(ctx);
    fs.rmSync(path.join(ctx.appOutDir, "resources", "licenses"), { recursive: true });
    expect(() => verifyPackagedLicenses(ctx)).toThrow(
      /THIRD-PARTY-NOTICES\.txt: the third-party notices \(task build:prod/
    );
  });

  it("refuses a package that lost Electron's or Chromium's licence", () => {
    const mac = context("darwin");
    fillMac(mac);
    fs.rmSync(path.join(mac.appOutDir, "MoltenTerm.app/Contents/Resources/LICENSES.chromium.html"));
    expect(() => verifyPackagedLicenses(mac)).toThrow(/LICENSES\.chromium\.html: Chromium's licences/);
    const linux = context("linux");
    fillLinux(linux);
    fs.rmSync(path.join(linux.appOutDir, "LICENSE.electron.txt"));
    expect(() => verifyPackagedLicenses(linux)).toThrow(/LICENSE\.electron\.txt: Electron's licence/);
  });

  it("refuses an empty file", () => {
    const ctx = context("linux");
    fillLinux(ctx);
    write(ctx.appOutDir, "resources/licenses/THIRD-PARTY-NOTICES.txt", "");
    expect(missingLicenseFiles({ platform: "linux", appOutDir: ctx.appOutDir, productFilename: "x" })).toHaveLength(1);
  });

  it("expects the three files on every platform", () => {
    for (const platform of ["darwin", "linux", "win32"]) {
      const files = expectedLicenseFiles({ platform, appOutDir: "/out", productFilename: "MoltenTerm" });
      expect(files.map(({ file }) => path.basename(file)).sort()).toEqual([
        "LICENSE.electron.txt",
        "LICENSES.chromium.html",
        "THIRD-PARTY-NOTICES.txt",
      ]);
    }
  });
});

describe("electron-builder.config.cjs", () => {
  it("ships the generated notices as a resource, next to the project's own licence files", () => {
    const entry = builderConfig.extraResources.find((item) => item.from === "dist/licenses");
    expect(entry).toEqual({ from: "dist/licenses", to: "licenses", filter: ["THIRD-PARTY-NOTICES.txt"] });
    expect(builderConfig.extraResources.some((item) => item.to === "licenses" && item.filter?.includes("NOTICE"))).toBe(
      true
    );
  });

  it("keeps the build's licence work files out of the asar", () => {
    const dist = builderConfig.files.find((item) => item.from === "./dist");
    expect(dist.filter).toContain("!licenses/**/*");
  });

  it("checks the licence files after packing, before anything is signed", () => {
    const ctx = context("linux");
    expect(() => builderConfig.afterPack(ctx)).toThrow(/missing licence files/);
    fillLinux(ctx);
    expect(() => builderConfig.afterPack(ctx)).not.toThrow();
  });

  it("is run after the build of every packaging path", () => {
    const read = (rel) => fs.readFileSync(path.join(Root, rel), "utf8");
    expect(read("Taskfile.yml")).toMatch(
      /npm run build:prod && node scripts\/moltenterm-notices\.mjs && npm exec electron-builder/
    );
    expect(read(".github/workflows/release.yml")).toMatch(
      /npm run build:prod\n\s+node scripts\/moltenterm-notices\.mjs/
    );
    expect(read(".github/workflows/macos-signing-probe.yml")).toMatch(
      /npm run build:prod\n\s+node scripts\/moltenterm-notices\.mjs/
    );
    expect(read("scripts/moltenterm-build-gold.sh")).toMatch(
      /npm run build:prod\n[^\n]*\nnode scripts\/moltenterm-notices\.mjs/
    );
    expect(read("RELEASE.md")).toContain("node scripts/moltenterm-notices.mjs");
  });
});

describe("CI", () => {
  const ci = fs.readFileSync(path.join(Root, ".github/workflows/ci.yml"), "utf8");

  it("checks the npm licences in the job that builds the bundles, after the build", () => {
    const frontend = ci.slice(ci.indexOf("\n    frontend:\n"), ci.indexOf("\n    backend:\n"));
    expect(frontend).toMatch(
      /run: npm run build:prod\n[^]*run: node scripts\/moltenterm-notices\.mjs --check --sources npm,assets/
    );
  });

  it("checks the Go licences in the job that has Go and its modules", () => {
    const backend = ci.slice(ci.indexOf("\n    backend:\n"), ci.indexOf("\n    perf:\n"));
    expect(backend).toContain("run: node scripts/moltenterm-notices.mjs --check --sources go");
  });

  it("runs the check in two steps, one per job, and in no other", () => {
    expect(ci.split("\n").filter((line) => line.includes("moltenterm-notices.mjs --check"))).toHaveLength(2);
  });
});
