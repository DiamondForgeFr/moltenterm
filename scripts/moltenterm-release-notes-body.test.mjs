// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { isDraft, parseReleaseNotes } from "./moltenterm-release-notes-body.mjs";

describe("release notes body", () => {
  it("drops the front matter and reads its keys", () => {
    const notes = parseReleaseNotes("---\ndate: 2026-10-20\ndraft: true\n---\n\n## New\n\n- A thing\n");
    expect(notes.front).toEqual({ date: "2026-10-20", draft: "true" });
    expect(notes.body).toBe("## New\n\n- A thing\n");
    expect(isDraft(notes.front)).toBe(true);
  });

  it("keeps a file without front matter, or with an unclosed one, as it is", () => {
    expect(parseReleaseNotes("## New\n").body).toBe("## New\n");
    expect(parseReleaseNotes("---\nnever closed\n").body).toBe("---\nnever closed\n");
    expect(isDraft(parseReleaseNotes("---\ndate: 2026-10-20\n---\n- x\n").front)).toBe(false);
  });
});
