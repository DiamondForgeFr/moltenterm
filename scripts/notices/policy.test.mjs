// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Bsd3Text, GplText, MitText, PolicyJson } from "./fixtures.mjs";
import { declaredLicense } from "./npm.mjs";
import { findException, judge, loadPolicy, parsePolicy, staleExceptions } from "./policy.mjs";

const Root = path.join(import.meta.dirname, "..", "..");
const policy = parsePolicy(JSON.stringify(PolicyJson));

function component(overrides = {}) {
  return { ecosystem: "npm", name: "pkg", version: "1.0.0", declared: null, files: [], ...overrides };
}

describe("parsePolicy", () => {
  it("reads the allow-list and the exceptions", () => {
    const parsed = parsePolicy(
      JSON.stringify({
        allowed: ["MIT"],
        exceptions: [{ ecosystem: "go", name: "x", license: "MPL-2.0 OR MIT", reason: "reviewed" }],
      })
    );
    expect([...parsed.allowed]).toEqual(["MIT"]);
    expect(parsed.exceptions).toHaveLength(1);
  });

  it.each([
    ["no allow-list", { exceptions: [] }],
    ["an empty allow-list", { allowed: [] }],
    [
      "an exception with no reason",
      { allowed: ["MIT"], exceptions: [{ ecosystem: "npm", name: "x", license: "MIT" }] },
    ],
    [
      "an exception of an unknown ecosystem",
      { allowed: ["MIT"], exceptions: [{ ecosystem: "pip", name: "x", license: "MIT", reason: "r" }] },
    ],
    [
      "an exception whose licence is not an expression",
      { allowed: ["MIT"], exceptions: [{ ecosystem: "npm", name: "x", license: "SEE LICENSE IN X", reason: "r" }] },
    ],
  ])("refuses %s", (_name, raw) => {
    expect(() => parsePolicy(JSON.stringify(raw))).toThrow(/license-policy\.json is invalid/);
  });

  it("is the policy of the repository, and allows what the ticket names", () => {
    const real = loadPolicy(Root);
    for (const id of [
      "MIT",
      "BSD-2-Clause",
      "BSD-3-Clause",
      "Apache-2.0",
      "ISC",
      "MPL-2.0",
      "OFL-1.1",
      "0BSD",
      "Unlicense",
      "CC0-1.0",
      "Python-2.0",
      "BlueOak-1.0.0",
      "Zlib",
    ]) {
      expect(real.allowed.has(id), id).toBe(true);
    }
    expect(real.allowed.has("GPL-3.0-only")).toBe(false);
    expect(real.allowed.has("AGPL-3.0-only")).toBe(false);
  });

  it("keeps @diamondforge/character as DiamondForge's own private package, and NOTICE says so", () => {
    const real = loadPolicy(Root);
    const own = findException(real, { ecosystem: "npm", name: "@diamondforge/character", version: "0.3.1" });
    expect(own?.reason).toMatch(/own private package/);
    const notice = fs.readFileSync(path.join(Root, "NOTICE"), "utf8");
    expect(notice).toMatch(/@diamondforge\/character[^]*DiamondForge's own private package/);
  });

  it("gives every exception of the repository a reason", () => {
    for (const entry of loadPolicy(Root).exceptions) {
      expect(entry.reason.length, entry.name).toBeGreaterThan(20);
    }
  });
});

describe("declaredLicense", () => {
  it.each([
    [{ license: "MIT" }, "MIT"],
    [{ license: " (MIT OR Apache-2.0) " }, "(MIT OR Apache-2.0)"],
    [{ license: { type: "MIT", url: "https://x" } }, "MIT"],
    [{ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] }, "(MIT OR Apache-2.0)"],
    [{ licenses: [{ type: "ISC" }] }, "ISC"],
    [{ license: "" }, null],
    [{}, null],
  ])("%j -> %j", (meta, declared) => {
    expect(declaredLicense(meta)).toBe(declared);
  });
});

