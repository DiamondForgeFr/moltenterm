// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A plate's menu and the layer's bar (FR-BOSS-010 AC27, #2247). The tests run in a plain Node environment: the markup is
// read with patterns. Synthetic data only.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
const shown = vi.hoisted(() => ({ menus: [] as any[] }));
vi.mock("@/app/store/contextmenu", () => ({
    ContextMenuModel: { getInstance: () => ({ showContextMenu: (menu: any[]) => shown.menus.push(menu) }) },
}));
vi.mock("../boss/boss-store", async () => {
    const { atom } = await import("jotai");
    const nameAtom = atom("Brokk");
    return { BossBubbleModel: { getInstance: () => ({ nameAtom }) } };
});
vi.mock("./brainstorm-store", async () => {
    const { atom } = await import("jotai");
    const model = {
        stateAtom: atom(null),
        undoBarAtom: atom(null),
        linkingAtom: atom(null),
        startEdit: vi.fn(),
        retype: vi.fn(async () => true),
        startLink: vi.fn(),
        remove: vi.fn(async () => true),
        cancelLink: vi.fn(),
        undo: vi.fn(),
        dismissUndo: vi.fn(),
    };
    return { BrainstormModel: { getInstance: () => model } };
});

import { globalStore } from "@/app/store/jotaiStore";
import { t } from "../i18n/i18n";
import { BrainstormEditBar, openPlateMenu, plateMenuItems, undoBarText } from "./brainstorm-edit";
import type { BrainstormNode } from "./brainstorm-graph-model";
import { BrainstormModel } from "./brainstorm-store";

const model = BrainstormModel.getInstance() as any;

const node = (id: string, kind: string, text: string, from = "") =>
    ({ id, kind, text, from, status: "open", turn: 1, at: 1, pos: [0, 0, 0] }) as BrainstormNode;

const graph = {
    schema: 1,
    rev: 2,
    centre: "kids-video",
    nodes: [
        node("kids-video", "topic", "A safe video app for children"),
        node("parents-list", "idea", "Parents validate a list", "kids-video"),
        node("ref-forge", "reference", "Forge notes", "kids-video"),
    ],
    links: [],
};

const visible = (items: ContextMenuItem[]) => items.filter((i) => i.visible !== false && i.type !== "separator");

beforeEach(() => {
    shown.menus.length = 0;
    vi.clearAllMocks();
    globalStore.set(model.stateAtom, { allowed: true, open: true, version: 1, swap: 1, graph });
    globalStore.set(model.undoBarAtom, null);
    globalStore.set(model.linkingAtom, null);
});

describe("a plate's menu (FR-BOSS-010 AC27, #2247)", () => {
    it("offers Edit text, Change kind, Link to… and Remove on a plate, and each acts on that node", () => {
        const items = plateMenuItems(graph.nodes[1], "kids-video", t, model);
        expect(visible(items).map((i) => i.label)).toEqual(["Edit text", "Change kind", "Link to…", "Remove"]);
        const kinds = items[1].submenu;
        expect(kinds.map((k) => k.label)).toEqual(["Question", "Answer", "Idea", "Theme", "Decision", "Conclusion"]);
        expect(kinds.find((k) => k.checked)?.label).toBe("Idea");
        kinds.find((k) => k.label === "Decision").click();
        expect(model.retype).toHaveBeenCalledWith("parents-list", "decision");
        items[0].click();
        expect(model.startEdit).toHaveBeenCalledWith("parents-list");
        items[2].click();
        expect(model.startLink).toHaveBeenCalledWith("parents-list");
        items[4].click();
        expect(model.remove).toHaveBeenCalledWith("parents-list");
        // No confirmation: Remove acts at once, the bar offers Undo.
        expect(items.some((i) => /confirm|sure/i.test(i.label ?? ""))).toBe(false);
    });

    it("lets the centre's title be edited or linked, never retyped nor removed; a reference offers nothing", () => {
        expect(visible(plateMenuItems(graph.nodes[0], "kids-video", t, model)).map((i) => i.label)).toEqual([
            "Edit text",
            "Link to…",
        ]);
        expect(visible(plateMenuItems(graph.nodes[2], "kids-video", t, model))).toEqual([]);
        expect(plateMenuItems(null, "kids-video", t, model)).toEqual([]);
    });

    it("opens at the event for a node of the graph on screen, and stops a Link to… waiting", () => {
        const event = { clientX: 10, clientY: 20, stopPropagation: () => {}, preventDefault: () => {} } as any;
        expect(openPlateMenu("parents-list", event)).toBe(true);
        expect(shown.menus).toHaveLength(1);
        expect(model.cancelLink).toHaveBeenCalled();
        expect(openPlateMenu("ref-forge", event)).toBe(false);
        expect(openPlateMenu("nowhere", event)).toBe(false);
        expect(shown.menus).toHaveLength(1);
    });
});

