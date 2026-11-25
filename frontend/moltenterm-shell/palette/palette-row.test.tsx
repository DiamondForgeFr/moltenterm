// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What a row of the chooser says about why it is there (#2312, FR-SHELL-089): the typed letters highlighted in its label
// and its detail, and the hidden search word a result was found through, shown after its label.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PaletteEntry } from "./palette-model";
import { PaletteRow } from "./palette-row";

function entry(label: string, extra: Partial<PaletteEntry> = {}): PaletteEntry {
    return { id: label, group: "panels", label, icon: "circle", run: { kind: "newtab" }, ...extra };
}

function row(e: PaletteEntry, query: string): string {
    return renderToStaticMarkup(
        <PaletteRow entry={e} index={0} selected={false} query={query} onHover={() => {}} onOpen={() => {}} />
    );
}

function hits(html: string): string[] {
    return [...html.matchAll(/data-role="palette-hit">([^<]*)</g)].map((m) => m[1]);
}

const Integration = entry("Integration", { keywords: ["pull request", "pr", "review", "github"] });

describe("a row says why it matches", () => {
    it("highlights the typed letters in the label", () => {
        expect(hits(row(entry("Terminal"), "term"))).toEqual(["Term"]);
        expect(hits(row(entry("Claude Code"), "cc"))).toEqual(["C", "C"]);
    });

    it("shows the hidden word a result was found through, its letters highlighted, after the label", () => {
        const html = row(Integration, "github");
        expect(html).toContain('data-role="palette-keyword"');
        expect(html).toMatch(/Integration<\/span><span[^>]*data-role="palette-keyword">· <span[^>]*>github<\/span>/);
        expect(hits(html)).toEqual(["github"]);
    });

    it("shows no hidden word for a match of the label, and none without a query", () => {
        expect(row(Integration, "integ")).not.toContain("palette-keyword");
        expect(row(Integration, "")).not.toContain("palette-keyword");
        expect(row(Integration, "")).not.toContain("palette-hit");
    });

    it("highlights the letters found in the detail, not in the label", () => {
        const html = row(entry("Files", { detail: "browse the project folder" }), "folder");
        expect(hits(html)).toEqual(["folder"]);
        expect(html).toMatch(/data-role="palette-detail">browse the project <span[^>]*>folder<\/span>/);
        expect(html).not.toContain("palette-keyword");
    });

    it("draws the web row with the engine's mark and its words as typed, without highlighting them", () => {
        const html = row(
            entry("Search the web for “github”", {
                id: "web:search",
                group: "web",
                detail: "with Brave Search",
                mark: "Br",
            }),
            "github"
        );
        expect(html).toContain('data-role="engine-mark"');
        expect(html).toContain(">Br<");
        expect(html).toContain("with Brave Search");
        expect(html).not.toContain("palette-hit");
    });
});

// #2542, FR-BOSS-009 AC113: the launcher's and the chooser's agent rows start with their provider's own mark.
describe("an agent row shows its provider's mark", () => {
    const agentRow = (agent: string | undefined, label: string) =>
        row(entry(label, { group: "agents", icon: "sparkles", agent }), "");

    it("draws the mark of an agent that has one, in place of the AI icon", () => {
        for (const [agent, label] of [
            ["claude", "Claude Code"],
            ["codex", "Codex"],
            ["cursor", "Cursor CLI"],
            ["opencode", "OpenCode"],
        ]) {
            const html = agentRow(agent, label);
            expect(html, agent).toContain(`data-mark="${agent}"`);
            expect(html, agent).toContain("<img ");
            expect(html, agent).not.toContain("sparkles");
            expect(html, agent).toContain(`>${label}<`);
        }
    });

    it("keeps the AI icon for an agent without a mark, and for a row of the developer's own", () => {
        for (const agent of [undefined, "kimi", "vibe", "my-agent"]) {
            const html = agentRow(agent, "Some agent");
            expect(html, String(agent)).toContain("sparkles");
            expect(html, String(agent)).not.toContain("<img ");
            expect(html, String(agent)).not.toContain("provider-mark");
        }
    });

    it("draws the mark in the width of the icon column, so the labels line up", () => {
        expect(agentRow("codex", "Codex")).toMatch(/data-testid="provider-mark"[^>]*/);
        expect(agentRow("codex", "Codex")).toContain("width:16px;height:16px");
    });
});
