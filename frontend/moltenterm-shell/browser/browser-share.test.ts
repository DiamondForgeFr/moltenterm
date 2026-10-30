// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { AgentIntegrationRun } from "../agent-integration-runs";
import type { AgentStateInfo } from "../agent-state-model";
import { AgentTab, controlBarView } from "./browser-agent";
import {
    browserLink,
    moveQuestion,
    noAgentReason,
    ofTab,
    ShareActions,
    ShareAgent,
    shareAgents,
    shareMenuItems,
    shareStateText,
    tellReason,
    unconnectedReason,
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

    it("offers one Share with… submenu, each agent followed by its and tell entry (AC1, #947)", () => {
        const { calls, actions } = recorder();
        const menu = shareMenuItems(tab, null, agents(), "", actions);
        expect(menu.map((i) => i.label)).toEqual(["Not shared with an agent", "Share with…"]);
        expect(menu[0].enabled).toBe(false);
        const share = menu[1].submenu;
        expect(share.map((i) => (i.type === "separator" ? "---" : i.label))).toEqual([
            "Claude Code — moltenterm",
            "Share and tell Claude Code",
            "---",
            "Codex — api",
            "---",
            "my-client — scratch",
            "Share and tell my-client",
        ]);
        expect(share[3]).toMatchObject({ enabled: false });
        share[0].click();
        share[1].click();
        expect(calls).toEqual(["share term-a", "tell term-a"]);
    });

    it("disables the control when no agent runs, and on a handed-off tab (AC2, AC8)", () => {
        const { actions } = recorder();
        expect(shareMenuItems(tab, null, [], "", actions)).toEqual([
            { label: "Not shared with an agent", icon: undefined, enabled: false },
            { label: "Share with…", icon: "share-nodes", enabled: false, sublabel: noAgentReason() },
        ]);
        const handed = shareMenuItems({ ...tab, engine: "chrome" }, null, agents(), "Chrome", actions);
        expect(handed).toHaveLength(2);
        expect(handed[1]).toMatchObject({
            enabled: false,
            sublabel: "This page is open in Chrome: open it in MoltenTerm to share it",
        });
    });

    it("offers Share and tell only while the agent waits for the user's message (AC6)", () => {
        const { calls, actions } = recorder();
        const working = shareAgents(
            [state("term-a", "claude", "Claude Code", "working")],
            [{ sessionid: "s-a", blockid: "term-a", agentname: "Claude Code" }],
            paneTitle
        );
        const entries = shareMenuItems(tab, null, working, "", actions)[1].submenu;
        expect(entries[0].enabled).not.toBe(false);
        expect(entries[1]).toMatchObject({ enabled: false, sublabel: "Claude Code is working" });
        const idle = shareMenuItems(tab, null, agents(), "", actions)[1].submenu;
        idle[1].click();
        expect(calls).toEqual(["tell term-a"]);
        const base: ShareAgent = { blockId: "b", agentName: "Claude Code", paneTitle: "", sessionId: "s" };
        expect(tellReason({ ...base, state: "working" })).toBe("Claude Code is working");
        expect(tellReason({ ...base, state: "waiting" })).toBe("Claude Code is waiting for your answer");
        expect(tellReason({ ...base, state: "done" })).toBe("");
        expect(tellReason({ ...base, state: "idle" })).toBe("");
    });

    it("offers Share and tell to an agent whose sub-agents work while its prompt is idle (#1092)", () => {
        const background = shareAgents(
            [{ ...state("term-a", "claude", "Claude Code", "working"), background: true, subagents: 2 }],
            [{ sessionid: "s-a", blockid: "term-a", agentname: "Claude Code" }],
            paneTitle
        );
        expect(tellReason(background[0])).toBe("");
    });

    it("puts Stop sharing first on a shared tab and names the agent holding it (AC4, AC5)", () => {
        const { calls, actions } = recorder();
        const holder: AgentTab = { browsertabid: "t1", agentname: "Claude Code", origin: "shared", state: "active" };
        const menu = shareMenuItems(tab, holder, agents(), "", actions);
        expect(menu.map((i) => i.label)).toEqual([
            "Shared with Claude Code",
            "Stop sharing with Claude Code",
            "Share with…",
        ]);
        menu[1].click();
        expect(calls).toEqual(["stop"]);
        expect(moveQuestion("Claude Code", "Codex").title).toBe("Move this tab to Codex?");
        const opened: AgentTab = { ...holder, origin: "opened" };
        expect(shareMenuItems(tab, opened, agents(), "", actions).map((i) => i.label)).toEqual([
            "Opened by Claude Code",
            "Share with…",
        ]);
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
            [{ label: "Share with…" }]
        );
        expect(menu.map((i) => (i.type === "separator" ? "---" : i.label))).toEqual([
            "Reload",
            "Duplicate",
            "Copy link",
            "---",
            "Share with…",
        ]);
    });
});

