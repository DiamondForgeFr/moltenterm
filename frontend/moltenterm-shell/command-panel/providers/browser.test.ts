// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    settings: {} as Record<string, unknown>,
    settingsWrites: [] as Record<string, unknown>[],
}));

vi.mock("@/app/store/global", () => ({
    atoms: { settingsAtom: { key: "settings" } },
    getBlockMetaKeyAtom: (_blockId: string, key: string) => ({ key: `meta:${key}` }),
    globalStore: { get: (a: { key: string }) => (a.key === "settings" ? state.settings : undefined) },
}));
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        SetMetaCommand: async () => {},
        SetConfigCommand: async (_c: unknown, data: Record<string, unknown>) => {
            state.settingsWrites.push(data);
        },
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wos", () => ({ makeORef: (t: string, id: string) => `${t}:${id}` }));

import { collectPanel, matchingProviders } from "../panel-registry";
import { PanelAction, PanelContext, PanelItem, PanelSection } from "../panel-types";
import { BrowserCommandState, BrowserCommandTarget, BrowserProvider, browserSections } from "./browser";

function makeState(patch: Partial<BrowserCommandState> = {}): BrowserCommandState {
    return {
        tab: { id: "t1", url: "https://example.com/a", title: "Example" },
        tabCount: 2,
        zoom: 100,
        list: { browsers: [], default: "app" },
        site: "example.com",
        routed: { site: "example.com", engine: "" },
        agentDecision: null,
        agentTab: null,
        agentView: null,
        agentTabShown: false,
        ...patch,
    };
}

function makeTarget(s: BrowserCommandState) {
    const calls: string[] = [];
    const record =
        (name: string) =>
        (...args: unknown[]) => {
            calls.push([name, ...args].join(" "));
        };
    const target: BrowserCommandTarget = {
        viewType: "molten-browser",
        commandState: () => s,
        reloadActive: record("reload"),
        setZoom: record("zoom"),
        copyTabLink: record("copy"),
        openExternally: record("external"),
        setEngine: record("engine"),
        newTab: record("newtab"),
        duplicateTab: record("duplicate"),
        closeTab: record("close"),
        closeOtherTabs: record("closeothers"),
        toggleSiteChoice: record("sitechoice"),
        forgetAgentSite: record("forgetagent"),
        controlAgent: record("agent"),
        showTab: record("show"),
        openPageDevTools: record("devtools"),
    };
    return { target, calls };
}

function makeCtx(viewModel: unknown, view = "molten-browser"): PanelContext {
    return {
        blockId: "block-1",
        view,
        meta: { view },
        viewModel: viewModel as ViewModel,
        capabilities: new Set(view === "molten-browser" ? ["view:molten-browser", "browser"] : [`view:${view}`]),
        agent: null,
        kindLabel: "browser panels",
        panelName: "Browser",
    };
}

function section(sections: PanelSection[], id: string): PanelSection {
    return sections.find((s) => s.id === id);
}

function item(sections: PanelSection[], id: string): PanelItem {
    return sections.flatMap((s) => s.items).find((i) => i.id === id);
}

beforeEach(() => {
    state.settings = {};
    state.settingsWrites = [];
});

