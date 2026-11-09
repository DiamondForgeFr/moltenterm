// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { detectLicenses } from "./classify.mjs";
import { authorName, standardNotice, Templates } from "./templates.mjs";

describe("authorName", () => {
  it.each([
    ["Jane Doe", "Jane Doe"],
    ["Jane Doe <jane@example.com>", "Jane Doe"],
    ["Jane Doe <jane@example.com> (https://example.com)", "Jane Doe"],
    ["Rene Haas | KingSora", "Rene Haas | KingSora"],
    [{ name: "The xterm.js authors", url: "https://xtermjs.org/" }, "The xterm.js authors"],
    ["<jane@example.com>", null],
    ["", null],
    [{ email: "x@example.com" }, null],
    [undefined, null],
    [null, null],
  ])("%j -> %j", (author, name) => {
    expect(authorName(author)).toBe(name);
  });
});

describe("standardNotice", () => {
  it("gives each template the licence it names, which the classifier reads back", () => {
    for (const id of Object.keys(Templates)) {
      const notice = standardNotice({ name: "pkg", author: "Jane Doe" }, id);
      expect(detectLicenses(notice.text), id).toEqual([id]);
      expect(notice.text).toContain("Copyright (c) Jane Doe");
    }
  });

  it("says where each part comes from", () => {
    const { text } = standardNotice({ name: "pkg", author: "Jane Doe" }, "MIT");
    expect(text.startsWith("pkg ships no licence file. It declares the MIT licence and its package.json names Jane Doe")).toBe(
      true
    );
  });

  it("has no template for a licence longer than a page", () => {
    expect(standardNotice({ name: "pkg", author: "Jane Doe" }, "Apache-2.0")).toBeNull();
    expect(standardNotice({ name: "pkg", author: "Jane Doe" }, "MPL-2.0")).toBeNull();
  });
});
