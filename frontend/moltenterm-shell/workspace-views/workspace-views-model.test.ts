// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import builtinDefaults from "../../../pkg/wconfig/defaultconfig/settings.json";
import { translate } from "../i18n/i18n-core";
import { tabShownName } from "../project/project-model";
import {
    addPanel,
    addPanelKind,
    addView,
    movePanel,
    moveView,
    NewWorkspaceViewsKey,
    nextPanelKind,
    placePanel,
    placeView,
    readTemplate,
    removePanel,
    removeView,
    renameView,
    replacePanel,
    templateViewIcons,
    templateViewName,
    ViewNameKeyMetaKey,
    viewNameText,
    viewShownName,
    WorkspaceViewPanels,
} from "./workspace-views-model";

const fr = (key: string, vars?: Record<string, string | number>) => translate("fr", key, vars);
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

describe("names of a new workspace's views (#1305)", () => {
    it("shows a key-named view in the interface language, a renamed one as typed", () => {
        const meta = { [ViewNameKeyMetaKey]: "workspaceViews.names.scoping" };
        expect(viewShownName("workspaceViews.names.scoping", meta, fr)).toBe("Cadrage");
        expect(viewShownName("workspaceViews.names.scoping", meta, en)).toBe("Scoping");
        expect(viewShownName("My scoping", meta, fr)).toBe("My scoping");
        expect(viewShownName("workspaceViews.names.scoping", {}, fr)).toBe("workspaceViews.names.scoping");
    });

    it("reaches the tab names the windows show", () => {
        const tab = {
            name: "workspaceViews.names.integration",
            meta: { [ViewNameKeyMetaKey]: "workspaceViews.names.integration" },
        } as unknown as Tab;
        expect(tabShownName(tab, fr)).toBe("Intégration");
        expect(tabShownName(tab, en)).toBe("Integration");
    });

    it("words a name sent without its tab's meta, never shows the key (#1311)", () => {
        expect(viewNameText("workspaceViews.names.scoping", fr)).toBe("Cadrage");
        expect(viewNameText("workspaceViews.names.integration", en)).toBe("Integration");
        expect(viewNameText("workspaceViews.names.later", fr)).toBe("Vue");
        expect(viewNameText("workspaceViews.names.later", en)).toBe("View");
        expect(viewNameText("My scoping", fr)).toBe("My scoping");
        expect(viewNameText("T2", fr)).toBe("T2");
        expect(viewNameText("", fr)).toBe("");
        expect(viewNameText(undefined, fr)).toBe("");
    });

    it("words a Review view's name in the interface language, in every surface (#1322)", () => {
        expect(viewShownName("Review #17", {}, fr)).toBe("Revue #17");
        expect(viewShownName("Review #17", {}, en)).toBe("Review #17");
        expect(viewNameText("Review #17", fr)).toBe("Revue #17");
        expect(viewNameText("Review #17", en)).toBe("Review #17");
        const tab = { name: "Review #1190", meta: {} } as unknown as Tab;
        expect(tabShownName(tab, fr)).toBe("Revue #1190");
        expect(viewShownName("Review #17 notes", {}, fr)).toBe("Review #17 notes");
        expect(viewShownName("Ma revue", {}, fr)).toBe("Ma revue");
    });
});

