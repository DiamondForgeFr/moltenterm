// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const Mocks = vi.hoisted(() => ({ subscribe: vi.fn(), call: vi.fn() }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: Mocks.subscribe }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: Mocks.call } }));

import { AgentPermissionBar } from "./agent-permission-bar";
import {
    AgentReuseAsk,
    applyReuseAnswer,
    BrowserAgentModel,
    newReuseAsks,
    PanelAgentState,
    permissionBarView,
    readPanelReuseAsks,
    reuseBarView,
} from "./browser-agent";
import { consumeShowRequestsMeta, readShowRequests } from "./browser-model";

// #2333: an agent asks, on the tab's own bar, whether it may use a page the user opened. The pages are synthetic.

const Ask: AgentReuseAsk = { browsertabid: "docs-tab", requestid: "r1", agentname: "Flore", since: 100 };

const Asking = (asks: AgentReuseAsk[]): PanelAgentState => ({ blockid: "panel", tabs: [], asks });

describe("the reuse question of a page the user opened", () => {
    it("asks in the permission bar's words, with Open another tab first and Allow as the primary", () => {
        const view = reuseBarView(Ask);
        expect(view.title).toBe("Flore would like to use this page");
        expect(view.detail).toBe("Allow lets it work in this tab. Otherwise it opens another one.");
        expect(view.buttons.map((b) => [b.label, b.decision, b.primary])).toEqual([
            ["Open another tab", "deny", false],
            ["Allow", "allow", true],
        ]);
        expect(view.escape).toBe("deny");
        expect(view.reuse).toBe(true);
        expect(view.requestId).toBe("r1");
        expect(view.site).toBe("");
    });

    it("names an agent without a name, and shows nothing without a request", () => {
        expect(reuseBarView({ ...Ask, agentname: "  " }).title).toBe("An agent would like to use this page");
        expect(reuseBarView(null)).toBe(null);
        expect(reuseBarView({ ...Ask, requestid: "" })).toBe(null);
    });

    it("is not a site permission, which keeps its own bar", () => {
        expect(permissionBarView(null)).toBe(null);
        expect(reuseBarView(Ask).reuse).toBe(true);
    });

    it("reads the panel's state: the oldest question of each tab", () => {
        const asks = readPanelReuseAsks(
            Asking([Ask, { ...Ask, requestid: "r2" }, { ...Ask, browsertabid: "other-tab", requestid: "r3" }])
        );
        expect(Object.keys(asks).sort()).toEqual(["docs-tab", "other-tab"]);
        expect(asks["docs-tab"].requestid).toBe("r1");
        expect(readPanelReuseAsks({ blockid: "panel", tabs: [] })).toEqual({});
        expect(readPanelReuseAsks(null)).toEqual({});
        expect(
            readPanelReuseAsks(
                Asking([
                    { ...Ask, requestid: "" },
                    { ...Ask, browsertabid: "" },
                ])
            )
        ).toEqual({});
    });

    it("drops the answered question at once, and only that one", () => {
        const asks = { "docs-tab": Ask };
        expect(applyReuseAnswer(asks, "docs-tab", "r1")).toEqual({});
        expect(applyReuseAnswer(asks, "docs-tab", "r2")).toBe(asks);
        expect(applyReuseAnswer(asks, "other-tab", "r1")).toBe(asks);
    });

    it("tells the questions the panel has not held yet, the oldest first", () => {
        const asks = readPanelReuseAsks(Asking([Ask, { ...Ask, browsertabid: "b", requestid: "r2", since: 50 }]));
        expect(newReuseAsks(asks, new Set()).map((a) => a.requestid)).toEqual(["r2", "r1"]);
        expect(newReuseAsks(asks, new Set(["r1"])).map((a) => a.requestid)).toEqual(["r2"]);
        expect(newReuseAsks(asks, new Set(["r1", "r2"]))).toEqual([]);
    });
});

