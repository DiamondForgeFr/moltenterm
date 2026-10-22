// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Browser sections of the command panel (FR-SHELL-051, DS-SHELL-090): Page (Reload, Zoom, Copy link, Open
// externally, Engine), Tabs, This site (the per-site engine and the agents' decision), Links (web:openlinksinternally,
// browser:default), and an Agent control section while an agent drives one of the panel's tabs. Ad blocking is left
// out until it ships (an item whose feature has not shipped is not shown).
//
// The provider reads the panel through BrowserCommandTarget, which the browser's view model implements, so it never
// imports the view (and its webviews) itself.

import type { AgentControlAction, AgentTab, ControlBarView } from "../../browser/browser-agent";
import type { BrowserList } from "../../browser/browser-engine";
import type { BrowserTab } from "../../browser/browser-model";
import { t } from "../../i18n/i18n";
import { settingsBinding } from "../bindings";
import { CommandProvider, PanelContext, PanelItem, PanelSection } from "../panel-types";

export const BrowserZoomMin = 30;
export const BrowserZoomMax = 300;
export const BrowserZoomStep = 10;

export type BrowserCommandState = {
    tab: BrowserTab;
    tabCount: number;
    // The page's zoom in percent, or null while the page has no webview yet.
    zoom: number;
    list: BrowserList;
    // The page's site (no "www."), or null for a non-web page.
    site: string;
    // The per-site entry that applies to the page: its site and engine ("" when none).
    routed: { site: string; engine: string };
    // The agents' remembered decision for the page's site.
    agentDecision: { site: string; decision: string };
    // The tab an agent drives, the shown one first, with its bar's view.
    agentTab: AgentTab;
    agentView: ControlBarView;
    agentTabShown: boolean;
};

export type BrowserCommandTarget = {
    viewType: string;
    commandState(): BrowserCommandState;
    reloadActive(ignoreCache: boolean): void;
    setZoom(percent: number): void;
    copyTabLink(id: string): void;
    openExternally(id: string): void;
    setEngine(id: string, engine: string): void;
    newTab(url?: string): void;
    duplicateTab(id: string): void;
    closeTab(id: string): void;
    closeOtherTabs(id: string): void;
    toggleSiteChoice(url: string): void;
    forgetAgentSite(site: string): void;
    controlAgent(browserTabId: string, action: AgentControlAction): void;
    showTab(id: string): void;
    openPageDevTools(): void;
};

export const BrowserViewType = "molten-browser";

function target(ctx: PanelContext): BrowserCommandTarget {
    const vm = ctx.viewModel as unknown as BrowserCommandTarget;
    return vm?.viewType === BrowserViewType && typeof vm.commandState === "function" ? vm : null;
}

function pageItems(bt: BrowserCommandTarget, s: BrowserCommandState): PanelItem[] {
    const tab = s.tab;
    const handedOff = !!tab.engine;
    const chosen = s.list?.chosen;
    const items: PanelItem[] = [];
    if (!handedOff) {
        items.push({
            id: "browser:reload",
            type: "action",
            label: t("browser.nav.reload"),
            icon: "rotate-right",
            shortcut: "⌘R",
            keywords: ["refresh"],
            run: () => bt.reloadActive(false),
        });
        if (s.zoom != null) {
            items.push({
                id: "browser:zoom",
                type: "number",
                label: t("cmdpanel.browser.zoom"),
                icon: "magnifying-glass-plus",
                keywords: ["zoom in", "zoom out", "text size"],
                min: BrowserZoomMin,
                max: BrowserZoomMax,
                step: BrowserZoomStep,
                control: "stepper",
                format: (v) => `${v} %`,
                value: s.zoom,
                set: (v) => bt.setZoom(v),
            });
        }
    }
    // Unavailable actions are absent, not disabled (FR-SHELL-049), here and in the tab's menu (FR-SHELL-054).
    if (tab.url) {
        items.push({
            id: "browser:copylink",
            type: "action",
            label: t("browser.tabMenu.copyLink"),
            icon: "link",
            keywords: ["url", "address"],
            keepOpen: true,
            run: () => bt.copyTabLink(tab.id),
        });
    }
    if (handedOff) {
        items.push({
            id: "browser:openhere",
            type: "action",
            label: t("browser.menu.openHere"),
            icon: "window-maximize",
            run: () => bt.setEngine(tab.id, "app"),
        });
    } else if (s.site != null && chosen != null) {
        items.push({
            id: "browser:openexternally",
            type: "action",
            label: t("browser.choice.openIn", { browser: chosen.name }),
            icon: "arrow-up-right-from-square",
            keywords: ["external", "handoff", "installed browser"],
            run: () => bt.openExternally(tab.id),
        });
    }
    // Choosing among browsers only means something with more than one installed.
    const browsers = s.list?.browsers ?? [];
    if (browsers.length > 1 && s.site != null) {
        items.push({
            id: "browser:engine",
            type: "choice",
            label: t("cmdpanel.browser.engine"),
            icon: "compass",
            keywords: ["open with", "browser"],
            options: [
                { id: "engine:app", label: "MoltenTerm", value: "app" },
                ...browsers.map((b) => ({ id: `engine:${b.id}`, label: b.name, value: b.id })),
            ],
            value: tab.engine || "app",
            set: (v) => bt.setEngine(tab.id, String(v)),
        });
    }
    return items;
}