const offer = (by: "you" | "brokk", op: string) => ({
    kind: "offer" as const,
    key: "1:4",
    note: { seq: 4, at: 4, by, op, nodes: [{ id: "parents-list", text: "Parents validate a list" }], undoable: true },
});

describe("the layer's bar (AC27)", () => {
    it("says whose removal or merge it offers to put back, in the interface language", () => {
        expect(undoBarText(offer("you", "remove"), "Brokk", t)).toBe("You removed “Parents validate a list”");
        expect(undoBarText(offer("brokk", "remove"), "Brokk", t)).toBe("Brokk removed “Parents validate a list”");
        expect(undoBarText(offer("brokk", "merge"), "Brokk", t)).toBe(
            "Brokk folded plates into “Parents validate a list”"
        );
        expect(undoBarText({ kind: "failed", key: "f", reason: "conflict" }, "Brokk", t)).toBe(
            "A later change touched it: nothing was put back."
        );
        expect(undoBarText({ kind: "failed", key: "f", reason: "rumour" }, "Brokk", t)).toBe(
            "That did not work: the graph stays as it was."
        );
        expect(undoBarText(null, "Brokk", t)).toBe("");
    });

    it("shows Undo and a dismiss for an offer, a dismiss alone for a failure, and nothing otherwise", () => {
        expect(renderToStaticMarkup(<BrainstormEditBar />)).toBe("");
        globalStore.set(model.undoBarAtom, offer("you", "remove"));
        const html = renderToStaticMarkup(<BrainstormEditBar />);
        expect(html).toContain('role="status"');
        expect(html).toContain('data-testid="brainstorm-undo"');
        expect(html).toMatch(/>Undo</);
        expect(html).toContain('aria-label="Dismiss"');
        globalStore.set(model.undoBarAtom, { kind: "failed", key: "f", reason: "invalid" });
        const failed = renderToStaticMarkup(<BrainstormEditBar />);
        expect(failed).toContain('role="alert"');
        expect(failed).not.toContain('data-testid="brainstorm-undo"');
    });

    it("guides Link to… with a way out", () => {
        globalStore.set(model.linkingAtom, "parents-list");
        const html = renderToStaticMarkup(<BrainstormEditBar />);
        expect(html).toContain('data-testid="brainstorm-linking"');
        expect(html).toContain("Link “Parents validate a list” to another plate: click it, or Esc to cancel");
        expect(html).toMatch(/>Cancel</);
    });

    it("styles every loop of the living graph with a still state under reduced motion", () => {
        const css = readFileSync(join(__dirname, "brainstorm-edit.css"), "utf8");
        expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.mt-bs-editbar[\s\S]*mt-bs-editbar-fade/);
        expect(css).toMatch(/\.prefers-reduced-motion \.mt-bs-plates \.mt-bs-plate\.is-retyped \{\s*animation: none;/);
        // A leaving plate takes no pointer: a click never lands on a plate on its way out.
        expect(css).toMatch(/\.mt-bs-plate\.is-leaving \{\s*pointer-events: none;/);
    });
});
