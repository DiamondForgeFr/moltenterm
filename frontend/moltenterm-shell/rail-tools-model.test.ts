// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { railCustomWidgets, railWidgetTooltip, splitRailWidgets } from "./rail-tools-model";

const w = (label: string, extra: Partial<WidgetConfigType> = {}): WidgetConfigType => ({
    label,
    blockdef: { meta: { view: "term" } },
    ...extra,
});

describe("railCustomWidgets", () => {
    it("keeps only the user's widgets, sorted by display order", () => {
        const list = railCustomWidgets(
            {
                "defwidget@terminal": w("terminal", { "display:order": -5 }),
                b: w("b", { "display:order": 2 }),
                a: w("a", { "display:order": 1 }),
            },
            "ws1"
        );
        expect(list.map((x) => x.label)).toEqual(["a", "b"]);
    });

    it("breaks display-order ties by key", () => {
        const list = railCustomWidgets({ zed: w("z"), alpha: w("a") }, "ws1");
        expect(list.map((x) => x.label)).toEqual(["a", "z"]);
    });

    it("drops hidden widgets and widgets of other workspaces", () => {
        const list = railCustomWidgets(
            {
                hidden: w("hidden", { "display:hidden": true }),
                other: w("other", { workspaces: ["ws2"] }),
                mine: w("mine", { workspaces: ["ws1"] }),
                all: w("all", { workspaces: [] }),
            },
            "ws1"
        );
        expect(list.map((x) => x.label)).toEqual(["all", "mine"]);
    });

    it("handles a missing map", () => {
        expect(railCustomWidgets(null, "ws1")).toEqual([]);
    });
});

describe("splitRailWidgets", () => {
    const list = ["1", "2", "3", "4", "5", "6"].map((l) => w(l));

    it("shows everything up to the limit plus one", () => {
        expect(splitRailWidgets(list.slice(0, 5), 4)).toEqual({ shown: list.slice(0, 5), overflow: [] });
    });

    it("moves the rest to the overflow beyond that", () => {
        const split = splitRailWidgets(list, 4);
        expect(split.shown.map((x) => x.label)).toEqual(["1", "2", "3", "4"]);
        expect(split.overflow.map((x) => x.label)).toEqual(["5", "6"]);
    });
});

describe("railWidgetTooltip", () => {
    it("prefers the description, then the label", () => {
        expect(railWidgetTooltip(w("lbl", { description: "desc" }))).toBe("desc");
        expect(railWidgetTooltip(w("lbl"))).toBe("lbl");
        expect(railWidgetTooltip(w(""))).toBe("Widget");
    });
});