describe("judge", () => {
  it("allows a declared licence on the allow-list", () => {
    const verdict = judge(component({ declared: "MIT" }), policy);
    expect(verdict).toMatchObject({ allowed: true, expression: "MIT", source: "declared", problem: null });
  });

  it("allows an OR when one alternative is allowed, and says which", () => {
    const verdict = judge(component({ declared: "(GPL-3.0-only OR MIT)" }), policy);
    expect(verdict).toMatchObject({ allowed: true, relied: ["MIT"] });
  });

  it("refuses a declared licence that is not on the allow-list", () => {
    const verdict = judge(component({ declared: "GPL-3.0-only" }), policy);
    expect(verdict.allowed).toBe(false);
    expect(verdict.problem).toBe("GPL-3.0-only (declared) is not on the allow-list");
  });

  it("refuses an AND when one licence is not allowed", () => {
    expect(judge(component({ declared: "MIT AND GPL-3.0-only" }), policy).allowed).toBe(false);
  });

  it("reads the licence from the files when the package declares none", () => {
    const verdict = judge(component({ files: [{ file: "LICENSE", text: Bsd3Text }] }), policy);
    expect(verdict).toMatchObject({ allowed: true, expression: "BSD-3-Clause", source: "detected" });
  });

  it("reads the licence from the files when the declaration points to one", () => {
    const verdict = judge(
      component({ declared: "SEE LICENSE IN LICENSE", files: [{ file: "LICENSE", text: MitText }] }),
      policy
    );
    expect(verdict).toMatchObject({ allowed: true, expression: "MIT", source: "detected" });
  });

  it("trusts the declaration over a file that says something else", () => {
    const verdict = judge(component({ declared: "ISC", files: [{ file: "LICENSE", text: MitText }] }), policy);
    expect(verdict).toMatchObject({ expression: "ISC", source: "declared" });
  });

  it("refuses a package that declares nothing and whose files name no known licence", () => {
    const verdict = judge(component({ files: [{ file: "LICENSE", text: GplText }] }), policy);
    expect(verdict.allowed).toBe(false);
    expect(verdict.problem).toBe("declares no licence and no licence file names a known licence");
  });

  it("refuses a package with neither a declaration nor a file", () => {
    expect(judge(component(), policy).allowed).toBe(false);
  });

  it("refuses a declaration that is not an expression and that no file explains", () => {
    const verdict = judge(component({ declared: "Custom terms (see the site)" }), policy);
    expect(verdict.allowed).toBe(false);
    expect(verdict.problem).toMatch(/declares "Custom terms \(see the site\)", which is not an SPDX expression/);
  });

  it("refuses an unlicensed package: UNLICENSED is no licence on the allow-list", () => {
    const verdict = judge(component({ declared: "UNLICENSED" }), policy);
    expect(verdict.allowed).toBe(false);
    expect(verdict.problem).toBe("UNLICENSED (declared) is not on the allow-list");
  });

  it("refuses a licence it only detected when that licence is not on the allow-list", () => {
    const isc = parsePolicy(JSON.stringify({ allowed: ["ISC"] }));
    const verdict = judge(component({ files: [{ file: "LICENSE", text: MitText }] }), isc);
    expect(verdict.allowed).toBe(false);
    expect(verdict.problem).toBe("MIT (detected) is not on the allow-list");
  });

  it("lets a reviewed exception decide, whatever the package declares", () => {
    const withException = parsePolicy(
      JSON.stringify({
        allowed: ["MIT"],
        exceptions: [{ ecosystem: "npm", name: "pkg", version: "1.0.0", license: "CC-BY-4.0", reason: "reviewed" }],
      })
    );
    const verdict = judge(component({ declared: "GPL-3.0-only" }), withException);
    expect(verdict).toMatchObject({ allowed: true, expression: "CC-BY-4.0", source: "exception" });
    // Another version, or another ecosystem, is not what was reviewed.
    expect(judge(component({ version: "2.0.0", declared: "GPL-3.0-only" }), withException).allowed).toBe(false);
    expect(judge(component({ ecosystem: "go", declared: "GPL-3.0-only" }), withException).allowed).toBe(false);
  });
});

describe("staleExceptions", () => {
  it("names the exceptions no shipped component matches, for the ecosystems collected", () => {
    const withExceptions = parsePolicy(
      JSON.stringify({
        allowed: ["MIT"],
        exceptions: [
          { ecosystem: "npm", name: "gone", license: "MIT", reason: "reviewed" },
          { ecosystem: "npm", name: "pkg", license: "MIT", reason: "reviewed" },
          { ecosystem: "go", name: "elsewhere", license: "MIT", reason: "reviewed" },
        ],
      })
    );
    const stale = staleExceptions(withExceptions, [component()], ["npm"]);
    expect(stale.map((entry) => entry.name)).toEqual(["gone"]);
  });
});
