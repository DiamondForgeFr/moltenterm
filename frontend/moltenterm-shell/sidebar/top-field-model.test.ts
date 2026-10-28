// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    addressRows,
    enterRun,
    fieldContext,
    fieldHint,
    fieldResults,
    FieldRow,
    looksLikeAddress,
    matchScore,
    placePopover,
} from "./top-field-model";

describe("placePopover", () => {
    const inside = (p: { left: number; width: number }, w: number) => p.left >= 0 && p.left + p.width <= w;

    it("sits under the field, wider than the sidebar in a wide window", () => {
        expect(placePopover({ left: 18, bottom: 60, width: 240 }, 1400)).toEqual({ left: 14, top: 64, width: 420 });
    });

    it("stays inside the window while a hidden sidebar is still off its left edge (#1219)", () => {
        const p = placePopover({ left: -270, bottom: 60, width: 240 }, 1400);
        expect(p.left).toBeGreaterThanOrEqual(8);
        expect(inside(p, 1400)).toBe(true);
    });

    it("never overflows a narrow window on either side", () => {
        for (const left of [-500, 0, 300, 700]) {
            expect(inside(placePopover({ left, bottom: 60, width: 240 }, 800), 800)).toBe(true);
            expect(inside(placePopover({ left, bottom: 60, width: 700 }, 600), 600)).toBe(true);
        }
    });
});

function view(name: string, here = true, current = false): FieldRow {
    return {
        id: `view:${name}`,
        group: "view",
        label: name,
        here,
        current,
        run: { kind: "view", tabId: name, workspaceId: here ? "ws1" : "ws2" },
    };
}

function workspace(name: string): FieldRow {
    return {
        id: `workspace:${name}`,
        group: "workspace",
        label: name,
        workspaceName: name,
        run: { kind: "workspace", workspaceId: name },
    };
}

const agent: FieldRow = {
    id: "agent:b1",
    group: "agent",
    label: "Valentin · Claude Code",
    run: { kind: "agent", blockId: "b1" },
};

describe("fieldContext", () => {
    it("shows a page's address", () => {
        expect(fieldContext({ url: "https://github.com/x", viewName: "PR", panelCount: 2 })).toEqual({
            icon: "globe",
            text: "https://github.com/x",
            url: true,
        });
    });

    it("names the panel and its view when the view holds several panels", () => {
        expect(
            fieldContext({ panelLabel: "Valentin", panelIcon: "robot", viewName: "Review", panelCount: 2 }).text
        ).toBe("Valentin · Review");
    });

    it("never repeats a name", () => {
        expect(fieldContext({ panelLabel: "Valentin", viewName: "Valentin", panelCount: 2 }).text).toBe("Valentin");
        expect(fieldContext({ panelLabel: "web", viewName: "web · docs", panelCount: 3 }).text).toBe("web · docs");
        expect(fieldContext({ panelLabel: "zsh", viewName: "Build", panelCount: 1 }).text).toBe("Build");
    });

    it("shows nothing to name without a view", () => {
        expect(fieldContext({}).text).toBe("");
    });
});

describe("looksLikeAddress", () => {
    it("tells an address from words", () => {
        for (const s of ["github.com", "https://x.dev/a b", "localhost:3000", "127.0.0.1:8080/x", "about:blank"]) {
            expect(looksLikeAddress(s.replace(" ", ""))).toBe(true);
        }
        for (const s of ["Notu", "notulia app", "", "readme.m"]) {
            expect(looksLikeAddress(s)).toBe(false);
        }
    });
});

describe("addresses", () => {
    it("on a page: Enter here, ⌥Enter beside, ⌘Enter a new view", () => {
        const rows = addressRows("github.com/a", { onPage: true, pageHost: "docs.dev" });
        expect(rows.map((r) => [r.key, r.run.kind === "address" && r.run.mode])).toEqual([
            ["↵", "here"],
            ["⌥↵", "beside"],
            ["⌘↵", "newview"],
        ]);
        expect(rows[0].run).toMatchObject({ url: "https://github.com/a" });
    });

    it("elsewhere: Enter a new view, ⌥Enter in this view", () => {
        const rows = addressRows("localhost:5173", { onPage: false, viewName: "Build" });
        expect(rows.map((r) => [r.key, r.run.kind === "address" && r.run.mode])).toEqual([
            ["↵", "newview"],
            ["⌥↵", "beside"],
        ]);
        expect(rows[0].run).toMatchObject({ url: "http://localhost:5173" });
    });

    it("the modifiers choose on any address row", () => {
        const [here] = addressRows("github.com", { onPage: true });
        expect(enterRun(here, {})).toMatchObject({ mode: "here" });
        expect(enterRun(here, { alt: true })).toMatchObject({ mode: "beside" });
        expect(enterRun(here, { meta: true })).toMatchObject({ mode: "newview" });
        expect(enterRun(agent, { meta: true })).toBe(agent.run);
    });

    it("the hint line says what each key does in the current focus", () => {
        expect(fieldHint(true).map((h) => h.keys)).toEqual(["↵", "⌥↵", "⌘↵"]);
        expect(fieldHint(false).map((h) => h.keys)).toEqual(["↵", "⌥↵"]);
    });
});

describe("fieldResults", () => {
    const rows = [
        view("Pilotage"),
        view("Build", true, true),
        view("Notes", false),
        agent,
        workspace("Notulia"),
        workspace("MoltenTerm"),
    ];

    it("empty: this workspace's other views, the agents, the workspaces", () => {
        const res = fieldResults("", rows, { onPage: false }, "Molten");
        expect(res.sections.map((s) => s.rows.map((r) => r.id))).toEqual([
            ["view:Pilotage"],
            ["agent:b1"],
            ["workspace:Notulia", "workspace:MoltenTerm"],
        ]);
    });

    it("a workspace whose name starts with the text comes first", () => {
        const withNote: FieldRow[] = [{ ...view("Notulia notes"), id: "view:nn" }, ...rows];
        const res = fieldResults("Notu", withNote, { onPage: false }, "Molten");
        expect(res.flat[0].id).toBe("workspace:Notulia");
    });

    it("an address comes before the matches", () => {
        const res = fieldResults("github.com", rows, { onPage: true }, "Molten");
        expect(res.flat[0].id).toBe("address:here");
    });

    it("words nothing matches search the web in a new view", () => {
        const res = fieldResults("zzz qqq", rows, { onPage: false }, "Molten");
        expect(res.flat).toHaveLength(1);
        expect(res.flat[0].run).toMatchObject({ kind: "address", mode: "newview" });
    });

    it("matches every word, ignoring case and accents", () => {
        const row: FieldRow = { ...view("Équipe design"), id: "v" };
        expect(matchScore("equipe", row)).toBe(3);
        expect(matchScore("des", row)).toBe(2);
        expect(matchScore("design equ", row)).not.toBeNull();
        expect(matchScore("zz", row)).toBeNull();
    });
});
