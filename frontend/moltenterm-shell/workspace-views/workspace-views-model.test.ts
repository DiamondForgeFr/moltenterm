// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import builtinDefaults from "../../../pkg/wconfig/defaultconfig/settings.json";
import { translate } from "../i18n/i18n-core";
import { tabShownName } from "../project/project-model";
import {
    addPanel,
    addView,
    movePanel,
    moveView,
    NewWorkspaceViewsKey,
    nextPanelKind,
    readTemplate,
    removePanel,
    removeView,
    renameView,
    replacePanel,
    templateViewName,
    ViewNameKeyMetaKey,
    viewShownName,
    WorkspaceViewPanels,
} from "./workspace-views-model";

const fr = (key: string) => translate("fr", key);
const en = (key: string) => translate("en", key);

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
});

describe("the template", () => {
    it("defaults to Scoping and Integration", () => {
        const views = readTemplate((builtinDefaults as Record<string, unknown>)[NewWorkspaceViewsKey]);
        expect(views).toEqual([
            { namekey: "workspaceViews.names.scoping", panels: ["agent", "browser", "files"] },
            { namekey: "workspaceViews.names.integration", panels: ["project", "integration"] },
        ]);
        expect(views.map((v) => templateViewName(v, fr))).toEqual(["Cadrage", "Intégration"]);
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
