// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import postcss from "postcss";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FilesSection } from "./companion-files";
import { shownFile } from "./companion-files-model";
import type { CompanionFile } from "./companion-model";

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return { openLink: vi.fn(), getSettingsKeyAtom: () => atom(false), getApi: () => ({}) };
});
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn(() => new Promise(() => {})) } }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: vi.fn() } }));
vi.mock("@/app/store/client-model", () => ({ ClientModel: { getInstance: () => ({ clientAtom: null }) } }));
vi.mock("./companion-open", () => ({ openChangedFile: vi.fn() }));

// The changed files that sit outside the project (#2450): a path too long for its row gives up the start of its folder
// and keeps its file name, which is what tells two files apart; the whole path is in the tooltip.

const Long =
    "/private/tmp/agent-501/-work-lantern/1f0c2a9e-4b7d-4c1e-9a52-7d3e8f60b1c4/scratchpad/ticket-usage-slim.md";
const Notes = "/home/dev/.agent/projects/-work-lantern/memory/settings-search-decisions.md";

const file = (path: string, kind = "update"): CompanionFile =>
    ({ path, kind, added: 3, removed: 1, edits: 1 }) as CompanionFile;

const files = [
    file("/w/src/settings/search-index.ts"),
    file("/w/README.md"),
    file(Long, "add"),
    file(Notes),
    file("/tmp/seed.json", "add"),
    file("/w/src/old-filter.ts", "delete"),
];

// The dashboard's stylesheet, read while the file is collected (collection has no timeout, #2274).
const CssRules = postcss.parse(readFileSync(join(__dirname, "companion-dashboard.css"), "utf8"));

function decls(selector: string): Map<string, string> {
    const found = new Map<string, string>();
    CssRules.walkRules((rule) => {
        if (rule.selector.replace(/\s+/g, " ").trim() === selector) {
            rule.each((node) => {
                if (node.type === "decl") {
                    found.set(node.prop, node.value);
                }
            });
        }
    });
    return found;
}

function markup(): string {
    return renderToStaticMarkup(
        <FilesSection
            target="t1"
            companionId="c1"
            files={files}
            folder="/w"
            home="/home/dev"
            frame={({ body }) => <div>{body}</div>}
        />
    );
}

// The rows of the group outside the project, then those inside.
function rowsOf(html: string): string[] {
    return html.split('data-testid="companion-file"').slice(1);
}

const dirOf = (row: string) => /<span class="mt-cdash-fdir" dir="rtl"><bdi>([^<]*)<\/bdi><\/span>/.exec(row)?.[1];
const nameOf = (row: string) => /<span class="mt-cdash-fname">([^<]*)<\/span>/.exec(row)?.[1];
const titleOf = (row: string) => /class="mt-cdash-fbutton" data-tip="([^"]*)"/.exec(row)?.[1];

describe("a changed file's path in its row (#2450)", () => {
    const rows = rowsOf(markup());

    it("splits a path into its folder, quiet, and its file name, bright: the name is never part of the folder", () => {
        expect(shownFile(file(Long), "/w", "/home/dev")).toMatchObject({
            dir: "/private/tmp/agent-501/-work-lantern/1f0c2a9e-4b7d-4c1e-9a52-7d3e8f60b1c4/scratchpad/",
            name: "ticket-usage-slim.md",
            outside: true,
        });
        expect(shownFile(file(Notes), "/w", "/home/dev")).toMatchObject({
            dir: "~/.agent/projects/-work-lantern/memory/",
            name: "settings-search-decisions.md",
            outside: true,
        });
    });

    it("draws the file name whole in its own span and the folder before it, dimmed, from its start", () => {
        // The project's files come first, then the group outside the project.
        expect(rows).toHaveLength(6);
        const outside = rows.filter((row) => row.startsWith(' data-outside=""'));
        expect(outside).toHaveLength(3);
        expect(nameOf(outside[0])).toBe("ticket-usage-slim.md");
        expect(dirOf(outside[0])).toBe(
            "/private/tmp/agent-501/-work-lantern/1f0c2a9e-4b7d-4c1e-9a52-7d3e8f60b1c4/scratchpad/"
        );
        expect(nameOf(outside[1])).toBe("settings-search-decisions.md");
        expect(dirOf(outside[1])).toBe("~/.agent/projects/-work-lantern/memory/");
        expect(nameOf(outside[2])).toBe("seed.json");
        expect(dirOf(outside[2])).toBe("/tmp/");
        expect(outside.every((row) => row.includes('<span class="mt-cdash-tag">outside</span>'))).toBe(true);
    });

    it("keeps the whole path in the tooltip: the absolute one outside the project, the relative one inside", () => {
        const outside = rows.filter((row) => row.startsWith(' data-outside=""'));
        expect(titleOf(outside[0])).toBe(Long);
        expect(titleOf(outside[1])).toBe(Notes);
        const inside = rows.filter((row) => !row.startsWith(' data-outside=""'));
        expect(titleOf(inside[0])).toBe("src/settings/search-index.ts");
        expect(dirOf(inside[0])).toBe("src/settings/");
    });

    it("draws a file at the project's root without a folder", () => {
        const root = rows.find((row) => nameOf(row) === "README.md");
        expect(root).toBeDefined();
        expect(root).not.toContain("mt-cdash-fdir");
        expect(titleOf(root)).toBe("README.md");
    });

    it("lays a long path out so that its folder gives way, from its start, before its name does", () => {
        const path = decls(".mt-cdash-fpath");
        expect(path.get("display")).toBe("flex");
        expect(path.get("overflow")).toBe("hidden");
        expect(path.get("white-space")).toBe("nowrap");
        // The folder shrinks, and its ellipsis is at its start: it is right to left, its text an isolate (the <bdi>).
        const dir = decls(".mt-cdash-fdir");
        expect(dir.get("flex")).toBe("0 1 auto");
        expect(dir.get("min-width")).toBe("0");
        expect(dir.get("overflow")).toBe("hidden");
        expect(dir.get("text-overflow")).toBe("ellipsis");
        expect(dir.get("text-align")).toBe("left");
        // The name does not shrink while the folder has anything to give; only a name longer than the row is cut.
        const name = decls(".mt-cdash-fname");
        expect(name.get("flex")).toBe("none");
        expect(name.get("max-width")).toBe("100%");
        expect(name.get("text-overflow")).toBe("ellipsis");
    });
});

