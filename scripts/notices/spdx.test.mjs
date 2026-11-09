// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { evaluate, formatExpression, idsOf, parseExpression } from "./spdx.mjs";

const Allowed = new Set(["MIT", "Apache-2.0", "BSD-3-Clause"]);
const verdict = (text) => evaluate(parseExpression(text), Allowed);

describe("parseExpression", () => {
  it("reads a single id and its exception", () => {
    expect(parseExpression("MIT")).toEqual({ id: "MIT" });
    expect(parseExpression("Apache-2.0 WITH LLVM-exception")).toEqual({
      id: "Apache-2.0",
      exception: "LLVM-exception",
    });
  });

  it("gives AND precedence over OR, and honours parentheses", () => {
    expect(idsOf(parseExpression("MIT OR ISC AND Zlib"))).toEqual(["MIT", "ISC", "Zlib"]);
    expect(parseExpression("MIT OR ISC AND Zlib")).toMatchObject({ op: "OR", right: { op: "AND" } });
    expect(parseExpression("(MIT OR ISC) AND Zlib")).toMatchObject({ op: "AND", left: { op: "OR" } });
  });

  it("reads operators in any case", () => {
    expect(parseExpression("MIT or ISC")).toMatchObject({ op: "OR" });
  });

  it.each(["", "   ", "(MIT", "MIT)", "MIT AND", "AND MIT", "SEE LICENSE IN LICENSE.md", "MIT WITH", "MIT ISC"])(
    "refuses %j",
    (text) => {
      expect(() => parseExpression(text)).toThrow();
    }
  );

  it("refuses what is not a string", () => {
    expect(() => parseExpression(null)).toThrow();
    expect(() => parseExpression({ type: "MIT" })).toThrow();
  });
});

describe("evaluate", () => {
  it("allows an allowed id and refuses the others", () => {
    expect(verdict("MIT")).toEqual({ allowed: true, relied: ["MIT"] });
    expect(verdict("GPL-3.0-only")).toEqual({ allowed: false, relied: [] });
  });

  it("needs one allowed alternative for OR and names the one it relies on", () => {
    expect(verdict("GPL-3.0-only OR MIT")).toEqual({ allowed: true, relied: ["MIT"] });
    expect(verdict("GPL-3.0-only OR LGPL-2.1-only").allowed).toBe(false);
  });

  it("needs every licence for AND", () => {
    expect(verdict("MIT AND Apache-2.0")).toEqual({ allowed: true, relied: ["MIT", "Apache-2.0"] });
    expect(verdict("MIT AND GPL-3.0-only").allowed).toBe(false);
  });

  it("judges an exception by its base licence", () => {
    expect(verdict("Apache-2.0 WITH LLVM-exception").allowed).toBe(true);
    expect(verdict("GPL-2.0-only WITH Classpath-exception-2.0").allowed).toBe(false);
  });

  it("reads an or-later id as the id it extends", () => {
    expect(verdict("MIT+").allowed).toBe(true);
    expect(verdict("GPL-2.0+").allowed).toBe(false);
  });

  it("is case sensitive about ids, as SPDX is for the allow-list", () => {
    expect(verdict("mit").allowed).toBe(false);
  });
});

describe("formatExpression", () => {
  it("writes a normalised expression with parentheses only where the operators change", () => {
    expect(formatExpression(parseExpression("(MIT  or   ISC) and Zlib"))).toBe("(MIT OR ISC) AND Zlib");
    expect(formatExpression(parseExpression("(CC-BY-4.0 AND OFL-1.1) AND MIT"))).toBe("CC-BY-4.0 AND OFL-1.1 AND MIT");
    expect(formatExpression(parseExpression("Apache-2.0 with LLVM-exception"))).toBe("Apache-2.0 WITH LLVM-exception");
  });
});