function tabItems(bt: BrowserCommandTarget, s: BrowserCommandState): PanelItem[] {
    const tab = s.tab;
    const items: PanelItem[] = [
        {
            id: "browser:newtab",
            type: "action",
            label: t("browser.tabs.newTab"),
            icon: "plus",
            shortcut: "⌘T",
            run: () => bt.newTab(),
        },
        {
            id: "browser:duplicatetab",
            type: "action",
            label: t("cmdpanel.browser.duplicateTab"),
            icon: "clone",
            run: () => bt.duplicateTab(tab.id),
        },
    ];
    // The last tab closes with its panel, which the footer's Close already offers.
    if (s.tabCount <= 1) {
        return items;
    }
    items.push(
        {
            id: "browser:closetab",
            type: "action",
            label: t("browser.tabs.closeTab"),
            icon: "xmark",
            shortcut: "⌘W",
            run: () => bt.closeTab(tab.id),
        },
        {
            id: "browser:closeothers",
            type: "action",
            label: t("cmdpanel.browser.closeOtherTabs"),
            icon: "xmark",
            run: () => bt.closeOtherTabs(tab.id),
        }
    );
    return items;
}

function siteItems(bt: BrowserCommandTarget, s: BrowserCommandState): PanelItem[] {
    const items: PanelItem[] = [];
    const chosen = s.list?.chosen;
    const always = s.routed.engine !== "" && s.routed.engine !== "app";
    if (s.site != null && chosen != null) {
        items.push({
            id: "browser:sitechoice",
            type: "toggle",
            label: t("browser.menu.alwaysOpenIn", { browser: chosen.name }),
            icon: "thumbtack",
            detail: always ? s.routed.site : s.site,
            keywords: ["site", "engine", "remember"],
            value: always,
            set: () => bt.toggleSiteChoice(s.tab.url),
        });
    }
    if (s.agentDecision != null) {
        const blocked = s.agentDecision.decision === "block";
        items.push({
            id: "browser:forgetagentsite",
            type: "action",
            label: t("cmdpanel.browser.forgetAgentsChoice"),
            icon: "robot",
            detail: t(blocked ? "cmdpanel.browser.agentsBlocked" : "cmdpanel.browser.agentsAllowed"),
            keywords: ["agent permission", "site permission"],
            run: () => bt.forgetAgentSite(s.agentDecision.site),
        });
    }
    return items;
}

