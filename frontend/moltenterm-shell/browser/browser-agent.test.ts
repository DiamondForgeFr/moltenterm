// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    ActionCueMs,
    activeCue,
    agentShowedPage,
    AgentTab,
    applyControl,
    controlBarView,
    readPanelAgentState,
    shownStamps,
} from "./browser-agent";
import {
    addTab,
    BrowserState,
    consumeCloseRequestsMeta,
    isAgentTabId,
    readBrowserState,
    readCloseRequests,
    readOpenRequests,
} from "./browser-model";

const tab = (over: Partial<AgentTab> = {}): AgentTab => ({
    browsertabid: "agent-1",
    agentname: "Claude Code",
    origin: "opened",
    state: "active",
    action: "Opened this tab",
    actionts: 1000,
    ...over,
});

describe("control bar", () => {
    it("names the agent and its last action, with Stop", () => {
        const view = controlBarView(tab());
        expect(view.title).toBe("Claude Code is controlling this tab");
        expect(view.detail).toBe("Opened this tab");
        expect(view.buttons).toEqual([
            { label: "Take over", action: "takeover", primary: false },
            { label: "Stop", action: "stop", primary: false },
        ]);
        expect(view.takenOver).toBe(false);
    });

    it("says the user took over, with Give back to the agent first and Stop still there", () => {
        const view = controlBarView(tab({ state: "takenover" }));
        expect(view.title).toBe("You took over");
        expect(view.detail).toContain("Claude Code");
        expect(view.buttons.map((b) => b.label)).toEqual(["Give back to Claude Code", "Stop"]);
        expect(view.buttons[0].primary).toBe(true);
    });

    // #971: the user's click or key was held back; the bar says how to take over, with Take over first.
    it("says how to take over after the user's input was held back", () => {
        const view = controlBarView(tab(), true);
        expect(view.detail).toBe("Claude Code is using this tab: Take over to use it");
        expect(view.held).toBe(true);
        expect(view.buttons[0]).toEqual({ label: "Take over", action: "takeover", primary: true });
        expect(controlBarView(tab({ state: "takenover" }), true).detail).toContain("give the tab back");
    });

    it("shows nothing for a tab no agent controls", () => {
        expect(controlBarView(null)).toBeNull();
        expect(controlBarView(tab({ state: "stopped" }))).toBeNull();
    });

    it("falls back to a generic name", () => {
        expect(controlBarView(tab({ agentname: "  " })).title).toBe("An agent is controlling this tab");
    });
});

describe("panel agent state", () => {
    it("keeps the controlled tabs of the event only", () => {
        const tabs = readPanelAgentState({
            blockid: "p1",
            tabs: [
                tab(),
                tab({ browsertabid: "agent-2", state: "takenover" }),
                tab({ browsertabid: "x", state: "stopped" }),
            ],
        });
        expect(Object.keys(tabs).sort()).toEqual(["agent-1", "agent-2"]);
        expect(readPanelAgentState(null)).toEqual({});
    });

    it("applies Stop, takeover and Give back at once", () => {
        const tabs = readPanelAgentState({ blockid: "p1", tabs: [tab()] });
        expect(applyControl(tabs, "agent-1", "stop")).toEqual({});
        const taken = applyControl(tabs, "agent-1", "takeover");
        expect(taken["agent-1"].state).toBe("takenover");
        expect(applyControl(taken, "agent-1", "giveback")["agent-1"].state).toBe("active");
        expect(applyControl(tabs, "unknown", "stop")).toBe(tabs);
        expect(applyControl(tabs, "agent-1", "giveback")).toBe(tabs);
    });

    it("draws an action cue only while it is fresh and the agent is active", () => {
        const cued = tab({ cue: { kind: "click", x: 10, y: 20 } });
        expect(activeCue(cued, 1000 + ActionCueMs)).toEqual({ kind: "click", x: 10, y: 20 });
        expect(activeCue(cued, 1001 + ActionCueMs)).toBeNull();
        expect(activeCue({ ...cued, state: "takenover" }, 1000)).toBeNull();
        expect(activeCue(tab(), 1000)).toBeNull();
    });
});