describe("the panel's model of the questions", () => {
    let model: BrowserAgentModel;
    let publish: (state: PanelAgentState) => void;
    let onAsk: Mock<(tabIds: string[]) => void>;

    beforeEach(async () => {
        Mocks.call.mockReset().mockResolvedValue(Asking([Ask]));
        Mocks.subscribe.mockImplementation(({ handler }) => {
            publish = (state) => handler({ data: state });
            return () => {};
        });
        model = new BrowserAgentModel("panel");
        onAsk = vi.fn<(tabIds: string[]) => void>();
        model.onAsk = onAsk;
        model.start();
        await vi.waitFor(() => expect(globalStore.get(model.asksAtom)["docs-tab"]).toBeDefined(), { timeout: 30_000 });
    });

    afterEach(() => model.dispose());

    it("does not bring the panel into view for the question it read when it mounted", () => {
        expect(onAsk).not.toHaveBeenCalled();
    });

    it("brings the panel into view once for a question that arrives live", () => {
        publish(Asking([Ask, { ...Ask, browsertabid: "second-tab", requestid: "r2" }]));
        expect(onAsk).toHaveBeenCalledTimes(1);
        expect(onAsk).toHaveBeenCalledWith(["second-tab"]);
        publish(Asking([Ask, { ...Ask, browsertabid: "second-tab", requestid: "r2" }]));
        expect(onAsk).toHaveBeenCalledTimes(1);
    });

    it("forgets a question the agent withdrew", () => {
        publish(Asking([]));
        expect(globalStore.get(model.asksAtom)).toEqual({});
        publish(Asking([{ ...Ask, requestid: "r9" }]));
        expect(onAsk).toHaveBeenCalledTimes(1);
    });

    it("sends the answer to wavesrv and removes the question before it confirms", () => {
        model.answer("docs-tab", "r1", "allow");
        expect(globalStore.get(model.asksAtom)).toEqual({});
        expect(Mocks.call).toHaveBeenLastCalledWith(
            "moltenbrowseragentanswer",
            { blockid: "panel", browsertabid: "docs-tab", requestid: "r1", decision: "allow" },
            expect.objectContaining({ route: "molten:browseragent" })
        );
    });
});

describe("the permission bar shows the question of a page the user opened", () => {
    let model: BrowserAgentModel;

    beforeEach(() => {
        Mocks.call.mockReset().mockResolvedValue(Asking([]));
        Mocks.subscribe.mockImplementation(() => () => {});
        model = new BrowserAgentModel("panel");
    });

    const render = (tabId: string) =>
        renderToStaticMarkup(
            <Provider store={globalStore}>
                <AgentPermissionBar agents={model} tabId={tabId} />
            </Provider>
        );

    it("shows nothing for a tab nobody asks about", () => {
        globalStore.set(model.asksAtom, { "docs-tab": Ask });
        expect(render("another-tab")).toBe("");
    });

    it("names the agent and offers Open another tab and Allow, with its own label for assistive technology", () => {
        globalStore.set(model.asksAtom, { "docs-tab": Ask });
        const html = render("docs-tab");
        expect(html).toContain("Flore would like to use this page");
        expect(html).toContain("Open another tab");
        expect(html).toContain("Allow");
        expect(html).toContain('aria-label="Request to use this page"');
        expect(html).not.toContain("Block");
        expect(html.indexOf("Open another tab")).toBeLessThan(html.lastIndexOf("Allow"));
    });
});

describe("the pages `molten open` asks the panel to show", () => {
    it("reads one key per request, in queue order", () => {
        const meta = {
            "molten:browser:show:02": "tab-b",
            "molten:browser:show:01": "tab-a",
            "molten:browser:open:03": "https://docs.example/guide",
            "molten:browser:show:04": "",
            "molten:browser:show:05": 7,
            "molten:browser:show:": "tab-x",
            "molten:browser:show:06": "x".repeat(500),
        };
        expect(readShowRequests(meta)).toEqual([
            { id: "01", tabId: "tab-a" },
            { id: "02", tabId: "tab-b" },
        ]);
        expect(readShowRequests(null)).toEqual([]);
    });

    it("takes out of the queue only what it read", () => {
        expect(consumeShowRequestsMeta([{ id: "01", tabId: "tab-a" }])).toEqual({ "molten:browser:show:01": null });
    });
});
