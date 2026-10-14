// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentStateInfo } from "../agent-state-model";
import { AgentTab, controlBarView } from "./browser-agent";
import {
    moveQuestion,
    NoAgentReason,
    ofTab,
    ShareActions,
    ShareAgent,
    shareAgents,
    shareMenuItems,
    tellReason,
} from "./browser-share";
import { browserTabMenu } from "./browser-tab-menu";

const titles: Record<string, string> = { "term-a": "moltenterm", "term-b": "api", "term-x": "scratch" };
const paneTitle = (id: string) => titles[id] ?? "";

function state(blockid: string, agent: string, agentname: string, s: AgentStateInfo["state"]): AgentStateInfo {
    return { blockid, agent, agentname, state: s, version: 1, workspaceid: "ws1" };
}

function recorder() {
    const calls: string[] = [];
    const actions: ShareActions = {
        share: (agent, tell) => calls.push(`${tell ? "tell" : "share"} ${agent.blockId}`),
        stopSharing: () => calls.push("stop"),
        openAgentSettings: () => calls.push("settings"),
    };
    return { calls, actions };
}

const tab = { id: "t1", url: "https://example.com/a?b=c", title: "Example" };

function agents(): ShareAgent[] {
    return shareAgents(
        [state("term-a", "claude", "Claude Code", "idle"), state("term-b", "codex", "Codex", "working")],
        [
            { sessionid: "s-a", blockid: "term-a", agentname: "Claude Code" },
            { sessionid: "s-x", blockid: "term-x", agentname: "my-client" },
        ],
        paneTitle
    );
}

describe("share with agent (FR-BRW-011)", () => {
    it("lists one entry per agent of the workspace, named by agent and pane, joined with the connected sessions", () => {
        const list = agents();
        expect(list.map((a) => [a.agentName, a.paneTitle, a.sessionId ?? ""])).toEqual([
            ["Claude Code", "moltenterm", "s-a"],
            ["Codex", "api", ""],
            ["my-client", "scratch", "s-x"],
        ]);
    });

    it("offers Share with agent and Share and tell, an unconnected agent disabled with the setup reason (AC1, AC2)", () => {
        const { calls, actions } = recorder();
        const menu = shareMenuItems(tab, null, agents(), "", actions);
        expect(menu.map((i) => i.label)).toEqual(["Share with agent", "Share and tell"]);
        const share = menu[0].submenu;
        expect(share.map((i) => i.label)).toEqual([
            "Claude Code — moltenterm",
            "Codex — api",
            "my-client — scratch",
            undefined,
            "Agent integration settings…",
        ]);
        expect(share[1]).toMatchObject({ enabled: false, sublabel: "Set up the MoltenTerm browser for Codex" });
        share[0].click();
        share[4].click();
        expect(calls).toEqual(["share term-a", "settings"]);
    });

    it("disables the control when no agent runs, and on a handed-off tab (AC2, AC8)", () => {
        const { actions } = recorder();
        expect(shareMenuItems(tab, null, [], "", actions)).toEqual([
            { label: "Share with agent", icon: "share-nodes", enabled: false, sublabel: NoAgentReason },
        ]);
        const handed = shareMenuItems({ ...tab, engine: "chrome" }, null, agents(), "Chrome", actions);
        expect(handed).toHaveLength(1);
        expect(handed[0]).toMatchObject({
            enabled: false,
            sublabel: "This page is open in Chrome: open it in MoltenTerm to share it",
        });
    });

    it("offers Share and tell only while the agent waits for the user's message (AC6)", () => {
        const { calls, actions } = recorder();
        const tell = shareMenuItems(tab, null, agents(), "", actions)[1].submenu;
        expect(tell[0].enabled).not.toBe(false);
        expect(tell[1]).toMatchObject({ enabled: false });
        tell[0].click();
        expect(calls).toEqual(["tell term-a"]);
        const base: ShareAgent = { blockId: "b", agentName: "Claude Code", paneTitle: "", sessionId: "s" };
        expect(tellReason({ ...base, state: "working" })).toBe("Claude Code is working");
        expect(tellReason({ ...base, state: "waiting" })).toBe("Claude Code is waiting for your answer");
        expect(tellReason({ ...base, state: "done" })).toBe("");
        expect(tellReason({ ...base, state: "idle" })).toBe("");
    });

    it("puts Stop sharing first on a shared tab and names the agent holding it (AC4, AC5)", () => {
        const { calls, actions } = recorder();
        const holder: AgentTab = { browsertabid: "t1", agentname: "Claude Code", origin: "shared", state: "active" };
        const menu = shareMenuItems(tab, holder, agents(), "", actions);
        expect(menu[0].label).toBe("Stop sharing with Claude Code");
        expect(menu[1].label).toBe("Share with agent (now Claude Code)");
        menu[0].click();
        expect(calls).toEqual(["stop"]);
        expect(moveQuestion("Claude Code", "Codex").title).toBe("Move this tab to Codex?");
        const opened: AgentTab = { ...holder, origin: "opened" };
        expect(shareMenuItems(tab, opened, agents(), "", actions)[0].label).toBe("Share with agent (now Claude Code)");
    });

    it("shows the control bar on a shared tab only once the agent acts", () => {
        const shared: AgentTab = { browsertabid: "t1", agentname: "Claude Code", origin: "shared", state: "active" };
        expect(controlBarView(shared)).toBeNull();
        expect(controlBarView({ ...shared, engaged: true, action: "Working in the tab you shared" })?.title).toBe(
            "Claude Code is controlling this tab"
        );
    });

    it("adds the share entries to the tab menu after its own actions", () => {
        const menu = browserTabMenu(
            { tabs: [tab], activeId: "t1" },
            tab,
            {
                reloadTab: () => {},
                duplicateTab: () => {},
                copyTabLink: () => {},
                closeTab: () => {},
                closeOtherTabs: () => {},
            },
            [{ label: "Share with agent" }]
        );
        expect(menu.map((i) => (i.type === "separator" ? "---" : i.label))).toEqual([
            "Reload",
            "Duplicate",
            "Copy link",
            "---",
            "Share with agent",
        ]);
    });
});

