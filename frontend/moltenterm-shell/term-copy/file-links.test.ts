// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { findFileRefs, parseFileRef } from "./file-links";

function paths(text: string) {
    return findFileRefs(text).map((r) => [r.path, r.line, r.col]);
}

describe("findFileRefs", () => {
    it("finds path, path:line and path:line:col", () => {
        expect(paths("see src/app.ts and lib/x.go:12 or frontend/a.tsx:3:14")).toEqual([
            ["src/app.ts", undefined, undefined],
            ["lib/x.go", 12, undefined],
            ["frontend/a.tsx", 3, 14],
        ]);
    });

    it("keeps the exact range of the reference, suffix included", () => {
        const text = "  ⎿  Error in pkg/molten/agentstate.go:42:7: undefined";
        const [ref] = findFileRefs(text);
        expect(text.slice(ref.start, ref.end)).toBe("pkg/molten/agentstate.go:42:7");
    });

    it("finds absolute, home and dot-relative paths", () => {
        expect(paths("/Users/me/x.ts:1 ~/notes/todo.md ./run.sh ../up/README.md")).toEqual([
            ["/Users/me/x.ts", 1, undefined],
            ["~/notes/todo.md", undefined, undefined],
            ["./run.sh", undefined, undefined],
            ["../up/README.md", undefined, undefined],
        ]);
    });

    it("finds bare file names with an extension", () => {
        expect(paths("Edit(Taskfile.yml) and README.md, .env")).toEqual([
            ["Taskfile.yml", undefined, undefined],
            ["README.md", undefined, undefined],
            [".env", undefined, undefined],
        ]);
    });

    it("drops trailing punctuation and wrapping quotes or brackets", () => {
        expect(paths('Updated "src/a.ts". (see docs/b.md), `c/d.go`')).toEqual([
            ["src/a.ts", undefined, undefined],
            ["docs/b.md", undefined, undefined],
            ["c/d.go", undefined, undefined],
        ]);
    });

    it("leaves URLs, numbers, versions and abbreviations alone", () => {
        expect(paths("https://example.com/a/b.ts 1.5 2.1.288 e.g. 12:30 i.e.")).toEqual([]);
    });

    it("does not start a reference inside another word", () => {
        expect(paths("foo@bar/baz.ts x:src/a.ts")).toEqual([["foo@bar/baz.ts", undefined, undefined]]);
    });

    it("ignores the line of a folder", () => {
        expect(paths("cd src/app/:12")).toEqual([["src/app/", undefined, undefined]]);
    });
});

describe("parseFileRef", () => {
    it("accepts a selection that is exactly one reference", () => {
        expect(parseFileRef("  src/a.ts:10\n")).toMatchObject({ path: "src/a.ts", line: 10 });
        expect(parseFileRef("open src/a.ts")).toBeNull();
        expect(parseFileRef("hello")).toBeNull();
    });
});
