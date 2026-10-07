// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    agentSiteDecision,
    AgentTab,
    applyAnswer,
    BrowserAgentModel,
    controlBarView,
    PanelAgentState,
    permissionBarView,
    readPanelAgentState,
    viewportText,
} from "./browser-agent";

const Mocks = vi.hoisted(() => ({ subscribe: vi.fn(), call: vi.fn() }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: Mocks.subscribe }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: Mocks.call } }));

const asking = (over: Partial<AgentTab> = {}): AgentTab => ({
    browsertabid: "agent-1",
    agentname: "Claude Code",
    origin: "opened",
    state: "active",
    permission: { requestid: "req-1", site: "example.com" },
    ...over,
});

describe("site permission bar (DS-BRW-013)", () => {
    it("asks for the site with Allow once first and Always as the primary", () => {
        const view = permissionBarView(asking());
        expect(view.title).toBe("Let Claude Code use example.com?");
        expect(view.detail).toContain("sign-ins");
        expect(view.buttons.map((b) => b.label)).toEqual(["Allow once", "Always for this site", "Block"]);
        expect(view.buttons.map((b) => b.decision)).toEqual(["once", "always", "block"]);
        expect(view.buttons.filter((b) => b.primary).map((b) => b.decision)).toEqual(["always"]);
        expect(view.requestId).toBe("req-1");
    });

    it("shows nothing without a request, or once the user took over", () => {
        expect(permissionBarView(asking({ permission: undefined }))).toBe(null);
        expect(permissionBarView(asking({ state: "takenover" }))).toBe(null);
        expect(permissionBarView(asking({ permission: { requestid: "r", site: "" } }))).toBe(null);
        expect(permissionBarView(null)).toBe(null);
    });

    it("keeps the request when the panel reads wavesrv's state", () => {
        const tabs = readPanelAgentState({ blockid: "p", tabs: [asking()] });
        expect(tabs["agent-1"].permission).toEqual({ requestid: "req-1", site: "example.com" });
        expect(controlBarView(tabs["agent-1"])).not.toBe(null);
    });

    it("drops the answered request at once, and only that one", () => {
        const tabs = { "agent-1": asking() };
        expect(applyAnswer(tabs, "agent-1", "req-1")["agent-1"].permission).toBeUndefined();
        expect(applyAnswer(tabs, "agent-1", "req-2")).toBe(tabs);
        expect(applyAnswer(tabs, "other", "req-1")).toBe(tabs);
    });
});

describe("agent site decisions (browser:agentsites)", () => {
    const sites = {
        "example.com": "allow",
        "evil.example.com": "block",
        "localhost:3000": "allow",
        " Shop.ORG ": "BLOCK",
    };

    it("finds the entry that applies, Block winning", () => {
        expect(agentSiteDecision(sites, "https://example.com/a")).toEqual({ site: "example.com", decision: "allow" });
        expect(agentSiteDecision(sites, "https://docs.example.com/")).toEqual({
            site: "example.com",
            decision: "allow",
        });
        expect(agentSiteDecision(sites, "https://x.evil.example.com/")).toEqual({
            site: "evil.example.com",
            decision: "block",
        });
        expect(agentSiteDecision(sites, "http://localhost:3000/")).toEqual({
            site: "localhost:3000",
            decision: "allow",
        });
        expect(agentSiteDecision(sites, "https://shop.org/")).toEqual({ site: "shop.org", decision: "block" });
        expect(
            agentSiteDecision({ "example.com": "block", "app.example.com": "allow" }, "https://app.example.com/")
        ).toEqual({
            site: "example.com",
            decision: "block",
        });
    });

    it("never applies a top-level domain or splits an IP address", () => {
        expect(agentSiteDecision({ com: "block", "co.uk": "block" }, "https://example.com/")).toBe(null);
        expect(agentSiteDecision({ "0.0.1": "block", "1": "block" }, "http://127.0.0.1/")).toBe(null);
        expect(agentSiteDecision({ "127.0.0.1": "allow" }, "http://127.0.0.1:3000/")).toEqual({
            site: "127.0.0.1",
            decision: "allow",
        });
    });

    it("has nothing for other sites and other pages", () => {
        expect(agentSiteDecision(sites, "http://localhost:8080/")).toBe(null);
        expect(agentSiteDecision(sites, "https://example.com.attacker.io/")).toBe(null);
        expect(agentSiteDecision(sites, "about:blank")).toBe(null);
        expect(agentSiteDecision(sites, "not a url")).toBe(null);
        expect(agentSiteDecision(null, "https://example.com/")).toBe(null);
    });
});