function linkItems(s: BrowserCommandState): PanelItem[] {
    const items: PanelItem[] = [
        {
            id: "browser:openlinksinternally",
            type: "toggle",
            label: t("cmdpanel.browser.linksInternal"),
            icon: "arrow-pointer",
            keywords: ["web:openlinksinternally", "links"],
            defaultValue: true,
            scopes: [settingsBinding<boolean>("web:openlinksinternally", true, "global")],
        },
    ];
    const chosen = s.list?.chosen;
    if (chosen != null) {
        items.push({
            id: "browser:default",
            type: "choice",
            label: t("cmdpanel.browser.defaultBrowser"),
            icon: "globe",
            keywords: ["browser:default", "engine"],
            options: [
                { id: "default:app", label: "MoltenTerm", value: "app" },
                { id: "default:installed", label: chosen.name, value: "installed" },
            ],
            defaultValue: "app",
            scopes: [settingsBinding<unknown>("browser:default", "app", "global")],
        });
    }
    return items;
}

function agentItems(bt: BrowserCommandTarget, s: BrowserCommandState): PanelItem[] {
    const tab = s.agentTab;
    const view = s.agentView;
    // The control bar speaks of the tab it sits on; here the driven tab may be another one.
    const title =
        s.agentTabShown || view.takenOver
            ? view.title
            : t("cmdpanel.browser.controllingOther", { name: tab.agentname?.trim() || t("browser.agent.anAgent") });
    const items: PanelItem[] = [{ id: "browser:agent:status", type: "info", label: title, detail: view.detail }];
    if (!s.agentTabShown) {
        items.push({
            id: "browser:agent:show",
            type: "action",
            label: t("cmdpanel.browser.showAgentTab"),
            icon: "eye",
            run: () => bt.showTab(tab.browsertabid),
        });
    }
    if (view.takenOver) {
        items.push({
            id: "browser:agent:giveback",
            type: "action",
            label: t("browser.agent.giveBackTo", { name: tab.agentname?.trim() || t("browser.agent.anAgent") }),
            icon: "robot",
            run: () => bt.controlAgent(tab.browsertabid, "giveback"),
        });
    } else {
        items.push({
            id: "browser:agent:takeover",
            type: "action",
            label: t("cmdpanel.browser.takeOver"),
            icon: "hand",
            run: () => bt.controlAgent(tab.browsertabid, "takeover"),
        });
    }
    items.push({
        id: "browser:agent:stop",
        type: "action",
        label: t("cmdpanel.browser.stopAgent"),
        icon: "stop",
        destructive: true,
        run: () => bt.controlAgent(tab.browsertabid, "stop"),
    });
    return items;
}

export function browserSections(ctx: PanelContext): PanelSection[] {
    const bt = target(ctx);
    const s = bt?.commandState();
    if (s?.tab == null) {
        return [];
    }
    const sections: PanelSection[] = [];
    if (s.agentTab != null && s.agentView != null) {
        sections.push({
            id: "agent:browser-control",
            kind: "agent",
            title: t("browser.agent.controlAria"),
            state: s.agentView.takenOver ? t("cmdpanel.browser.stateTookOver") : t("cmdpanel.browser.stateControlling"),
            stateTone: s.agentView.takenOver ? "muted" : "warning",
            items: agentItems(bt, s),
        });
    }
    sections.push(
        { id: "widget:browser:page", kind: "widget", title: t("cmdpanel.browser.page"), items: pageItems(bt, s) },
        { id: "widget:browser:tabs", kind: "widget", title: t("cmdpanel.browser.tabs"), items: tabItems(bt, s) },
        { id: "widget:browser:site", kind: "widget", title: t("cmdpanel.browser.thisSite"), items: siteItems(bt, s) },
        { id: "widget:browser:links", kind: "widget", title: t("cmdpanel.browser.links"), items: linkItems(s) }
    );
    if (!s.tab.engine) {
        sections.push({
            id: "developer",
            kind: "developer",
            title: t("cmdpanel.section.developer"),
            items: [
                {
                    id: "browser:devtools",
                    type: "action",
                    label: t("cmdpanel.browser.inspect"),
                    icon: "code",
                    keywords: ["devtools", "developer tools", "console"],
                    run: () => bt.openPageDevTools(),
                },
            ],
        });
    }
    return sections;
}

export const BrowserProvider: CommandProvider = {
    id: "browser",
    kind: "widget",
    needs: ["browser"],
    when: (ctx) => target(ctx) != null,
    sections: browserSections,
};