describe("the template", () => {
    it("defaults to Scoping and Control room (#1315)", () => {
        const views = readTemplate((builtinDefaults as Record<string, unknown>)[NewWorkspaceViewsKey]);
        expect(views).toEqual([
            { namekey: "workspaceViews.names.scoping", panels: ["agent", "browser", "files"] },
            { namekey: "workspaceViews.names.pilotage", panels: ["project", "integration"] },
        ]);
        expect(views.map((v) => templateViewName(v, fr))).toEqual(["Cadrage", "Pilotage"]);
        expect(views.map((v) => templateViewName(v, en))).toEqual(["Scoping", "Control room"]);
    });

    it("reads a missing value as no view and leaves out unknown panels and empty views", () => {
        expect(readTemplate(undefined)).toEqual([]);
        expect(readTemplate([{ name: " A ", panels: ["nope", "files"] }, { panels: ["nope"] }, null, "x"])).toEqual([
            { name: "A", panels: ["files"] },
        ]);
        expect(templateViewName({ panels: ["files"] }, en)).toBe("View");
    });

    it("adds, renames, moves and removes views", () => {
        let views = readTemplate([{ namekey: "workspaceViews.names.scoping", panels: ["agent"] }]);
        views = addView(views, "");
        expect(views[1]).toEqual({ panels: ["terminal"] });
        views = renameView(views, 0, "  Spec ");
        expect(views[0]).toEqual({ name: "Spec", panels: ["agent"] });
        expect(renameView(views, 0, "   ")).toBe(views);
        views = moveView(views, 1, -1);
        expect(views.map((v) => v.name ?? "")).toEqual(["", "Spec"]);
        expect(moveView(views, 0, -1)).toBe(views);
        expect(removeView(views, 0)).toEqual([{ name: "Spec", panels: ["agent"] }]);
    });

    it("adds, changes, orders and removes panels, keeping at least one", () => {
        let views = readTemplate([{ name: "A", panels: ["agent"] }]);
        expect(nextPanelKind(views[0])).toBe("terminal");
        views = addPanel(views, 0);
        views = replacePanel(views, 0, 1, "browser");
        expect(views[0].panels).toEqual(["agent", "browser"]);
        expect(replacePanel(views, 0, 1, "nope")).toBe(views);
        views = movePanel(views, 0, 1, -1);
        expect(views[0].panels).toEqual(["browser", "agent"]);
        views = removePanel(views, 0, 0);
        expect(views[0].panels).toEqual(["agent"]);
        expect(removePanel(views, 0, 0)[0].panels).toEqual(["agent"]);
        const full = { name: "F", panels: WorkspaceViewPanels.map((p) => p.kind) };
        expect(nextPanelKind(full)).toBe("terminal");
    });

    it("names every panel kind in both languages", () => {
        for (const p of WorkspaceViewPanels) {
            expect(fr(p.labelKey)).not.toBe(p.labelKey);
            expect(en(p.labelKey)).not.toBe(p.labelKey);
        }
    });
});

describe("the template as tiles (FR-SHELL-106)", () => {
    const views = [
        { namekey: "workspaceViews.names.scoping", panels: ["agent", "browser"] },
        { namekey: "workspaceViews.names.integration", panels: ["integration", "project", "cicd", "linemap"] },
        { name: "Docs", panels: ["files"] },
    ];
    const names = (list: { name?: string; namekey?: string }[]) => list.map((v) => v.name ?? v.namekey);

    it("drops a dragged tile at the place of the one it lands on", () => {
        expect(names(placeView(views, 0, 2))).toEqual([
            "workspaceViews.names.integration",
            "Docs",
            "workspaceViews.names.scoping",
        ]);
        expect(names(placeView(views, 2, 0))).toEqual([
            "Docs",
            "workspaceViews.names.scoping",
            "workspaceViews.names.integration",
        ]);
        expect(placeView(views, 1, 1)).toBe(views);
        expect(placeView(views, 0, 5)).toBe(views);
    });

    it("drops a dragged panel inside its view", () => {
        expect(placePanel(views, 1, 3, 0)[1].panels).toEqual(["linemap", "integration", "project", "cicd"]);
        expect(placePanel(views, 1, 3, 0)[0]).toBe(views[0]);
    });

    it("draws a tile with its panels' icons, three at most, as the sidebar does", () => {
        expect(templateViewIcons(views[0])).toEqual(["robot", "globe"]);
        expect(templateViewIcons(views[1])).toHaveLength(3);
    });

    it("adds the panel kind chosen, and only a known one", () => {
        expect(addPanelKind(views, 2, "terminal")[2].panels).toEqual(["files", "terminal"]);
        expect(addPanelKind(views, 2, "nope")).toBe(views);
    });
});