describe("answering from the panel", () => {
    let model: BrowserAgentModel;

    beforeEach(async () => {
        const state: PanelAgentState = { blockid: "panel", tabs: [asking()] };
        Mocks.call.mockReset().mockResolvedValue(state);
        Mocks.subscribe.mockImplementation(() => () => {});
        model = new BrowserAgentModel("panel");
        model.start();
        await vi.waitFor(() => expect(model.tabs()["agent-1"]?.permission).toBeDefined());
        Mocks.call.mockReset();
    });

    afterEach(() => model.dispose());

    it("sends the decision for the request and hides the bar at once", async () => {
        Mocks.call.mockResolvedValue(null);
        model.answer("agent-1", "req-1", "always");
        expect(permissionBarView(model.tabs()["agent-1"])).toBe(null);
        await vi.waitFor(() => expect(Mocks.call).toHaveBeenCalled());
        expect(Mocks.call.mock.calls[0][0]).toBe("moltenbrowseragentanswer");
        expect(Mocks.call.mock.calls[0][1]).toEqual({
            blockid: "panel",
            browsertabid: "agent-1",
            requestid: "req-1",
            decision: "always",
        });
        expect(Mocks.call.mock.calls[0][2].route).toBe("molten:browseragent");
    });

    it("shows wavesrv's state again when the answer fails", async () => {
        Mocks.call.mockRejectedValueOnce(new Error("down")).mockResolvedValue({ blockid: "panel", tabs: [asking()] });
        model.answer("agent-1", "req-1", "block");
        await vi.waitFor(() => expect(model.tabs()["agent-1"]?.permission?.requestid).toBe("req-1"));
    });
});

describe("sensitive action bar (DS-BRW-016)", () => {
    const confirming = (over: Partial<AgentTab> = {}): AgentTab =>
        asking({
            permission: {
                requestid: "req-9",
                site: "shop.example",
                kind: "action",
                action: "type into a password or payment field",
            },
            ...over,
        });

    it("asks Allow or Deny for this one action, Deny first and Allow the primary", () => {
        const view = permissionBarView(confirming());
        expect(view.title).toBe("Claude Code wants to type into a password or payment field on shop.example");
        expect(view.detail).toBe("Allow this once, or deny it.");
        expect(view.buttons.map((b) => b.label)).toEqual(["Deny", "Allow"]);
        expect(view.buttons.map((b) => b.decision)).toEqual(["deny", "allow"]);
        expect(view.buttons.filter((b) => b.primary).map((b) => b.decision)).toEqual(["allow"]);
        expect(view.escape).toBe("deny");
        expect(permissionBarView(asking()).escape).toBe("dismiss");
    });

    it("words a download without a host, and shows nothing for an empty request", () => {
        const download = permissionBarView(
            confirming({ permission: { requestid: "r", site: "", kind: "action", action: "start a download" } })
        );
        expect(download.title).toBe("Claude Code wants to start a download");
        expect(permissionBarView(confirming({ permission: { requestid: "r", site: "x", kind: "action" } }))).toBe(null);
        expect(permissionBarView(confirming({ state: "takenover" }))).toBe(null);
    });

    it("hides the control bar while it asks", () => {
        const tabs = readPanelAgentState({ blockid: "p", tabs: [confirming()] });
        expect(permissionBarView(tabs["agent-1"])).not.toBe(null);
    });
});

describe("emulated viewport on the control bar (FR-BRW-010 AC3)", () => {
    it("shows the size while the agent emulates one", () => {
        expect(controlBarView(asking({ permission: undefined, viewport: { width: 390, height: 844 } })).viewport).toBe(
            "390 × 844"
        );
        expect(
            controlBarView(asking({ permission: undefined, state: "takenover", viewport: { width: 390, height: 844 } }))
                .viewport
        ).toBe("390 × 844");
        expect(controlBarView(asking({ permission: undefined })).viewport).toBe("");
        expect(viewportText({ width: 0, height: 10 })).toBe("");
        expect(viewportText({ width: 1.5, height: 10 } as any)).toBe("");
        expect(viewportText(null)).toBe("");
    });
});
