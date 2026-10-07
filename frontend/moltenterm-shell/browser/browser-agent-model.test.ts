// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
