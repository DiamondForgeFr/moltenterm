// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectLicenses } from "./classify.mjs";
import {
  ApacheText,
  Bsd2Text,
  Bsd3Text,
  Bsd4Text,
  GplText,
  IscText,
  MitText,
  Mpl2Text,
  ZeroBsdText,
} from "./fixtures.mjs";

const Root = path.join(import.meta.dirname, "..", "..");

describe("detectLicenses", () => {
  it.each([
    ["MIT", MitText, ["MIT"]],
    ["ISC", IscText, ["ISC"]],
    ["0BSD", ZeroBsdText, ["0BSD"]],
    ["BSD-2-Clause", Bsd2Text, ["BSD-2-Clause"]],
    ["BSD-3-Clause", Bsd3Text, ["BSD-3-Clause"]],
    ["BSD-4-Clause", Bsd4Text, ["BSD-4-Clause"]],
    ["Apache-2.0", ApacheText, ["Apache-2.0"]],
    ["MPL-2.0", Mpl2Text, ["MPL-2.0"]],
  ])("recognises %s", (_name, text, ids) => {
    expect(detectLicenses(text)).toEqual(ids);
  });

  it("ignores the layout, the case and the copyright line", () => {
    const reflowed = MitText.replace(/Example Authors/, "Somebody Else")
      .replace(/\n/g, "\r\n")
      .toUpperCase();
    expect(detectLicenses(reflowed)).toEqual(["MIT"]);
  });

  it("names every licence a file holds", () => {
    expect(detectLicenses(`${MitText}\n\n----\n\n${Bsd3Text}`)).toEqual(["BSD-3-Clause", "MIT"]);
  });

  it("recognises nothing it does not know, so the check refuses it", () => {
    expect(detectLicenses(GplText)).toEqual([]);
    expect(detectLicenses("All rights reserved.")).toEqual([]);
    expect(detectLicenses("")).toEqual([]);
  });

  it("reads the licence files the project already ships", () => {
    const read = (rel) => fs.readFileSync(path.join(Root, rel), "utf8");
    expect(detectLicenses(read("LICENSE"))).toEqual([]);
    expect(detectLicenses(read("LICENSE-APACHE"))).toEqual(["Apache-2.0"]);
    expect(detectLicenses(read("build/moltenterm/notices/OFL-1.1.txt"))).toEqual(["OFL-1.1"]);
    expect(detectLicenses(read("build/moltenterm/notices/bash-preexec-LICENSE.txt"))).toEqual(["MIT"]);
    expect(detectLicenses(read("build/moltenterm/notices/Hack-LICENSE.txt"))).toEqual(["MIT"]);
  });
});
