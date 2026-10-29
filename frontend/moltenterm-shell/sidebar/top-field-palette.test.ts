// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// One search surface (FR-SHELL-113): the palette's entries live in the top field. Every entry the palette dialog
// listed is found by typing its name, even among many views of the same name; the empty field shows Views, Agents,
// Panels, Actions and Workspaces.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PaletteEntry } from "../palette/palette-model";
import { buildPaletteEntries } from "../palette/palette-sources";
import {
    fieldResults,
    FieldRow,
    MaxFieldRows,
    MaxRowsPerGroup,
    paletteFieldRows,
    palettePlacement,
} from "./top-field-model";

const DefaultAgents = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../pkg/wconfig/defaultconfig/presets/agents.json"), "utf8")
);
const DefaultWidgets = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../pkg/wconfig/defaultconfig/widgets.json"), "utf8")
);

// What the palette dialog listed with every optional entry present: a linked project, a browser panel and an
// installed browser, outdated terminals, recent folders and other workspaces.
function everyPaletteEntry(): PaletteEntry[] {
    return buildPaletteEntries({
        presets: DefaultAgents,
        widgets: DefaultWidgets,
        workspaceId: "ws1",
        folder: "/p",
        recentFolders: ["/work/notulia", "/work/site"],
        otherFolders: ["/work/other"],
        workspaces: [
            { id: "ws1", name: "Molten", icon: "", color: "", active: true },
            { id: "ws2", name: "Notulia", icon: "", color: "", active: false },
        ],
        home: "",
        projectLinked: true,
        installedBrowser: { id: "chrome", name: "Chrome" },
        hasBrowserPanel: true,
        outdatedTerminals: 2,
    });
}

function view(name: string, i: number): FieldRow {
    return {
        id: `view:${name}:${i}`,
        group: "view",
        label: name,
        here: true,
        run: { kind: "view", tabId: `t${i}`, workspaceId: "ws1" },
    };
}

// The panel commands (⌘.) are read from the focused panel; one stands in for them.
const PanelCommand: PaletteEntry = {
    id: "panel:term:clear",
    group: "panel",
    label: "Clear the scrollback",
    icon: "eraser",
    run: { kind: "panelcommand", entryId: "term:clear" },
};

describe("every palette entry is reachable from the top field (FR-SHELL-113, AC-1)", () => {
    const entries = [...everyPaletteEntry(), PanelCommand];
    const rows = paletteFieldRows(entries);

    it("maps each entry but the workspace switches, which the field lists as workspaces", () => {
        const switches = entries.filter((e) => e.run.kind === "switchworkspace");
        expect(switches.map((e) => e.id)).toEqual(["action:switch:ws2"]);
        expect(rows.map((r) => r.id)).toEqual(
            entries.filter((e) => e.run.kind !== "switchworkspace").map((e) => `palette:${e.id}`)
        );
    });

    it("finds each entry by its name, even with many views named alike", () => {
        for (const entry of entries) {
            if (entry.run.kind === "switchworkspace") {
                continue;
            }
            // Views named like the entry rank first and would fill a list with no limit per group.
            const crowd = Array.from({ length: 12 }, (_, i) => view(entry.label, i));
            const res = fieldResults(entry.label, [...crowd, ...rows], { onPage: false }, "Molten");
            expect(
                res.flat.map((r) => r.id),
                entry.label
            ).toContain(`palette:${entry.id}`);
        }
    });

    it("keeps the list short and no group above its share", () => {
        const crowd = Array.from({ length: 20 }, (_, i) => view("Terminal", i));
        const res = fieldResults("terminal", [...crowd, ...rows], { onPage: false }, "Molten");
        expect(res.flat.length).toBeLessThanOrEqual(MaxFieldRows);
        expect(res.flat.filter((r) => r.group === "view")).toHaveLength(MaxRowsPerGroup);
        expect(res.flat.map((r) => r.id)).toContain("palette:panel:defwidget@terminal");
    });

    it("lists the focused panel's commands apart from the actions", () => {
        expect(rows.find((r) => r.id === "palette:panel:term:clear").group).toBe("command");
        expect(rows.find((r) => r.id === "palette:action:settings").group).toBe("action");
        expect(rows.find((r) => r.id === "palette:panel:defwidget@terminal").group).toBe("panel");
        expect(rows.find((r) => r.id.startsWith("palette:agent:")).group).toBe("panel");
        expect(rows.find((r) => r.id.startsWith("palette:folder:")).group).toBe("panel");
    });
});

describe("the empty field's sections (FR-SHELL-113)", () => {
    it("Views, Agents, Panels, Actions, Workspaces, in this order", () => {
        const rows: FieldRow[] = [
            view("Scoping", 1),
            { id: "agent:b1", group: "agent", label: "Olivia", run: { kind: "agent", blockId: "b1" } },
            ...paletteFieldRows(everyPaletteEntry()),
            {
                id: "workspace:ws2",
                group: "workspace",
                label: "Notulia",
                workspaceName: "Notulia",
                run: { kind: "workspace", workspaceId: "ws2" },
            },
        ];
        const res = fieldResults("", rows, { onPage: false }, "Molten");
        expect(res.sections.map((s) => s.title)).toEqual([
            "Views of Molten",
            "Agents",
            "Panels",
            "Actions",
            "Workspaces",
        ]);
        expect(res.sections[2].rows.length).toBeGreaterThan(0);
        expect(res.sections[3].rows.length).toBeGreaterThan(0);
        expect(res.sections[3].rows.every((r) => r.group === "action")).toBe(true);
    });
});

describe("palettePlacement", () => {
    const panel = { kind: "widget", blockdef: { meta: { view: "term" } } } as const;

    it("fills an empty panel in place, as the palette did", () => {
        expect(palettePlacement(panel, false, { blockId: "b1", isLauncher: true })).toBe("replace");
    });

    it("opens beside the focused panel with ⌥, else in a new panel", () => {
        expect(palettePlacement(panel, true, { blockId: "b1", isLauncher: true })).toBe("right");
        expect(palettePlacement(panel, false, { blockId: "b1" })).toBe("new");
        expect(palettePlacement(panel, false, {})).toBe("new");
    });

    it("an action never takes a panel's place", () => {
        expect(palettePlacement({ kind: "settings" }, false, { blockId: "b1", isLauncher: true })).toBe("new");
    });
});
