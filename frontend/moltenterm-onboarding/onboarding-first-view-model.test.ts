// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The first view's rules (FR-ONB-009, TC-ONB-012) and the project folder's (FR-ONB-007 P-4, TC-ONB-015).

import { describe, expect, it } from "vitest";
import { ViewSuggestions } from "../moltenterm-shell/workspace-views/view-suggestions";
import {
    cleanFolderName,
    defaultAgentId,
    defaultProjectsFolder,
    firstViewPlan,
    matchingSuggestion,
    MaxTools,
    presetTools,
    projectTarget,
    readyAgents,
    shownPath,
    suggestedNameKey,
    toggleTool,
    viewPanels,
} from "./onboarding-first-view-model";

const agent = (id: string, found: boolean) => ({ id, name: id, found, executable: found ? id : "" }) as any;

describe("the tools of the first view", () => {
    it("keeps at most three, the oldest going first", () => {
        let tools: string[] = [];
        for (const kind of ["browser", "files", "integration", "project"]) {
            tools = toggleTool(tools, kind);
        }
        expect(tools).toHaveLength(MaxTools);
        expect(tools).toEqual(["files", "integration", "project"]);
        expect(toggleTool(tools, "files")).toEqual(["integration", "project"]);
        expect(toggleTool(tools, "terminal")).toBe(tools);
    });

    it("offers the launcher's suggestions as presets, in its order, the agent always on the left", () => {
        expect(ViewSuggestions.map((s) => s.id)).toEqual(["scoping", "pilotage", "preview", "code", "delivery"]);
        expect(presetTools("scoping")).toEqual(["browser", "files"]);
        expect(presetTools("pilotage")).toEqual(["project", "integration"]);
        expect(viewPanels(presetTools("delivery"))).toEqual(["agent", "integration"]);
    });

    it("names the view after its suggestion, else My view, else Agent", () => {
        expect(matchingSuggestion(["files", "browser"])).toBe("scoping");
        expect(suggestedNameKey(["files", "browser"])).toBe("workspaceViews.names.scoping");
        expect(suggestedNameKey(["files"])).toBe("workspaceViews.names.code");
        expect(suggestedNameKey(["browser", "integration"])).toBe("workspaceViews.names.myView");
        expect(suggestedNameKey([])).toBe("workspaceViews.names.agentOnly");
    });

    it("plans the view with a typed name, or the suggestion's key", () => {
        const base = { tools: ["browser", "files"], agentId: "codex", place: "everywhere" as const };
        expect(firstViewPlan({ ...base, typedName: "", named: false })).toEqual({
            panels: ["agent", "browser", "files"],
            agentId: "codex",
            name: "",
            nameKey: "workspaceViews.names.scoping",
            place: "everywhere",
        });
        const typed = firstViewPlan({ ...base, typedName: " Atlas ", named: true, place: "workspace" as any });
        expect(typed).toMatchObject({ name: "Atlas", nameKey: null, place: "workspace" });
    });
});

describe("the agent on the left (FR-ONB-009, changed after the feedback)", () => {
    const list = { agents: [agent("kimi", false), agent("claude-code", true), agent("codex", true)], version: "" };

    it("lists only the agents found, never one MoltenTerm picks", () => {
        expect(readyAgents(list).map((a) => a.id)).toEqual(["claude-code", "codex"]);
        expect(readyAgents(null)).toEqual([]);
    });

    it("defaults to the agent installed on the agents scene, else the first found", () => {
        const ready = readyAgents(list);
        expect(defaultAgentId(ready, null, null)).toBe("claude-code");
        expect(defaultAgentId(ready, null, "codex")).toBe("codex");
        expect(defaultAgentId(ready, "claude-code", "codex")).toBe("claude-code");
        expect(defaultAgentId(ready, "kimi", "gone")).toBe("claude-code");
        expect(defaultAgentId([], null, null)).toBeNull();
    });
});

describe("the project folder (FR-ONB-007 P-4)", () => {
    it("proposes Projets in French and Projects otherwise, in the home folder", () => {
        expect(defaultProjectsFolder("/Users/ada", "fr")).toBe("/Users/ada/Projets");
        expect(defaultProjectsFolder("/Users/ada/", "en")).toBe("/Users/ada/Projects");
    });

    it("cleans the typed name and names the folder to create", () => {
        expect(cleanFolderName(" my/app ")).toBe("my-app");
        expect(cleanFolderName("..")).toBe("");
        const draft = { mode: "new" as const, name: "atlas", location: "/Users/ada/Projets", git: true, found: "" };
        expect(projectTarget(draft)).toBe("/Users/ada/Projets/atlas");
        expect(projectTarget({ ...draft, name: " " })).toBe("");
        expect(projectTarget({ ...draft, mode: "find", found: "/src/billing" })).toBe("/src/billing");
    });

    it("writes paths under the home folder with ~", () => {
        expect(shownPath("/Users/ada/Projets/atlas", "/Users/ada")).toBe("~/Projets/atlas");
        expect(shownPath("/Users/adam", "/Users/ada")).toBe("/Users/adam");
        expect(shownPath("/tmp/x", "")).toBe("/tmp/x");
    });
});
