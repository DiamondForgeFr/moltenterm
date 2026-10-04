// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    checkLedger,
    ledgerEntries,
    parseCurrentBase,
    parseNameStatus,
    tokenMatcher,
} from "./moltenterm-check-ledger.mjs";

const Upstream = `# Upstream

## Current base

| Wave release | Commit | Merged by |
| --- | --- | --- |
| v0.14.4 | \`aaaaaaa\` | #1 |
| v0.14.5 | \`97e5600\` | #3 (merge commit \`b20f802\`) |

## Files Moltenterm owns

| Path | Policy when merging |
| --- | --- |
| \`README.md\`, \`NOTICE\` | Keep ours |
| \`.github/\` | Keep ours |

## Patch ledger

| Wave file | Change | Why | Ticket |
| --- | --- | --- | --- |
| \`emain/emain.ts\` | Uses \`MoltentermProductName\` | Identity | #4 |
| \`public/fontawesome/\` (11 files), \`.github/workflows/*\` | Deleted | Licence, automation | #6 |
| \`pkg/wconfig/defaultconfig/settings.json\` | Defaults (JSON, no marker) | Product | #5 |

## Known upstream items

- \`not/a/ledger/entry.ts\`
`;

const Base = { release: "v0.14.5", commit: "97e5600" };
const Marked = "// MOLTENTERM-PATCH (#4)\nexport {};\n";
const lineOf = (text) => Upstream.split("\n").findIndex((l) => l.includes(text)) + 1;

function run(changes, files = {}) {
    const readFile = (p) => files[p] ?? Marked;
    return checkLedger({ markdown: Upstream, base: Base, changes, readFile });
}

const CleanChanges = [
    { status: "M", path: "emain/emain.ts" },
    { status: "D", path: "public/fontawesome/css/sharp-solid.min.css" },
    { status: "D", path: ".github/workflows/build-helper.yml" },
    { status: "M", path: "pkg/wconfig/defaultconfig/settings.json" },
    { status: "M", path: "README.md" },
    { status: "A", path: "scripts/moltenterm-new.mjs" },
];

describe("parseCurrentBase", () => {
    it("reads the last row of the Current base table", () => {
        expect(parseCurrentBase(Upstream)).toEqual({ release: "v0.14.5", commit: "97e5600" });
    });

    it("returns null without the table", () => {
        expect(parseCurrentBase("# Upstream\n")).toBeNull();
    });
});

describe("tokenMatcher", () => {
    it("matches a full path exactly", () => {
        expect(tokenMatcher("emain/emain.ts")("emain/emain.ts")).toBe(true);
        expect(tokenMatcher("emain/emain.ts")("emain/emain.tsx")).toBe(false);
        expect(tokenMatcher("index.html")("frontend/preview/index.html")).toBe(false);
    });

    it("matches everything under a directory token", () => {
        expect(tokenMatcher("public/fontawesome/")("public/fontawesome/webfonts/fa-solid-900.woff2")).toBe(true);
        expect(tokenMatcher("public/fontawesome/")("public/fontawesome-free/css/solid.min.css")).toBe(false);
    });

    it("keeps a glob star within one path segment and escapes the rest", () => {
        const m = tokenMatcher(".github/workflows/*");
        expect(m(".github/workflows/codeql.yml")).toBe(true);
        expect(m(".github/workflows/nested/codeql.yml")).toBe(false);
        expect(m("xgithub/workflows/codeql.yml")).toBe(false);
    });
});

describe("ledgerEntries", () => {
    it("reads only the backticked tokens of the first column, with their line", () => {
        const entries = ledgerEntries(Upstream, "## Patch ledger").map((e) => [e.token, e.line]);
        expect(entries).toEqual([
            ["emain/emain.ts", lineOf("`emain/emain.ts`")],
            ["public/fontawesome/", lineOf("`public/fontawesome/`")],
            [".github/workflows/*", lineOf("`public/fontawesome/`")],
            ["pkg/wconfig/defaultconfig/settings.json", lineOf("settings.json")],
        ]);
    });
});

