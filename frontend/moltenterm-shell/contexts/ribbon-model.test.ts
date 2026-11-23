// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import {
    collapsedRibbonShown,
    hintText,
    menuKeyTarget,
    ribbonLabel,
    ribbonPaint,
    waitingAgentsIn,
} from "./ribbon-model";

const dict: Record<string, string> = {
    "contexts.menu.here": "here",
    "contexts.menu.waiting.one": "{count} agent waiting",
    "contexts.menu.waiting.other": "{count} agents waiting",
    "contexts.menu.workspaces.one": "{count} workspace",
    "contexts.menu.workspaces.other": "{count} workspaces",
    "contexts.ribbon.label": "Context {name}: choose another",
    "contexts.ribbon.waiting.one": "{count} agent waiting in another context",
    "contexts.ribbon.waiting.other": "{count} agents waiting in another context",
};

function fill(text: string, vars: Record<string, any> = {}): string {
    return text.replace(/\{(\w+)\}/g, (_, k) => String(vars[k]));
}

const t = (key: string, vars?: Record<string, any>) => fill(dict[key] ?? key, vars);
const tc = (key: string, count: number, vars?: Record<string, any>) =>
    fill(dict[`${key}.${count === 1 ? "one" : "other"}`] ?? key, { count, ...vars });

describe("the ribbon's paint", () => {
    it("takes the workspace's colour and the ink that reads on it", () => {
        const light = ribbonPaint("#58C142");
        expect(light.paint).toBe("#58c142");
        expect(light.ink).toBe("#000000");
        expect(ribbonPaint("#0a0a40").ink).toBe("#ffffff");
    });

    it("paints a gradient workspace with its gradient", () => {
        expect(ribbonPaint("#58C142,#BF55EC").paint).toContain("linear-gradient");
    });

    it("falls back to the secondary colour for a workspace without one", () => {
        expect(ribbonPaint("").paint).toBe("var(--color-secondary)");
        expect(ribbonPaint(undefined).paint).toBe("var(--color-secondary)");
    });
});

describe("the texts", () => {
    it("says where the window is, what waits, or how many workspaces", () => {
        expect(hintText({ kind: "here" }, t, tc)).toBe("here");
        expect(hintText({ kind: "waiting", count: 1 }, t, tc)).toBe("1 agent waiting");
        expect(hintText({ kind: "waiting", count: 3 }, t, tc)).toBe("3 agents waiting");
        expect(hintText({ kind: "workspaces", count: 1 }, t, tc)).toBe("1 workspace");
        expect(hintText({ kind: "workspaces", count: 4 }, t, tc)).toBe("4 workspaces");
    });

    it("names the context to a screen reader, and the agents that wait elsewhere", () => {
        expect(ribbonLabel("DiamondForge", 0, t, tc)).toBe("Context DiamondForge: choose another");
        expect(ribbonLabel("DiamondForge", 2, t, tc)).toBe(
            "Context DiamondForge: choose another. 2 agents waiting in another context"
        );
    });
});

describe("the agents that wait in a workspace", () => {
    const data = {
        states: {
            a: { blockid: "a", workspaceid: "w1", state: "waiting" },
            b: { blockid: "b", workspaceid: "w1", state: "working" },
            c: { blockid: "c", workspaceid: "w2", state: "waiting" },
            d: { blockid: "d", workspaceid: "w1", state: "waiting" },
        } as unknown as Record<string, AgentStateInfo>,
    } as AgentStatesData;

    it("counts the ones that wait, of that workspace only", () => {
        expect(waitingAgentsIn(data, "w1")).toBe(2);
        expect(waitingAgentsIn(data, "w2")).toBe(1);
        expect(waitingAgentsIn(data, "w3")).toBe(0);
    });
});

describe("where the collapsed ribbon shows", () => {
    it("shows while the sidebar is collapsed and quiet", () => {
        expect(collapsedRibbonShown(true, false, "rest")).toBe(true);
        expect(collapsedRibbonShown(true, false, null)).toBe(true);
    });

    it("gives way to the sidebar sliding over it and to Brokk's strip", () => {
        expect(collapsedRibbonShown(false, false, null)).toBe(false);
        expect(collapsedRibbonShown(true, true, "rest")).toBe(false);
        expect(collapsedRibbonShown(true, false, "peek")).toBe(false);
        expect(collapsedRibbonShown(true, false, "ajar")).toBe(false);
    });
});

describe("the menu's keys", () => {
    it("moves down and up through the rows, around the ends", () => {
        expect(menuKeyTarget("ArrowDown", 0, 4)).toBe(1);
        expect(menuKeyTarget("ArrowDown", 3, 4)).toBe(0);
        expect(menuKeyTarget("ArrowUp", 0, 4)).toBe(3);
        expect(menuKeyTarget("ArrowUp", 2, 4)).toBe(1);
    });

    it("starts at an end when no row has the focus", () => {
        expect(menuKeyTarget("ArrowDown", -1, 4)).toBe(0);
        expect(menuKeyTarget("ArrowUp", -1, 4)).toBe(3);
    });

    it("goes to the first and last rows, and leaves other keys alone", () => {
        expect(menuKeyTarget("Home", 2, 4)).toBe(0);
        expect(menuKeyTarget("End", 0, 4)).toBe(3);
        expect(menuKeyTarget("a", 0, 4)).toBeNull();
        expect(menuKeyTarget("ArrowDown", 0, 0)).toBeNull();
    });
});
