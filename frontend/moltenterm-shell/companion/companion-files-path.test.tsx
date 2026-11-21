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
];

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
const titleOf = (row: string) => /class="mt-cdash-fbutton" title="([^"]*)"/.exec(row)?.[1];

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
        expect(rows).toHaveLength(5);
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
        const css = readFileSync(join(__dirname, "companion-dashboard.css"), "utf8");
        const decls = (selector: string): Map<string, string> => {
            const found = new Map<string, string>();
            postcss.parse(css).walkRules((rule) => {
                if (rule.selector.replace(/\s+/g, " ").trim() === selector) {
                    rule.each((node) => {
                        if (node.type === "decl") {
                            found.set(node.prop, node.value);
                        }
                    });
                }
            });
            return found;
        };
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