describe("agent tab requests", () => {
    it("reads an agent's tab with the id wavesrv chose", () => {
        const requests = readOpenRequests({
            "molten:browser:open:01": "https://a.example",
            "molten:browser:open:02": { url: "about:blank", tabid: "agent-x", agent: true },
            "molten:browser:open:03": { url: "about:blank", agent: true },
            "molten:browser:open:04": { url: "about:blank", tabid: "y".repeat(300), agent: true },
        });
        expect(requests).toEqual([
            { id: "01", url: "https://a.example" },
            { id: "02", url: "about:blank", tabId: "agent-x", agent: true },
        ]);
    });

    it("adds the agent's tab once, active, with its own id", () => {
        const state: BrowserState = { tabs: [{ id: "u1", url: "https://a.example" }], activeId: "u1" };
        const next = addTab(state, "about:blank", () => "generated", { id: "agent-x" });
        expect(next.tabs.map((t) => t.id)).toEqual(["u1", "agent-x"]);
        expect(next.activeId).toBe("agent-x");
        expect(addTab(next, "about:blank", () => "generated", { id: "agent-x" })).toBe(next);
    });

    it("reads and consumes close requests in order", () => {
        const meta = {
            "molten:browser:close:02": "agent-b",
            "molten:browser:close:01": "agent-a",
            "molten:browser:close:03": 5,
            "molten:browser:open:04": "https://a.example",
        };
        const requests = readCloseRequests(meta);
        expect(requests).toEqual([
            { id: "01", tabId: "agent-a" },
            { id: "02", tabId: "agent-b" },
        ]);
        expect(consumeCloseRequestsMeta(requests)).toEqual({
            "molten:browser:close:01": null,
            "molten:browser:close:02": null,
        });
    });

    it("closes only an agent's tab through the queue", () => {
        expect(isAgentTabId("agent-0f1c")).toBe(true);
        expect(isAgentTabId("muxxpzvh-1")).toBe(false);
        expect(isAgentTabId(null)).toBe(false);
    });

    it("opens a panel created for an agent on the agent's tab", () => {
        const state = readBrowserState(
            {
                url: "about:blank",
                "molten:browser:tabs": [{ id: "agent-x", url: "about:blank" }],
                "molten:browser:active": "agent-x",
            },
            "https://default.example"
        );
        expect(state).toEqual({ tabs: [{ id: "agent-x", url: "about:blank", title: undefined }], activeId: "agent-x" });
    });
});

// #1812: which stamps say the agent put a page in front of the developer.
describe("pages an agent shows", () => {
    const tabs = (...list: AgentTab[]) => readPanelAgentState({ blockid: "panel", tabs: list });

    it("reads each tab's stamp, 0 when it has none", () => {
        expect(shownStamps(tabs(tab({ shownts: 500 }), tab({ browsertabid: "shared-1", origin: "shared" })))).toEqual({
            "agent-1": 500,
            "shared-1": 0,
        });
        expect(shownStamps(null)).toEqual({});
    });

    it("is a later stamp than the one last read", () => {
        expect(agentShowedPage(tabs(tab({ shownts: 501 })), { "agent-1": 500 })).toBe(true);
        expect(agentShowedPage(tabs(tab({ shownts: 500 })), { "agent-1": 500 })).toBe(false);
        expect(agentShowedPage(tabs(tab({ shownts: 400 })), { "agent-1": 500 })).toBe(false);
    });

    it("is a tab with a stamp that was not read before", () => {
        expect(agentShowedPage(tabs(tab({ shownts: 500 })), {})).toBe(true);
        expect(agentShowedPage(tabs(tab({ shownts: 500 })), null)).toBe(true);
    });

    it("is not a tab that was never shown (a shared one) or no tab at all", () => {
        expect(agentShowedPage(tabs(tab({ browsertabid: "shared-1", origin: "shared" })), {})).toBe(false);
        expect(agentShowedPage(tabs(), { "agent-1": 500 })).toBe(false);
        expect(agentShowedPage(null, {})).toBe(false);
    });
});