describe("Browser provider (FR-SHELL-051 AC1, DS-SHELL-090)", () => {
    it("applies to a browser panel whose view model reads the browser", () => {
        const { target } = makeTarget(makeState());
        expect(matchingProviders(makeCtx(target), [BrowserProvider]).map((p) => p.id)).toEqual(["browser"]);
    });

    it("does not apply to another panel, nor to a browser panel without its model", () => {
        const { target } = makeTarget(makeState());
        expect(matchingProviders(makeCtx(target, "term"), [BrowserProvider])).toEqual([]);
        expect(matchingProviders(makeCtx(null), [BrowserProvider])).toEqual([]);
        expect(matchingProviders(makeCtx({ viewType: "web" }), [BrowserProvider])).toEqual([]);
    });

    it("shows Page, Tabs and Links, without Agent control when no agent drives a tab", () => {
        const { target } = makeTarget(makeState());
        const panel = collectPanel(makeCtx(target), [BrowserProvider]);
        expect(panel.sections.map((s) => s.title)).toEqual(["Page", "Tabs", "Links", "Developer"]);
        expect(section(panel.sections, "widget:browser:page").items.map((i) => i.label)).toEqual([
            "Reload",
            "Zoom",
            "Copy link",
        ]);
    });

    it("runs the page and tab actions on the shown tab", async () => {
        const { target, calls } = makeTarget(makeState());
        const sections = browserSections(makeCtx(target));
        for (const id of ["browser:reload", "browser:copylink", "browser:duplicatetab", "browser:closeothers"]) {
            await (item(sections, id) as PanelAction).run();
        }
        expect(calls).toEqual(["reload false", "copy t1", "duplicate t1", "closeothers t1"]);
    });

    it("leaves Close tab and Close other tabs out on the last tab (the footer closes the panel)", () => {
        const { target } = makeTarget(makeState({ tabCount: 1 }));
        const sections = browserSections(makeCtx(target));
        expect(item(sections, "browser:closetab")).toBeUndefined();
        expect(item(sections, "browser:closeothers")).toBeUndefined();
    });

    it("leaves Copy link out on a tab without an address, like the tab's menu (FR-SHELL-054)", () => {
        const { target } = makeTarget(makeState({ tab: { id: "t1", url: "" } }));
        expect(item(browserSections(makeCtx(target)), "browser:copylink")).toBeUndefined();
    });

    it("hands off to the installed browser and offers the site choice and the engine with several browsers", () => {
        const brave = { id: "brave", name: "Brave", path: "/b" };
        const chrome = { id: "chrome", name: "Chrome", path: "/c" };
        const { target } = makeTarget(
            makeState({
                list: { browsers: [brave, chrome], chosen: brave, default: "app" },
                routed: { site: "example.com", engine: "brave" },
            })
        );
        const sections = browserSections(makeCtx(target));
        expect(item(sections, "browser:openexternally").label).toBe("Open in Brave");
        expect(item(sections, "browser:engine")).toMatchObject({ type: "choice", value: "app" });
        expect(item(sections, "browser:sitechoice")).toMatchObject({ label: "Always open in Brave", value: true });
        expect(item(sections, "browser:default")).toBeDefined();
    });

    it("writes Links open in MoltenTerm to the global settings", async () => {
        const { target } = makeTarget(makeState());
        const toggle = item(browserSections(makeCtx(target)), "browser:openlinksinternally");
        expect(toggle.type).toBe("toggle");
        await (toggle as any).scopes[0].set(false);
        expect(state.settingsWrites).toEqual([{ "web:openlinksinternally": false }]);
    });

    it("adds an Agent control section, first, while an agent drives a tab", async () => {
        const agentTab = { browsertabid: "t2", agentname: "Claude Code", origin: "o", state: "active" };
        const { target, calls } = makeTarget(
            makeState({
                agentTab,
                agentView: {
                    takenOver: false,
                    title: "Claude Code is controlling this tab",
                    detail: "click",
                    viewport: "",
                    buttons: [],
                },
                agentTabShown: false,
            })
        );
        const panel = collectPanel(makeCtx(target), [BrowserProvider]);
        expect(panel.sections[0]).toMatchObject({ id: "agent:browser-control", kind: "agent", title: "Agent control" });
        expect(panel.sections[0].items.map((i) => i.label)).toEqual([
            "Claude Code is controlling another tab",
            "Show the agent's tab",
            "Take over",
            "Stop the agent",
        ]);
        await (item(panel.sections, "browser:agent:stop") as PanelAction).run();
        expect(calls).toEqual(["agent t2 stop"]);
    });

    it("offers Open in MoltenTerm instead of the page actions on a handed-off entry", () => {
        const { target } = makeTarget(
            makeState({ tab: { id: "t1", url: "https://example.com", engine: "brave" }, zoom: null })
        );
        const sections = browserSections(makeCtx(target));
        expect(item(sections, "browser:reload")).toBeUndefined();
        expect(item(sections, "browser:openhere")).toBeDefined();
        expect(section(sections, "developer")).toBeUndefined();
    });
});