describe("share with agent: the panel's tab only (#594)", () => {
    const states = [
        state("term-a", "claude", "Claude Code", "idle"),
        { ...state("term-o", "claude", "Claude Code", "idle"), tabid: "tab-2" },
    ];
    const sessions = [
        { sessionid: "s-a", blockid: "term-a", agentname: "Claude Code" },
        { sessionid: "s-o", blockid: "term-o", agentname: "Claude Code" },
    ];

    it("keeps only the agent states and the sessions of the panes in the panel's tab", () => {
        const tabBlocks = ["web-1", "term-a", "term-b"];
        expect(ofTab(states, tabBlocks).map((s) => s.blockid)).toEqual(["term-a"]);
        expect(ofTab(sessions, tabBlocks).map((s) => s.sessionid)).toEqual(["s-a"]);
        const list = shareAgents(ofTab(states, tabBlocks), ofTab(sessions, tabBlocks), paneTitle);
        expect(list.map((a) => [a.blockId, a.sessionId])).toEqual([["term-a", "s-a"]]);
    });

    it("lists each tab's own agent from each panel (AC1)", () => {
        expect(ofTab(sessions, ["web-2", "term-o"]).map((s) => s.sessionid)).toEqual(["s-o"]);
    });

    it("leaves the entry disabled with the tab's no-agent reason when only another tab has agents", () => {
        const { actions } = recorder();
        const list = shareAgents(ofTab(states, ["web-1"]), ofTab(sessions, ["web-1"]), paneTitle);
        expect(list).toEqual([]);
        expect(shareMenuItems(tab, null, list, "", actions)).toEqual([
            { label: "Share with agent", icon: "share-nodes", enabled: false, sublabel: NoAgentReason },
        ]);
        expect(NoAgentReason).toBe("No agent is running in this tab");
    });

    it("keeps nothing without the tab's panes or entries without a pane", () => {
        expect(ofTab(states, null)).toEqual([]);
        expect(ofTab(null, ["term-a"])).toEqual([]);
        expect(ofTab([{ sessionid: "s-z", blockid: "", agentname: "x" }], ["term-a"])).toEqual([]);
    });
});
