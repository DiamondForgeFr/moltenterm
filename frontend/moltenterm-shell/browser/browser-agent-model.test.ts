// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { BrowserAgentModel, PanelAgentState } from "./browser-agent";

const Mocks = vi.hoisted(() => ({ subscribe: vi.fn(), call: vi.fn() }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: Mocks.subscribe }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: Mocks.call } }));

const Active: PanelAgentState = {
    blockid: "panel",
    tabs: [{ browsertabid: "agent-tab", agentname: "Codex", origin: "opened", state: "active" }],
};
const Stopped: PanelAgentState = { blockid: "panel", tabs: [] };

describe("browser agent snapshots", () => {
    let model: BrowserAgentModel;
    let publish: (state: PanelAgentState) => void;

    beforeEach(async () => {
        Mocks.call.mockReset().mockResolvedValue(Active);
        Mocks.subscribe.mockImplementation(({ handler }) => {
            publish = (state) => handler({ data: state });
            return () => {};
        });
        model = new BrowserAgentModel("panel");
        model.start();
        await vi.waitFor(() => expect(model.tabs()["agent-tab"]).toBeDefined());
    });

    afterEach(() => model.dispose());

    it("does not let recovery after a failed control overwrite a newer Stop event", async () => {
        let resolve: (state: PanelAgentState) => void;
        Mocks.call.mockReturnValueOnce(new Promise<PanelAgentState>((done) => (resolve = done)));
        const recovery = model.loadSnapshot(true);
        publish(Stopped);
        resolve(Active);
        await recovery;
        expect(model.tabs()).toEqual({});
    });

    it("recovers from an optimistic Stop when no newer state arrives", async () => {
        publish(Active);
        model.control("agent-tab", "stop");
        expect(model.tabs()).toEqual({});
        await model.loadSnapshot(true);
        expect(model.tabs()["agent-tab"]?.state).toBe("active");
    });

    it("does not overwrite a user action made while a recovery snapshot is in flight", async () => {
        let resolve: (state: PanelAgentState) => void;
        Mocks.call.mockReturnValueOnce(new Promise<PanelAgentState>((done) => (resolve = done)));
        const recovery = model.loadSnapshot(true);
        model.control("agent-tab", "stop");
        resolve(Active);
        await recovery;
        expect(model.tabs()).toEqual({});
    });
});

// #1812: a page the agent shows asks the panel to come into view; what the panel read when it mounted never does.
describe("a page the agent shows", () => {
    const shown = (shownts: number, over: Partial<PanelAgentState["tabs"][number]> = {}): PanelAgentState => ({
        blockid: "panel",
        tabs: [{ browsertabid: "agent-tab", agentname: "Codex", origin: "opened", state: "active", shownts, ...over }],
    });
    let model: BrowserAgentModel;
    let publish: (state: PanelAgentState) => void;
    let onShown: Mock<() => void>;

    beforeEach(async () => {
        Mocks.call.mockReset().mockResolvedValue(shown(100));
        Mocks.subscribe.mockImplementation(({ handler }) => {
            publish = (state) => handler({ data: state });
            return () => {};
        });
        model = new BrowserAgentModel("panel");
        onShown = vi.fn<() => void>();
        model.onShown = onShown;
        model.start();
        await vi.waitFor(() => expect(model.tabs()["agent-tab"]).toBeDefined());
    });

    afterEach(() => model.dispose());

    it("does not ask for the page the panel read when it mounted", () => {
        expect(onShown).not.toHaveBeenCalled();
    });

    it("asks once when the agent goes to another page", () => {
        publish(shown(250));
        expect(onShown).toHaveBeenCalledTimes(1);
        publish(shown(250, { action: "Clicked Search" }));
        expect(onShown).toHaveBeenCalledTimes(1);
    });

    it("asks again for each page the agent shows", () => {
        publish(shown(250));
        publish(shown(251));
        expect(onShown).toHaveBeenCalledTimes(2);
    });

    it("does not ask for the agent's other actions or for a question on the page", () => {
        publish(shown(100, { action: "Clicked Search", actionts: 300 }));
        publish(shown(100, { permission: { requestid: "r1", site: "example.com" } }));
        publish(shown(100, { viewport: { width: 390, height: 844 } }));
        expect(onShown).not.toHaveBeenCalled();
    });

    it("asks when the agent opens a tab in the panel", () => {
        publish({ blockid: "panel", tabs: [] });
        publish(shown(400, { browsertabid: "agent-other" }));
        expect(onShown).toHaveBeenCalledTimes(1);
    });

    it("does not ask when a snapshot read again after a failed Stop brings the same page back", async () => {
        publish(shown(250));
        onShown.mockClear();
        Mocks.call.mockResolvedValueOnce(shown(250));
        await model.loadSnapshot(true);
        expect(onShown).not.toHaveBeenCalled();
    });

    it("does not ask for a state of another panel", () => {
        publish({ ...shown(900), blockid: "elsewhere" });
        expect(onShown).not.toHaveBeenCalled();
    });
});
