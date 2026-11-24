// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { applyPlace, contrastRatio, MinInkContrast, parseColor, workspaceColourStops } from "../accent";
import type { AgentStateInfo, AgentStatesData } from "../agent-state-model";
import { PresetColours, PresetGradients } from "../workspace-colour";
import {
    collapsedRibbonShown,
    hintText,
    menuKeyTarget,
    PlaceGradientPaint,
    PlacePaint,
    ribbonHeatLevel,
    ribbonLabel,
    ribbonPaint,
    waitingAgentsIn,
    windowRibbonPaint,
    workingAgentsIn,
} from "./ribbon-model";

const SidebarCss = readFileSync(new URL("../sidebar/sidebar.css", import.meta.url), "utf8");

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
        expect(light.ink).toBe("#141414");
        expect(ribbonPaint("#0a0a40").ink).toBe("#FAFAFA");
    });

    it("paints a gradient workspace with its gradient", () => {
        expect(ribbonPaint("#58C142,#BF55EC").paint).toContain("linear-gradient");
    });

    it("falls back to the secondary colour for a workspace without one", () => {
        expect(ribbonPaint("").paint).toBe("var(--color-secondary)");
        expect(ribbonPaint(undefined).paint).toBe("var(--color-secondary)");
    });
});

// #2519: the window's ribbon comes out of the liseré down the window's left edge, in exactly its colour.
describe("the window's ribbon paint is the liseré's own", () => {
    const strip = /\n\.mt-sb-place-strip \{([^}]*)\}/.exec(SidebarCss)?.[1] ?? "";
    const stripColour = /background-color:\s*([^;]+);/.exec(strip)?.[1].trim();
    const stripStops = /linear-gradient\(\s*to bottom,\s*([\s\S]*?)\);/.exec(strip)?.[1] ?? "";

    function resolve(paint: string, props: Record<string, string>): string {
        return paint.replace(/var\((--[\w-]+)\)/g, (_, name) => props[name]);
    }

    function fakeStyle() {
        const props: Record<string, string> = {};
        return { props, setProperty: (name: string, value: string) => void (props[name] = value) };
    }

    it("uses the token the strip is painted with, not a copy of its value", () => {
        expect(stripColour).toBe("var(--mt-place)");
        expect(windowRibbonPaint(["#58c142"]).paint).toBe(stripColour);
        expect(windowRibbonPaint(["#58c142"]).paint).toBe(PlacePaint);
    });

    it("uses the stops the strip's gradient is painted with, in the same order", () => {
        const tokens = [...stripStops.matchAll(/var\((--mt-place[\w-]*)/g)].map((m) => m[1]);
        expect(tokens.filter((t, i) => tokens.indexOf(t) === i)).toEqual(["--mt-place", "--mt-place-mid", "--mt-place-end"]);
        const own = [...PlaceGradientPaint.matchAll(/var\((--mt-place[\w-]*)\)/g)].map((m) => m[1]);
        expect(own).toEqual(["--mt-place", "--mt-place-mid", "--mt-place-end"]);
        expect(windowRibbonPaint(["#00ffdb", "#429dff"]).paint).toBe(PlaceGradientPaint);
    });

    it("resolves to the colour applyPlace gives the liseré, flat or gradient", () => {
        for (const stops of [["#58c142"], ["#00ffdb", "#429dff"], ["#ffc53d", "#ff7c0d", "#ff453a"]]) {
            const style = fakeStyle();
            applyPlace(stops[0], style, stops);
            const paint = resolve(windowRibbonPaint(stops).paint, style.props);
            expect(paint).toContain(style.props["--mt-place"]);
            if (stops.length > 1) {
                expect(paint).toContain(style.props["--mt-place-mid"]);
                expect(paint).toContain(style.props["--mt-place-end"]);
            }
        }
    });

    it("is the strip's orange for a workspace without a colour, as the strip is", () => {
        const style = fakeStyle();
        applyPlace(undefined, style);
        expect(windowRibbonPaint([]).paint).toBe(PlacePaint);
        expect(style.props["--mt-place"]).toBe("rgb(255, 124, 13)");
    });

    it("reads the stops of the workspace the way the strip's tokens are made", () => {
        expect(workspaceColourStops({ color: "#00ffdb", meta: { "molten:workspacegradient": "#00ffdb,#429dff" } })).toEqual([
            "#00ffdb",
            "#429dff",
        ]);
        expect(windowRibbonPaint(["#00ffdb", "#429dff"]).ink).toBe("#141414");
    });
});

describe("the ribbon's ink", () => {
    const worst = (stops: string[], ink: string) =>
        Math.min(...stops.map((s) => contrastRatio(parseColor(s), parseColor(ink))));

    it("is #FAFAFA or #141414 and reads at 4.5:1 on every colour of the palette", () => {
        for (const { value } of PresetColours) {
            const { ink } = ribbonPaint(value);
            expect(["#FAFAFA", "#141414"]).toContain(ink);
            expect(worst([value], ink), value).toBeGreaterThanOrEqual(MinInkContrast);
            expect(worst([value], windowRibbonPaint([value]).ink), value).toBeGreaterThanOrEqual(MinInkContrast);
        }
    });

    it("reads at 4.5:1 on every stop of every gradient of the palette", () => {
        for (const { value } of PresetGradients) {
            const stops = value.split(",");
            expect(worst(stops, ribbonPaint(value).ink), value).toBeGreaterThanOrEqual(MinInkContrast);
            expect(worst(stops, windowRibbonPaint(stops).ink), value).toBeGreaterThanOrEqual(MinInkContrast);
        }
    });

    it("reads at 4.5:1 on a custom colour the two inks alone would miss", () => {
        const { ink } = ribbonPaint("#8b5cd6");
        expect(worst(["#8b5cd6"], ink)).toBeGreaterThanOrEqual(MinInkContrast);
    });
});

describe("the activity signal (#2519)", () => {
    const data = {
        states: {
            a: { blockid: "a", workspaceid: "w1", state: "working" },
            b: { blockid: "b", workspaceid: "w1", state: "working" },
            c: { blockid: "c", workspaceid: "w1", state: "waiting" },
            d: { blockid: "d", workspaceid: "w2", state: "working" },
            e: { blockid: "e", workspaceid: "w2", state: "done" },
        } as unknown as Record<string, AgentStateInfo>,
    } as AgentStatesData;

    it("counts the agents of a workspace that work, and no other state", () => {
        expect(workingAgentsIn(data, "w1")).toBe(2);
        expect(workingAgentsIn(data, "w2")).toBe(1);
        expect(workingAgentsIn(data, "w3")).toBe(0);
    });

    it("maps the count to a heat of 0 to 3: none, then one, two, three or more", () => {
        expect([0, 1, 2, 3, 4, 9].map(ribbonHeatLevel)).toEqual([0, 1, 2, 3, 3, 3]);
        expect(ribbonHeatLevel(undefined)).toBe(0);
        expect(ribbonHeatLevel(-2)).toBe(0);
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