// The counts of a row (#2450): a right-aligned column at the row's end, after the path, which takes the remaining width,
// and the tag; the numbers are right-aligned in tabular figures, so those of every row stand one under the other.
describe("a changed file's counts in its row (#2450)", () => {
    const rows = rowsOf(markup());

    it("puts the path, which takes the width left, then the tag, then the counts, then the open tool", () => {
        const outside = rows.find((row) => nameOf(row) === "ticket-usage-slim.md");
        const at = [
            'class="mt-cdash-fbutton"',
            'class="mt-cdash-tag"',
            'class="mt-cdash-fdelta"',
            "mt-cdash-fopen",
        ].map((mark) => outside.indexOf(mark));
        expect(at.every((i) => i > -1)).toBe(true);
        expect([...at].sort((a, b) => a - b)).toEqual(at);
        const button = decls(".mt-cdash-fbutton");
        expect(button.get("flex")).toBe("1");
        expect(button.get("min-width")).toBe("0");
        expect(decls(".mt-cdash-fpath").get("flex")).toBe("1");
        expect(decls(".mt-cdash-frow").get("display")).toBe("flex");
        // The row's own children never grow past their content, so the path alone takes what is left.
        expect(decls(".mt-cdash-fdelta").get("flex")).toBe("none");
    });

    it("sets the added and the removed counts in two right-aligned tracks of tabular figures", () => {
        const delta = decls(".mt-cdash-fdelta");
        expect(delta.get("display")).toBe("grid");
        expect(delta.get("grid-template-columns")).toBe("minmax(4ch, auto) minmax(3ch, auto)");
        expect(delta.get("font-variant-numeric")).toBe("tabular-nums");
        expect(delta.get("font-family")).toContain("mono");
        expect(decls(".mt-cdash-fdelta > [data-add], .mt-cdash-fdelta > [data-del]").get("text-align")).toBe("right");
        for (const row of rows) {
            expect(row).toMatch(
                /<span class="mt-cdash-fdelta"><span data-add="">\+\d+<\/span> <span data-del="">−\d+<\/span>/
            );
        }
    });

    it("keeps the open tool's place on a row that has none, so a deleted file's counts line up with the others'", () => {
        const deleted = rows.find((row) => nameOf(row) === "old-filter.ts");
        expect(deleted).toBeDefined();
        expect(deleted).toContain('class="mt-cdash-fopen-slot"');
        expect(deleted).not.toContain('mt-cdash-fopen"');
        for (const row of rows.filter((r) => r !== deleted)) {
            expect(row).toContain('mt-cdash-fopen"');
            expect(row).not.toContain("mt-cdash-fopen-slot");
        }
        const slot = decls(".mt-cdash-fopen-slot");
        expect(slot.get("width")).toBe(decls(".mt-cb-tool").get("min-width"));
        expect(slot.get("flex")).toBe("none");
    });
});