describe("parseNameStatus", () => {
    it("parses NUL-separated status and path pairs", () => {
        expect(parseNameStatus("M\0emain/emain.ts\0D\0docs/a b.md\0")).toEqual([
            { status: "M", path: "emain/emain.ts" },
            { status: "D", path: "docs/a b.md" },
        ]);
    });
});

describe("checkLedger", () => {
    it("passes when every changed Wave file is ledgered or owned and marked", () => {
        expect(run(CleanChanges)).toEqual({ waveFiles: 5, problems: [] });
    });

    it("names a changed Wave file that has no ledger entry", () => {
        const { problems } = run([...CleanChanges, { status: "M", path: "frontend/app/app.tsx" }]);
        expect(problems).toHaveLength(1);
        expect(problems[0].file).toBe("frontend/app/app.tsx");
        expect(problems[0].message).toContain("modified since v0.14.5");
    });

    it("names a deleted or retyped Wave file that has no ledger entry", () => {
        const { problems } = run([
            ...CleanChanges,
            { status: "D", path: "README.ko.md" },
            { status: "T", path: "pkg/util/link.go" },
        ]);
        expect(problems.map((p) => [p.file, p.message.split(" since ")[0]])).toEqual([
            ["README.ko.md", "deleted"],
            ["pkg/util/link.go", "changed type"],
        ]);
    });

    it("reports a ledger entry that matches no changed Wave file, with its line", () => {
        const { problems } = run(CleanChanges.filter((c) => c.path !== "emain/emain.ts"));
        expect(problems).toEqual([
            {
                file: "UPSTREAM.md",
                line: lineOf("`emain/emain.ts`"),
                message: expect.stringContaining("`emain/emain.ts` matches no Wave file"),
            },
        ]);
    });

    it("reports an entry that only matches an added file", () => {
        const { problems } = run([{ status: "A", path: "emain/emain.ts" }, ...CleanChanges.slice(1)]);
        expect(problems.map((p) => p.line)).toEqual([lineOf("`emain/emain.ts`")]);
    });

    it("requires a marker in modified Wave files whose format accepts comments", () => {
        const { problems } = run(CleanChanges, { "emain/emain.ts": "export {};\n" });
        expect(problems).toEqual([
            { file: "emain/emain.ts", message: "modified Wave file without a MOLTENTERM-PATCH marker" },
        ]);
    });

    it("exempts JSON, owned files and deletions from the marker rule", () => {
        const files = { "pkg/wconfig/defaultconfig/settings.json": "{}", "README.md": "# Moltenterm\n" };
        expect(run(CleanChanges, files).problems).toEqual([]);
    });

    it("exempts files written by Wave's generators from the marker rule, not from the ledger", () => {
        const generated = "// Copyright 2026, Command Line Inc.\n\n// generated by cmd/generate/main-generatets.go\n";
        const goGenerated = "// Copyright 2026, Command Line Inc.\n\n// Generated Code. DO NOT EDIT.\n";
        expect(run(CleanChanges, { "emain/emain.ts": generated }).problems).toEqual([]);
        expect(run(CleanChanges, { "emain/emain.ts": goGenerated }).problems).toEqual([]);
        const { problems } = run([...CleanChanges, { status: "M", path: "frontend/types/gotypes.d.ts" }], {
            "frontend/types/gotypes.d.ts": generated,
        });
        expect(problems.map((p) => p.file)).toEqual(["frontend/types/gotypes.d.ts"]);
    });

    it("never checks entries of Files Moltenterm owns for staleness", () => {
        const { problems } = run(CleanChanges.filter((c) => c.path !== "README.md"));
        expect(problems).toEqual([]);
    });

    it("reports a missing table", () => {
        const markdown = Upstream.replace("## Patch ledger", "## Patches");
        const { problems } = checkLedger({ markdown, base: Base, changes: CleanChanges, readFile: () => Marked });
        expect(problems).toEqual([{ file: "UPSTREAM.md", message: 'missing "## Patch ledger" table' }]);
    });
});