describe("share with agent: why an agent is greyed (#947)", () => {
    const states = [state("term-a", "claude", "Claude Code", "idle"), state("term-b", "codex", "Codex", "idle")];
    const named = (blockid: string, agent: string, firstname: string): AgentStateInfo => ({
        ...state(blockid, agent, agent === "claude" ? "Claude Code" : "Codex", "idle"),
        firstname,
    });
    const run = (blockid: string, agent: string, browser: AgentIntegrationRun["browser"]): AgentIntegrationRun => ({
        blockid,
        agent,
        integration: browser === "none" ? "off" : "on",
        browser,
    });
    const reasons = (list: ShareAgent[]) => list.map(unconnectedReason);

    it("says a lost connection with the reconnect steps, not set up", () => {
        const list = shareAgents(
            [named("term-a", "claude", "Valentin"), named("term-b", "codex", "Inès")],
            [],
            paneTitle,
            {
                runs: [run("term-a", "claude", "added"), run("term-b", "codex", "added")],
                settings: {},
            }
        );
        expect(reasons(list)).toEqual([
            "Inès lost its connection to MoltenTerm's browser: restart its session",
            "Valentin lost its connection to MoltenTerm's browser: in its session, run /mcp and reconnect molten-browser, or restart it",
        ]);
    });

    it("says a session started without the browser, with the launcher's reason when it left it out", () => {
        const list = shareAgents(states, [], paneTitle, {
            runs: [
                run("term-a", "claude", "none"),
                { ...run("term-b", "codex", "skipped"), browserreason: "already yours, in ~/.codex/config.toml" },
            ],
        });
        expect(reasons(list)).toEqual([
            "Claude Code started without MoltenTerm's browser: restart its session to give it the browser",
            "Codex started without MoltenTerm's browser: already yours, in ~/.codex/config.toml",
        ]);
        expect(reasons(shareAgents(states.slice(0, 1), [], paneTitle))).toEqual([
            "Claude Code is not connected to MoltenTerm's browser: restart its session to connect it",
        ]);
    });

    it("points to the setting row when the integration is off now, with the settings entry", () => {
        const { calls, actions } = recorder();
        const runs = [run("term-a", "claude", "added"), run("term-b", "codex", "added")];
        const agentOff = shareAgents(states, [], paneTitle, { runs, settings: { "agent:integrateoff": ["codex"] } });
        expect(reasons(agentOff)[1]).toBe(
            "Codex is unticked in Settings › Agents › Agent hookup › Agents with the hookup: tick it, then restart Codex"
        );
        const allOff = shareAgents(states, [], paneTitle, { runs, settings: { "agent:integrate": false } });
        expect(reasons(allOff)[0]).toBe(
            "Agent hookup is off: turn it on in Settings › Agents › Agent hookup, then restart Claude Code"
        );
        const entries = shareMenuItems(tab, null, agentOff, "", actions)[1].submenu;
        const settings = entries[entries.length - 1];
        expect(settings.label).toBe("Agent hookup settings…");
        settings.click();
        expect(calls).toEqual(["settings"]);
        const lost = shareMenuItems(tab, null, shareAgents(states, [], paneTitle, { runs }), "", actions)[1].submenu;
        expect(lost.some((i) => i.label === "Agent hookup settings…")).toBe(false);
    });

    it("maps a run and the settings to the reason", () => {
        expect(browserLink("claude", run("b", "claude", "added"), { "agent:integrateoff": ["claude"] })).toBe(
            "offagent"
        );
        expect(browserLink("claude", run("b", "claude", "added"), {})).toBe("lost");
        expect(browserLink("claude", null, {})).toBe("unknown");
        expect(shareStateText(null)).toBe("Not shared with an agent");
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
        expect(shareMenuItems(tab, null, list, "", actions)[1]).toEqual({
            label: "Share with…",
            icon: "share-nodes",
            enabled: false,
            sublabel: noAgentReason(),
        });
        expect(noAgentReason()).toBe("No agent is running in this view");
    });

    it("keeps nothing without the tab's panes or entries without a pane", () => {
        expect(ofTab(states, null)).toEqual([]);
        expect(ofTab(null, ["term-a"])).toEqual([]);
        expect(ofTab([{ sessionid: "s-z", blockid: "", agentname: "x" }], ["term-a"])).toEqual([]);
    });
});
