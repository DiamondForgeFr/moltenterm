// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The browser panel (FR-SHELL-007, DS-SHELL-007): one page per panel since #1187 (FR-SHELL-083), with no tab strip;
// what opened a tab opens a panel to the right. The tab list of the block meta stays, holding that one page, so the
// agents' tab ids, sharing and the handed-off entries keep their model. Every web page Moltenterm opens lands here
// (#132): Wave's web view is no longer created, and saved ones are migrated at startup.
//
// The panel has no Wave block header (FR-SHELL-012, DS-SHELL-012): its navigation row carries the header's roles
// (moving the panel, magnify, close, the header menu).

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { OptMagnifyButton } from "@/app/block/blockutil";
import { Button } from "@/app/element/button";
import { IconButton } from "@/app/element/iconbutton";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { atoms, getApi, getSettingsKeyAtom, openLink as openInterfaceLink, refocusNode } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { uxCloseBlock } from "@/app/store/keymodel";
import * as WOS from "@/app/store/wos";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { NodeModel } from "@/layout/index";
import { checkKeyPressed } from "@/util/keyutil";
import { cn, fireAndForget, useAtomValueSafe } from "@/util/util";
import type { WebviewTag } from "electron";
import { atom, Atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { loadIntegrationRuns, type AgentIntegrationRun } from "../agent-integration-runs";
import { agentCallName, agentStatesOfWorkspace } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { openHeaderCommandPanel } from "../command-panel/block-menus";
import { openCommandPanelFromTrigger } from "../command-panel/command-panel-store";
import type { BrowserCommandState } from "../command-panel/providers/browser";
import { HeaderCloseButton } from "../header/header-close-button";
import { Pill } from "../header/pill";
import { I18nModel, t, useLocale, useT } from "../i18n/i18n";
import { translate } from "../i18n/i18n-core";
import { serverErrorText, serverText } from "../i18n/server-text";
import { guestEditMenu, guestMenuEvent } from "../menu/guest-menu";
import { openSettingsSection } from "../settings/settings-open";
import { formatShortcutById } from "../shortcuts/format";
import { SidebarModel } from "../sidebar/sidebar-store";
import { openTopField } from "../sidebar/top-field-store";
import { splitPanel } from "../split/split";
import { splitMenuItems } from "../split/split-menu";
import { DominoLoader } from "../suite/suite";
import { TabActivity } from "../tab-activity";
import { isShowing } from "../tab-activity-model";
import { PanelMeta, panelTitle } from "../tab-identity";
import { showToast } from "../toast-store";
import { attachSwipeWheel } from "../sidebar/sidebar-swipe-view";
import { attachCarpetWheel } from "../view360/carpet-wheel-webview";
import { isOffCarpet, offCarpetAtom, setKeepLive } from "../view360/offcarpet-model";
import { PinHeaderButton } from "../view360/view360-pin";
import { AgentActionCueOverlay, AgentControlBar } from "./agent-control-bar";
import { AgentPermissionBar } from "./agent-permission-bar";
import { AgentPressApi, keepUserFocus, listenAgentPresses, onInputHeld } from "./agent-press-focus";
import {
    AgentControlAction,
    agentName,
    AgentSession,
    agentSiteDecision,
    AgentTab,
    AgentTabs,
    BrowserAgentModel,
    controlBarView,
    permissionBarView,
    setAgentSite,
    ShareResult,
} from "./browser-agent";
import {
    browserActivate,
    BrowserEngineModel,
    browserIconClass,
    browserOpen,
    BrowserRoute,
    browserSetSite,
    EngineApp,
    EngineInstalled,
    engineName,
    fallbackNotice,
    fallbackReason,
    InstalledBrowser,
    siteEngine,
    siteOf,
} from "./browser-engine";
import { BrowserErrorModel, isPageFailure } from "./browser-error";
import { BrowserErrorPage } from "./browser-error-page";
import { BrowserStartPage } from "./browser-start-page";
import {
    BrowserLifecycleModel,
    PageScroll,
    reportWebviewShown,
    scrollScript,
    shouldRestore,
} from "./browser-lifecycle";
import { BrowserLoadModel, reloadAction, runReload, TabLoad } from "./browser-loading";
import {
    activateTab,
    besideBlockDef,
    BesideOpts,
    BrowserAskMetaKey,
    BrowserKeepFocusMetaKey,
    browserMeta,
    BrowserNoticeMetaKey,
    BrowserState,
    BrowserTab,
    browserTabTitle,
    closeTab,
    consumeCloseRequestsMeta,
    consumeOpenRequestsMeta,
    isAgentTabId,
    addressOfPage,
    isBlankPage,
    isStartPage,
    makeTabId,
    MoltentermBrowserView,
    readBrowserState,
    readCloseRequests,
    readOpenRequests,
    setTabEngine,
    shownAddress,
    splitOutTabs,
    StartPageUrl,
    toBrowserUrl,
    updateTab,
} from "./browser-model";
import { pageOpenTarget, WindowOpenSystem, WindowOpenTab, type SignInBar } from "./browser-popup";
import { noteBrowserPanelFocus } from "./browser-routing";
import {
    isSharedTab,
    moveQuestion,
    noAgentReason,
    ofTab,
    ShareAgent,
    shareAgents,
    shareLabel,
    shareMenuItems,
    shareStateText,
    unshareableReason,
} from "./browser-share";
import { browserTabMenu } from "./browser-tab-menu";
import "./browser.css";
import { BrowserChoiceModel, EngineChoiceBar } from "./engine-choice-bar";
import { blockIdOfORef, focusWhenPlaced } from "./focus-placed";
import { choiceEngineId, EngineChoice } from "./link-choice";
import { BrowserSignInModel, SignInRefusalBar } from "./signin-bar";
import { isSiteAsk, SitePermissionBar, SitePermissionModel } from "./site-permission-bar";
import { TestContextChip } from "./test-context";

export { MoltentermBrowserView };

const PersistDelayMs = 400;
// Without a home page set (web:defaulturl), a new browser opens MoltenTerm's start page, never a site (FR-SHELL-110).
const FallbackUrl = StartPageUrl;

// The agents' DevTools controller needs each tab's webview (emain/moltenterm-browseragent.ts, FR-BRW-008).
type BrowserAgentElectronApi = ElectronApi &
    AgentPressApi & {
        moltentermRegisterWebview?: (blockId: string, browserTabId: string, webContentsId: number) => void;
    };

function registerWebview(blockId: string, browserTabId: string, webContentsId: number): void {
    listenAgentPresses(getApi() as BrowserAgentElectronApi);
    (getApi() as BrowserAgentElectronApi).moltentermRegisterWebview?.(blockId, browserTabId, webContentsId);
}

function webviewPreloadUrl(): string {
    const path = getApi().getWebviewPreload();
    return path ? "file://" + path : undefined;
}

export class BrowserViewModel implements ViewModel {
    viewType = MoltentermBrowserView;
    blockId: string;
    // The workspace tab holding the panel, where pages opened beside it go.
    tabId: string;
    nodeModel: BlockNodeModel;
    // A panel in the layout gets the layout's node, which also carries the drag handle and the ephemeral state the
    // header used; the narrower interface leaves them out, so they are read as optional.
    layoutNode: Partial<NodeModel>;
    viewIcon = atom("globe");
    viewName = atom((get) => translate(get(I18nModel.getInstance().localeAtom), "browser.viewName"));
    noPadding = atom(true);
    noHeader = atom(true);
    stateAtom: PrimitiveAtom<BrowserState>;
    // The panes of the workspace tab holding this panel: Share with agent offers only their agents (#594).
    tabBlockIdsAtom: Atom<string[]>;
    webviews = new Map<string, WebviewTag>();
    urlInputRef: React.RefObject<HTMLInputElement> = { current: null };
    persistTimer: ReturnType<typeof setTimeout> = null;
    blockAtom: Atom<Block>;
    handledOpenIds = new Set<string>();
    // Why a page meant for the installed browser opened here instead (FR-BRW-002).
    noticeAtom = atom(null) as PrimitiveAtom<string>;
    engines = BrowserEngineModel.getInstance();
    // Sign-in refusals per tab (FR-BRW-003).
    signIn = new BrowserSignInModel();
    sitePermissions = new SitePermissionModel();
    // Load state and favicon per tab (#210).
    loads = new BrowserLoadModel();
    // The page that failed to load per tab, drawn as MoltenTerm's error page (FR-SHELL-051).
    errors = new BrowserErrorModel();
    // The first-link engine choice per tab (FR-BRW-006).
    choices = new BrowserChoiceModel();
    // The tabs agents drive, and their control bars (FR-BRW-008).
    agents: BrowserAgentModel;
    handledCloseIds = new Set<string>();
    // Hidden pages frozen and discarded by the main process (#459).
    lifecycle: BrowserLifecycleModel;

    constructor({ blockId, nodeModel, tabModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabId = tabModel?.tabId ?? null;
        this.tabBlockIdsAtom = atom((get) =>
            tabModel != null ? ((get(tabModel.tabAtom) as Tab)?.blockids ?? []) : []
        );
        this.layoutNode = nodeModel as Partial<NodeModel>;
        this.blockAtom = makeBlockAtom(blockId);
        this.stateAtom = atom(this.initialState()) as PrimitiveAtom<BrowserState>;
        this.agents = new BrowserAgentModel(blockId);
        this.agents.start();
        this.lifecycle = new BrowserLifecycleModel(blockId);
        this.lifecycle.start((tabId, webContentsId, scroll) => this.discardTab(tabId, webContentsId, scroll));
        this.takeInitialNotice();
        this.takeInitialAsk();
        this.splitOutSavedTabs();
        fireAndForget(() => this.engines.ensureLoaded());
    }

    // A panel saved with several tabs before panels showed one page (#1187): each other tab becomes a panel to its
    // right, in order, so no page is lost.
    splitOutSavedTabs(): void {
        const split = splitOutTabs(this.state());
        if (split == null) {
            return;
        }
        globalStore.set(this.stateAtom, split.kept);
        this.persistNow();
        fireAndForget(async () => {
            let after = this.blockId;
            for (const tab of split.moved) {
                after = (await this.createBeside(besideBlockDef(tab), after, false)) ?? after;
            }
        });
    }

    // A new browser panel to the right of `after` (this panel by default), in this panel's tab. Returns its block id.
    async createBeside(blockdef: BlockDef, after = this.blockId, focused = true): Promise<string> {
        const tabid = this.tabId ?? globalStore.get(atoms.staticTabId);
        try {
            const oref = await RpcApi.CreateBlockCommand(TabRpcClient, {
                tabid,
                blockdef,
                targetblockid: after,
                targetaction: "splitright",
                focused,
            });
            const created = blockIdOfORef(oref);
            if (focused) {
                focusWhenPlaced(created);
            }
            return created;
        } catch (e) {
            console.log("molten browser: no panel beside", e);
            return null;
        }
    }

    // What opened a tab before #1187 (FR-SHELL-083): a page beside this panel, or here when this panel only shows an
    // empty page nobody drives.
    openBeside(url: string, opts?: BesideOpts & { focus?: boolean }): void {
        const shown = this.findTab(this.state().activeId);
        if (
            shown != null &&
            !shown.engine &&
            isBlankPage(shown.url) &&
            !this.isAgentDriven(shown.id) &&
            this.state().tabs.length === 1
        ) {
            this.navigate(url);
            if (opts?.ask) {
                const site = siteOf(url);
                if (site != null) {
                    this.choices.ask(shown.id, url, site, opts.keepFocus);
                }
            }
            this.showNotice(opts?.notice);
            if (opts?.focus !== false) {
                this.focusPanel();
            }
            return;
        }
        fireAndForget(() => this.createBeside(besideBlockDef({ url }, opts), this.blockId, opts?.focus !== false));
    }

    // The shown page goes to url (the top field's Enter, FR-SHELL-083); a handed-off entry reopens there.
    navigate(url: string): void {
        const active = this.findTab(this.state().activeId);
        if (active == null || !url) {
            return;
        }
        if (active.engine) {
            this.reopenInBrowser(active.id, url);
            return;
        }
        this.activeWebview()
            ?.loadURL(url)
            .catch(() => {
                // A failure arrives as did-fail-load and shows the error page.
            });
        this.setState(updateTab(this.state(), active.id, { url, title: undefined }));
    }

    shownUrl(): string {
        return this.findTab(this.state().activeId)?.url ?? "";
    }

    // A panel created for a page that could not go to the installed browser carries the reason once.
    takeInitialNotice(): void {
        const notice = globalStore.get(this.blockAtom)?.meta?.[BrowserNoticeMetaKey];
        if (typeof notice !== "string" || notice === "") {
            return;
        }
        globalStore.set(this.noticeAtom, notice);
        fireAndForget(() =>
            RpcApi.SetMetaCommand(TabRpcClient, {
                oref: makeORef("block", this.blockId),
                meta: { [BrowserNoticeMetaKey]: null } as MetaType,
            })
        );
    }

    // A panel created for an interface link to a site without an engine asks on its first tab, once.
    takeInitialAsk(): void {
        const meta = globalStore.get(this.blockAtom)?.meta;
        if (meta?.[BrowserAskMetaKey] !== true) {
            return;
        }
        const tab = this.findTab(this.state().activeId);
        const site = siteOf(tab?.url);
        if (site != null) {
            this.choices.ask(tab.id, tab.url, site, meta[BrowserKeepFocusMetaKey] === true);
        }
        fireAndForget(() =>
            RpcApi.SetMetaCommand(TabRpcClient, {
                oref: makeORef("block", this.blockId),
                meta: { [BrowserAskMetaKey]: null, [BrowserKeepFocusMetaKey]: null } as MetaType,
            })
        );
    }

    showNotice(text: string): void {
        if (text) {
            globalStore.set(this.noticeAtom, text);
        }
    }

    dismissNotice(): void {
        globalStore.set(this.noticeAtom, null);
    }

    findTab(id: string): BrowserTab {
        return this.state().tabs.find((t) => t.id === id);
    }

    // A browser call that failed outright (wavesrv unreachable) reads like a fallback.
    async askBrowser(call: () => Promise<BrowserRoute>): Promise<BrowserRoute> {
        try {
            return await call();
        } catch (e) {
            return { engine: EngineApp, fallback: t("browser.notice.unreachable", { error: String(e) }) };
        }
    }

    // "Open in <browser>": the tab becomes a handed-off entry; on a fallback it stays here and the panel says why.
    // url replaces the tab's page when another one must be handed off (a sign-in refusal continues from the page
    // before the provider's).
    async handOffTab(id: string, engine = EngineInstalled, url?: string): Promise<void> {
        const tab = this.findTab(id);
        if (tab == null || tab.engine) {
            return;
        }
        const page = url || tab.url;
        const route = await this.askBrowser(() => browserOpen(page, engine));
        if (route.engine === EngineApp) {
            this.showNotice(fallbackNotice(route));
            return;
        }
        this.webviews.delete(id);
        this.lifecycle.forget(id);
        this.signIn.forget(id);
        this.sitePermissions.forgetTab(id);
        this.loads.forget(id);
        this.errors.forget(id);
        this.choices.forget(id);
        const next = page === tab.url ? this.state() : updateTab(this.state(), id, { url: page, title: undefined });
        this.setState(setTabEngine(next, id, route.engine));
    }

    // "Open with MoltenTerm" of the engine choice: the page stays, and the site keeps MoltenTerm when remembered.
    stayWithChoice(id: string, choice: EngineChoice): void {
        this.choices.forget(id);
        this.giveFocus();
        if (!choice.remember) {
            return;
        }
        fireAndForget(() => this.saveSiteChoice(choice.site, EngineApp));
    }

    // "Open in <browser>" of the engine choice: the page is handed off (DS-BRW-002), the site remembered first so the
    // next link goes there without asking.
    async handOffWithChoice(id: string, choice: EngineChoice, browser: InstalledBrowser): Promise<void> {
        const engine = choiceEngineId(browser);
        this.choices.forget(id);
        if (choice.remember) {
            await this.saveSiteChoice(choice.site, engine);
        }
        await this.handOffTab(id, engine);
    }

    // Close or Escape: MoltenTerm keeps the page and nothing is stored, so the next link to the site asks again.
    dismissChoice(id: string): void {
        this.choices.forget(id);
        this.giveFocus();
    }

    async saveSiteChoice(site: string, engine: string): Promise<void> {
        try {
            await browserSetSite(site, engine);
        } catch (e) {
            this.showNotice(t("browser.notice.siteChoiceNotSaved", { error: String(e) }));
        }
    }

    // "Continue in <browser>" of the sign-in refusal bar (FR-BRW-003).
    continueSignIn(id: string, bar: SignInBar): void {
        fireAndForget(() => this.handOffTab(id, EngineInstalled, bar.returnUrl));
    }

    async handOffActiveTab(): Promise<void> {
        await this.handOffTab(this.state().activeId);
    }

    // A link sent to the installed browser from the page's menu opens there; on a fallback it opens beside this panel.
    // No entry stays behind since panels show one page (#1187): the page is in that browser.
    async handOffLink(url: string): Promise<void> {
        const route = await this.askBrowser(() => browserOpen(url, EngineInstalled));
        if (route.engine === EngineApp) {
            this.openBeside(url, { notice: fallbackNotice(route) });
        }
    }

    // A page's new window (window.open, target=_blank): a panel beside this one (#1187), unless its site is set to the
    // installed browser. Only a web page or an empty page opens; mail goes to the system, anything else is dropped
    // (#663).
    openLink(url: string): void {
        const target = pageOpenTarget(url);
        if (target === WindowOpenSystem) {
            fireAndForget(() => openInterfaceLink(url));
            return;
        }
        if (target !== WindowOpenTab) {
            console.log("molten browser: a page's link to a non-web page dropped");
            return;
        }
        if (!this.engines.needsRouting(url)) {
            this.newTab(url);
            return;
        }
        fireAndForget(async () => {
            const route = await this.askBrowser(() => browserOpen(url));
            if (route.engine !== EngineApp) {
                return;
            }
            this.openBeside(url, { notice: fallbackNotice(route) });
        });
    }

    // Clicking a handed-off entry brings its browser to the front (on Linux, opens the page there again).
    bringForward(id: string): void {
        const tab = this.findTab(id);
        if (!tab?.engine) {
            return;
        }
        fireAndForget(async () => {
            const route = await this.askBrowser(() => browserActivate(tab.engine, tab.url));
            if (route.engine === EngineApp) {
                this.showNotice(fallbackReason(route));
            }
        });
    }

    reopenInBrowser(id: string, url?: string): void {
        const tab = this.findTab(id);
        if (!tab?.engine) {
            return;
        }
        const page = url || tab.url;
        fireAndForget(async () => {
            const route = await this.askBrowser(() => browserOpen(page, tab.engine));
            if (route.engine === EngineApp) {
                this.openHere(id, page);
                this.showNotice(fallbackNotice(route));
                return;
            }
            this.setState(updateTab(this.state(), id, { url: page }));
        });
    }

    openHere(id: string, url?: string): void {
        let next = setTabEngine(this.state(), id, EngineApp);
        if (url) {
            next = updateTab(next, id, { url });
        }
        this.setState(activateTab(next, id));
    }

    // The per-site choice for the page (FR-BRW-002): "always in <browser>" records the page's site; turning it off
    // removes the entry that matched, which may be a parent domain.
    toggleSiteChoice(url: string): void {
        const sites = globalStore.get(getSettingsKeyAtom("browser:sites"));
        const current = siteEngine(sites, url);
        const chosen = this.engines.chosen();
        fireAndForget(async () => {
            try {
                if (current.engine !== "" && current.engine !== EngineApp) {
                    await browserSetSite(current.site, "");
                    return;
                }
                const site = siteOf(url);
                if (site == null || chosen == null) {
                    return;
                }
                await browserSetSite(site, chosen.id === "custom" ? EngineInstalled : chosen.id);
            } catch (e) {
                this.showNotice(t("browser.notice.siteChoiceNotSaved", { error: String(e) }));
            }
        });
    }

    showEngineMenu(e: React.MouseEvent, tab: BrowserTab): void {
        const list = globalStore.get(this.engines.listAtom);
        const chosen = list?.chosen;
        if (tab == null || chosen == null) {
            return;
        }
        const name = tab.engine ? engineName(tab.engine, list) : chosen.name;
        const sites = globalStore.get(getSettingsKeyAtom("browser:sites"));
        const routed = siteEngine(sites, tab.url);
        const site = routed.site || siteOf(tab.url);
        const menu: ContextMenuItem[] = tab.engine
            ? [
                  {
                      label: t("browser.menu.bringForward", { browser: name }),
                      icon: "eye",
                      click: () => this.bringForward(tab.id),
                  },
                  {
                      label: t("browser.menu.reopenIn", { browser: name }),
                      icon: "rotate-right",
                      click: () => this.reopenInBrowser(tab.id),
                  },
                  { label: t("browser.menu.openHere"), icon: "window-maximize", click: () => this.openHere(tab.id) },
              ]
            : [
                  {
                      label: t("browser.choice.openIn", { browser: name }),
                      icon: "arrow-up-right-from-square",
                      click: () => fireAndForget(() => this.handOffTab(tab.id)),
                  },
              ];
        // The site's choices under its name (FR-SHELL-054): the heading says which site they are about.
        if (site != null) {
            const always = routed.engine !== "" && routed.engine !== EngineApp;
            menu.push({
                label: t("browser.menu.alwaysOpenIn", {
                    browser: always ? engineName(routed.engine, list) : chosen.name,
                }),
                type: "checkbox",
                checked: always,
                icon: "thumbtack",
                section: site,
                click: () => {
                    this.toggleSiteChoice(tab.url);
                    if (!always && !tab.engine) {
                        fireAndForget(() => this.handOffTab(tab.id));
                    }
                },
            });
        }
        menu.push(...this.agentSiteMenu(tab));
        ContextMenuModel.getInstance().showContextMenu(menu, e);
    }

    // The agents' decision for the page's site (FR-BRW-009 AC3), with Forget: the next agent action there asks again.
    // The decision is the row's sublabel, under the site's heading: a menu has no inert rows (FR-SHELL-054).
    agentSiteMenu(tab: BrowserTab): ContextMenuItem[] {
        const decided = agentSiteDecision(globalStore.get(getSettingsKeyAtom("browser:agentsites")), tab?.url);
        if (decided == null) {
            return [];
        }

        return [
            {
                label: t("browser.menu.forgetDecision"),
                sublabel: t(decided.decision === "block" ? "browser.menu.agentsBlocked" : "browser.menu.agentsAllowed"),
                icon: "robot",
                section: decided.site,
                click: () =>
                    fireAndForget(async () => {
                        try {
                            await setAgentSite(decided.site, "");
                        } catch (err) {
                            this.showNotice(t("browser.notice.decisionNotForgotten", { error: String(err) }));
                        }
                    }),
            },
        ];
    }

    showAgentSiteMenu(e: React.MouseEvent, tab: BrowserTab): void {
        const menu = this.agentSiteMenu(tab);
        if (menu.length === 0) {
            return;
        }
        ContextMenuModel.getInstance().showContextMenu(menu, e);
    }

    showLinkMenu(url: string, event?: React.MouseEvent): void {
        const chosen = this.engines.chosen();
        const menu: ContextMenuItem[] = [];
        // A page's link to a file or a data: page never becomes a tab (#663); Copy link address still works.
        if (pageOpenTarget(url) === WindowOpenTab) {
            menu.push({ label: t("browser.menu.openLinkNewTab"), icon: "plus", click: () => this.newTab(url) });
        }
        if (chosen != null && siteOf(url) != null) {
            menu.push({
                label: t("browser.menu.openLinkIn", { browser: chosen.name }),
                icon: "arrow-up-right-from-square",
                click: () => fireAndForget(() => this.handOffLink(url)),
            });
        }
        menu.push({
            label: t("browser.menu.copyLinkAddress"),
            icon: "link",
            click: () => fireAndForget(() => navigator.clipboard.writeText(url)),
        });
        menu.push(...splitMenuItems(this.blockId));
        // The webview's event carries no React event: the menu opens at the pointer anyway.
        ContextMenuModel.getInstance().showContextMenu(
            menu,
            event ?? ({ stopPropagation: () => {} } as React.MouseEvent)
        );
    }

    showPageMenu(): void {
        ContextMenuModel.getInstance().showContextMenu(splitMenuItems(this.blockId), {
            stopPropagation: () => {},
        } as React.MouseEvent);
    }

    initialState(): BrowserState {
        const blockAtom = makeBlockAtom(this.blockId);
        const meta = globalStore.get(blockAtom)?.meta ?? {};
        const defaultUrl = globalStore.get(getSettingsKeyAtom("web:defaulturl")) || FallbackUrl;
        return readBrowserState(meta, defaultUrl);
    }

    get viewComponent(): ViewComponent {
        return BrowserView;
    }

    state(): BrowserState {
        return globalStore.get(this.stateAtom);
    }

    setState(next: BrowserState): void {
        if (next === this.state()) {
            return;
        }
        globalStore.set(this.stateAtom, next);
        if (this.persistTimer != null) {
            clearTimeout(this.persistTimer);
        }
        this.persistTimer = setTimeout(() => this.persistNow(), PersistDelayMs);
    }

    persistNow(): void {
        if (this.persistTimer != null) {
            clearTimeout(this.persistTimer);
        }
        this.persistTimer = null;
        fireAndForget(() =>
            RpcApi.SetMetaCommand(TabRpcClient, {
                oref: makeORef("block", this.blockId),
                meta: browserMeta(this.state()),
            })
        );
    }

    toggleMagnify(): void {
        this.nodeModel.toggleMagnify();
        setTimeout(() => refocusNode(this.blockId), 50);
    }

    // The browser draws its own header: a right-click on its empty part opens the command panel at the pointer, as a
    // block header does (FR-SHELL-047), with the Browser sections of FR-SHELL-051 (command-panel/providers/browser.ts).
    showPanelMenu(e: React.MouseEvent): void {
        openHeaderCommandPanel(e, this.blockId);
    }

    activeWebview(): WebviewTag {
        return this.webviews.get(this.state().activeId);
    }

    // The Reload button and Cmd+R act on the shown tab: Stop while it loads, else reload (ignoring the cache with
    // Shift+click or Cmd+Shift+R).
    reloadActive(ignoreCache: boolean): void {
        const id = this.state().activeId;
        if (this.errors.error(id) != null && !this.loads.isLoading(id)) {
            this.retryTab(id);
            return;
        }
        runReload(this.webviews.get(id), reloadAction(this.loads.isLoading(id), ignoreCache));
    }

    // ⌘T in the page and "Open link in new tab": a page beside this panel (#1187).
    newTab(url?: string): void {
        const defaultUrl = globalStore.get(getSettingsKeyAtom("web:defaulturl")) || FallbackUrl;
        this.openBeside(url || defaultUrl);
    }

    // A link opened elsewhere in the app (#140): a page beside this panel, which takes the focus. askSite: the page
    // asks which engine the site uses (FR-BRW-006); it loads meanwhile.
    openUrlInNewTab(url: string, askSite?: string, notice?: string): void {
        this.openBeside(url, { ask: !!askSite, notice });
    }

    // A launch that replaced the version this tab shows (#1005): the tab loads the new one, is shown and focused.
    // A tab that never mounted its page loads tab.url when shown, so the state carries the URL too.
    showUrlInTab(id: string, url: string): void {
        if (this.findTab(id) == null) {
            return;
        }
        const webview = this.webviews.get(id);
        if (webview != null) {
            if (this.errors.error(id) != null) {
                this.errors.noteRetry(id);
            }
            webview.loadURL(url).catch(() => {
                // A failure arrives as did-fail-load and shows the error page.
            });
        }
        this.setState(activateTab(updateTab(this.state(), id, { url, title: undefined }), id));
        this.focusPanel();
    }

    focusPanel(): void {
        this.nodeModel.focusNode();
        // The new tab's webview mounts after this render; focus it once it exists.
        setTimeout(() => refocusNode(this.blockId), 50);
    }

    // Pages wsh queues for this panel (BrowserOpenKeyPrefix), opened as tabs in queue order. Only the entries read
    // here leave the queue, so a page wsh adds meanwhile is kept; ids already opened are skipped until their removal
    // comes back. A page from BROWSER (FR-BRW-007) may ask for its site's engine and leaves the focus where it is.
    handleOpenRequests(meta: Record<string, any>): void {
        const requests = readOpenRequests(meta);
        if (requests.length === 0) {
            return;
        }
        const fresh = requests.filter((r) => !this.handledOpenIds.has(r.id));
        for (const request of fresh) {
            this.handledOpenIds.add(request.id);
        }
        fireAndForget(() =>
            RpcApi.SetMetaCommand(TabRpcClient, {
                oref: makeORef("block", this.blockId),
                meta: consumeOpenRequestsMeta(requests) as MetaType,
            })
        );
        // Each page becomes a panel beside this one (#1187), in queue order; a handed-off page is in its browser
        // already. An agent's tab keeps its id and leaves the focus where the user is (the agent's terminal).
        const pages = fresh.filter((r) => !r.engine);
        const focusLast = pages.some((r) => !r.keepFocus && !r.agent);
        fireAndForget(async () => {
            let after = this.blockId;
            for (const [i, request] of pages.entries()) {
                const focused = focusLast && i === pages.length - 1;
                const def = request.agent
                    ? besideBlockDef({ id: request.tabId, url: request.url })
                    : besideBlockDef(
                          { url: request.url },
                          { ask: request.ask && siteOf(request.url) != null, keepFocus: request.keepFocus }
                      );
                after = (await this.createBeside(def, after, focused)) ?? after;
            }
        });
    }

    // Tabs an agent closes (tabs_close); the panel closes with its last tab, as Cmd+W does.
    handleCloseRequests(meta: Record<string, any>): void {
        const requests = readCloseRequests(meta);
        if (requests.length === 0) {
            return;
        }
        for (const request of requests.filter((r) => !this.handledCloseIds.has(r.id))) {
            this.handledCloseIds.add(request.id);
            // Only an agent's tab closes this way: any terminal can write block meta.
            if (!isAgentTabId(request.tabId) || this.findTab(request.tabId) == null) {
                continue;
            }
            if (this.state().tabs.length <= 1) {
                uxCloseBlock(this.blockId);
                return;
            }
            this.closeTab(request.tabId);
        }
        fireAndForget(() =>
            RpcApi.SetMetaCommand(TabRpcClient, {
                oref: makeORef("block", this.blockId),
                meta: consumeCloseRequestsMeta(requests) as MetaType,
            })
        );
    }

    closeTab(id: string): void {
        this.webviews.delete(id);
        this.lifecycle.forget(id);
        this.signIn.forget(id);
        this.sitePermissions.forgetTab(id);
        this.loads.forget(id);
        this.errors.forget(id);
        this.choices.forget(id);
        this.setState(closeTab(this.state(), id));
    }

    closeOtherTabs(id: string): void {
        if (this.findTab(id) == null) {
            return;
        }
        for (const tab of this.state().tabs.filter((t) => t.id !== id)) {
            this.closeTab(tab.id);
        }
        this.setState(activateTab(this.state(), id));
    }

    // The copy opens in a panel to the right (#1187).
    duplicateTab(id: string): void {
        const tab = this.findTab(id);
        if (tab == null) {
            return;
        }
        fireAndForget(() =>
            this.createBeside(besideBlockDef({ id: makeTabId(), url: tab.url, engine: tab.engine }), this.blockId, true)
        );
    }

    copyTabLink(id: string): void {
        const url = this.findTab(id)?.url;
        if (url) {
            fireAndForget(() => navigator.clipboard.writeText(url));
        }
    }

    reloadTab(id: string): void {
        if (this.errors.error(id) != null) {
            this.retryTab(id);
            return;
        }
        runReload(this.webviews.get(id), reloadAction(false, false));
    }

    // Retry loads the failed URL again: after a failure the webview holds Chromium's error document, whose reload
    // would not go back to the page.
    retryTab(id: string): void {
        const error = this.errors.error(id);
        const webview = this.webviews.get(id);
        if (error == null || webview == null) {
            return;
        }
        this.errors.noteRetry(id);
        webview.loadURL(error.url).catch(() => {
            // The failure itself arrives as did-fail-load and redraws the error page.
        });
    }

    // "Start the dev server…" of a local page's error: a panel opens below this one on the picker, where Terminal
    // starts a shell in the workspace folder.
    startDevServer(): void {
        fireAndForget(() => splitPanel(this.blockId, "down"));
    }

    showTabMenu(e: React.MouseEvent, tab: BrowserTab): void {
        e.preventDefault();
        fireAndForget(async () => {
            const share = await this.shareItems(tab);
            const menu = browserTabMenu(
                this.state(),
                tab,
                {
                    reloadTab: (id) => this.reloadTab(id),
                    duplicateTab: (id) => this.duplicateTab(id),
                    copyTabLink: (id) => this.copyTabLink(id),
                    closeTab: (id) => this.closeTab(id),
                    closeOtherTabs: (id) => this.closeOtherTabs(id),
                },
                share
            );
            ContextMenuModel.getInstance().showContextMenu(menu, e);
        });
    }

    // The toolbar's Share with agent button opens the same entries as the tab menu (FR-BRW-011 AC1).
    showShareMenu(e: React.MouseEvent, tab: BrowserTab): void {
        e.preventDefault();
        fireAndForget(async () => {
            const menu = await this.shareItems(tab);
            ContextMenuModel.getInstance().showContextMenu(menu, e);
        });
    }

    // The agents of this panel's tab (the agent states the companion and the command panel read) joined with the agents
    // connected to MoltenTerm's browser, read when a menu opens.
    async loadShareAgents(): Promise<ShareAgent[]> {
        let sessions: AgentSession[] = [];
        try {
            sessions = await this.agents.listSessions();
        } catch (e) {
            console.log("browser share: no agent sessions", e);
        }
        const tabBlockIds = globalStore.get(this.tabBlockIdsAtom);
        sessions = ofTab(sessions, tabBlockIds);
        const workspaceId = globalStore.get(atoms.workspace)?.oid;
        const states = ofTab(
            agentStatesOfWorkspace(globalStore.get(AgentStates.getInstance().dataAtom), workspaceId),
            tabBlockIds
        );
        const blockIds = [...new Set([...states.map((s) => s.blockid), ...sessions.map((s) => s.blockid)])];
        const metas = new Map<string, MetaType>();
        await Promise.all(
            blockIds.map(async (id) => {
                try {
                    metas.set(id, (await WOS.loadAndPinWaveObject<Block>(makeORef("block", id)))?.meta);
                } catch {
                    // A pane that just closed has no title.
                }
            })
        );
        let runs: AgentIntegrationRun[] = [];
        if (states.length > 0 && states.some((s) => !sessions.some((x) => x.blockid === s.blockid))) {
            try {
                runs = await loadIntegrationRuns();
            } catch (e) {
                console.log("browser share: no integration runs", e);
            }
        }
        const settings = globalStore.get(atoms.settingsAtom) as Record<string, unknown>;
        return shareAgents(states, sessions, (id) => panelTitle(metas.get(id) as PanelMeta), { runs, settings });
    }

    async shareItems(tab: BrowserTab): Promise<ContextMenuItem[]> {
        if (tab == null) {
            return [];
        }
        const agents = tab.engine ? [] : await this.loadShareAgents();
        const engineLabel = tab.engine ? engineName(tab.engine, globalStore.get(this.engines.listAtom)) : "";
        return shareMenuItems(tab, this.agents.tabs()[tab.id] ?? null, agents, engineLabel, {
            share: (agent, tell) => this.shareTab(tab.id, agent, tell, false),
            stopSharing: () => this.controlAgent(tab.id, "stop"),
            openAgentSettings: () => fireAndForget(() => openSettingsSection("agents")),
        });
    }

    // Sharing a tab another agent holds asks first (AC5); Share and tell then types the line wavesrv builds (AC6).
    shareTab(id: string, agent: ShareAgent, tell: boolean, move: boolean): void {
        fireAndForget(async () => {
            let res: ShareResult;
            try {
                res = await this.agents.share(id, agent.sessionId, move);
            } catch (e) {
                this.showNotice(t("browser.notice.shareFailed", { error: errorText(e) }));
                return;
            }
            if (res?.result === "move") {
                const holder = res.holder || t("browser.share.anotherAgent");
                const question = moveQuestion(holder, agent.agentName);
                showToast({
                    id: `molten-share-move-${this.blockId}-${id}`,
                    kind: "info",
                    title: question.title,
                    message: question.message,
                    stays: true,
                    actions: [
                        { id: "move", label: t("browser.share.move"), run: () => this.shareTab(id, agent, tell, true) },
                        { id: "keep", label: t("browser.share.keepWith", { holder }), run: () => {} },
                    ],
                });
                return;
            }
            if (tell) {
                await this.tellAgent(id, agent);
            }
        });
    }

    async tellAgent(id: string, agent: ShareAgent): Promise<void> {
        try {
            const res = await this.agents.shareTell(id);
            showToast({
                kind: res?.sent ? "info" : "warning",
                title: t(res?.sent ? "browser.share.shared" : "browser.share.sharedNothingTyped", {
                    name: agent.agentName,
                }),
                message: serverText(res?.messagetext, res?.message ?? ""),
            });
        } catch (e) {
            this.showNotice(t("browser.notice.tellFailed", { error: errorText(e) }));
        }
    }

    showTab(id: string): void {
        this.setState(activateTab(this.state(), id));
    }

    // A <webview> throws before its first dom-ready: the page has no zoom to show yet.
    zoomPercent(): number {
        try {
            const factor = this.activeWebview()?.getZoomFactor();
            return typeof factor === "number" && factor > 0 ? Math.round(factor * 100) : null;
        } catch {
            return null;
        }
    }

    setZoom(percent: number): void {
        try {
            this.activeWebview()?.setZoomFactor(Math.max(0.3, Math.min(3, percent / 100)));
        } catch (e) {
            console.log("browser zoom failed", e);
        }
    }

    // "Open externally" hands the page off to the installed browser (it becomes a handed-off entry). Without one the
    // panel offers nothing: links reach the OS browser only through openLink (link-choice.ts, DS-BRW-006).
    openExternally(id: string): void {
        fireAndForget(() => this.handOffTab(id));
    }

    setEngine(id: string, engine: string): void {
        const tab = this.findTab(id);
        if (tab == null || (tab.engine || EngineApp) === engine) {
            return;
        }
        if (tab.engine) {
            this.openHere(id);
        }
        if (engine !== EngineApp) {
            fireAndForget(() => this.handOffTab(id, engine));
        }
    }

    forgetAgentSite(site: string): void {
        fireAndForget(async () => {
            try {
                await setAgentSite(site, "");
            } catch (err) {
                this.showNotice(t("browser.notice.decisionNotForgotten", { error: String(err) }));
            }
        });
    }

    controlAgent(browserTabId: string, action: AgentControlAction): void {
        this.agents.control(browserTabId, action);
    }

    openPageDevTools(): void {
        try {
            this.activeWebview()?.openDevTools();
        } catch (e) {
            console.log("browser devtools failed", e);
        }
    }

    // What the command panel's Browser sections read (command-panel/providers/browser.ts).
    commandState(): BrowserCommandState {
        const state = this.state();
        const tab = this.findTab(state.activeId);
        if (tab == null) {
            return null;
        }
        const agentTabs = this.agents.tabs();
        const shownAgent = controlBarView(agentTabs[tab.id]) != null ? agentTabs[tab.id] : null;
        const agentTab =
            shownAgent ?? state.tabs.map((t) => agentTabs[t.id]).find((a) => controlBarView(a) != null) ?? null;
        const sites = globalStore.get(getSettingsKeyAtom("browser:sites"));
        const routed = siteEngine(sites, tab.url);
        return {
            tab,
            tabCount: state.tabs.length,
            zoom: tab.engine ? null : this.zoomPercent(),
            list: globalStore.get(this.engines.listAtom),
            site: siteOf(tab.url),
            routed: { site: routed.site || siteOf(tab.url), engine: routed.engine },
            agentDecision: agentSiteDecision(globalStore.get(getSettingsKeyAtom("browser:agentsites")), tab.url),
            agentTab,
            agentView: agentTab ? controlBarView(agentTab) : null,
            agentTabShown: agentTab != null && agentTab === shownAgent,
        };
    }

    giveFocus(): boolean {
        // The engine choice's primary button holds the focus while the bar is up (DS-BRW-007).
        const primary = this.choices.primaryRef.current;
        if (primary != null && this.choices.visible(this.state().activeId, globalStore.get(this.engines.listAtom))) {
            primary.focus();
            return true;
        }
        const webview = this.activeWebview();
        if (webview == null) {
            return false;
        }
        webview.focus();
        return true;
    }

    // Cmd+T opens a tab and Cmd+W closes the active one; with one tab left, Cmd+W goes to Wave, which closes the panel.
    keyDownHandler(e: WaveKeyboardEvent): boolean {
        if (checkKeyPressed(e, "Cmd:t")) {
            this.newTab();
            return true;
        }
        if (checkKeyPressed(e, "Cmd:w") && this.state().tabs.length > 1) {
            this.closeTab(this.state().activeId);
            return true;
        }
        if (checkKeyPressed(e, "Cmd:Shift:r")) {
            this.reloadActive(true);
            return true;
        }
        if (checkKeyPressed(e, "Cmd:r")) {
            this.reloadActive(false);
            return true;
        }
        if (checkKeyPressed(e, "Cmd:l")) {
            this.urlInputRef.current?.focus();
            this.urlInputRef.current?.select();
            return true;
        }
        return false;
    }

    // Whether a tab's page is on screen: the panel's active tab, in a tab view that shows.
    isTabShown(id: string): boolean {
        return this.state().activeId === id && isShowing(TabActivity.getInstance().state());
    }

    // A tab shared with an agent stays loaded before the agent acts on it, so the agent finds its page.
    isAgentDriven(id: string): boolean {
        return this.agents.tabs()[id] != null;
    }

    // The main process asks to drop a hidden page (#459); the panel checks again that the page is the same one and
    // still hidden, and that no agent took it meanwhile.
    discardTab(id: string, webContentsId: number, scroll: PageScroll): void {
        const webview = this.webviews.get(id);
        let current: number = null;
        try {
            current = webview?.getWebContentsId();
        } catch {
            return;
        }
        // A panel off-screen on the carpet is never unloaded (#618).
        if (current !== webContentsId || this.isTabShown(id) || this.isAgentDriven(id) || isOffCarpet(this.blockId)) {
            return;
        }
        this.lifecycle.discard(id, scroll);
    }

    dispose(): void {
        if (this.persistTimer != null) {
            clearTimeout(this.persistTimer);
        }
        this.lifecycle.dispose();
        this.agents.dispose();
    }
}

function errorText(e: unknown): string {
    return serverErrorText(e);
}

function makeBlockAtom(blockId: string): Atom<Block> {
    return WOS.getWaveObjectAtom<Block>(makeORef("block", blockId));
}

function TabWebview({
    model,
    tab,
    active,
    shown,
    offCarpet,
}: {
    model: BrowserViewModel;
    tab: BrowserTab;
    active: boolean;
    shown: boolean;
    offCarpet: boolean;
}) {
    const ref = useRef<WebviewTag>(null);
    const shownRef = useRef(shown);
    shownRef.current = shown;
    const offCarpetRef = useRef(offCarpet);
    offCarpetRef.current = offCarpet;
    // The main process freezes and discards hidden pages (#459), and never discards one off-screen on the carpet
    // (#618); a webview throws before its first dom-ready, which reports it then.
    useEffect(() => {
        try {
            reportWebviewShown(model.blockId, tab.id, ref.current?.getWebContentsId(), shown, offCarpet);
        } catch {
            // not attached yet: dom-ready reports it
        }
    }, [model, tab.id, shown, offCarpet]);
    // In 360 view, the page hands its horizontal scroll to the carpet (#676).
    useEffect(() => {
        const webview = ref.current;
        if (webview == null) {
            return;
        }
        return attachCarpetWheel(webview, model.blockId);
    }, [model, tab.id]);
    // A sideways wheel the page cannot use may swipe workspaces (FR-SHELL-082, #1248).
    useEffect(() => {
        const webview = ref.current;
        if (webview == null) {
            return;
        }
        return attachSwipeWheel(webview);
    }, [tab.id]);
    // The src is set once: later navigation happens inside the page, and re-rendering with a new src would reload it.
    const [initialUrl] = useState(tab.url);
    // MOLTENTERM-PATCH (#371): hidden mounted tabs are never valid edit/image targets.
    useEffect(() => {
        try {
            const guestId = ref.current?.getWebContentsId();
            getApi().setContextMenuGuest?.(guestId, active);
            const session = ContextMenuModel.getInstance().session;
            if (!active && (session?.event as any)?.contextMenuGuestId === guestId) session?.cancel();
        } catch {}
    }, [active]);
    useEffect(() => {
        const webview = ref.current;
        if (webview == null) {
            return;
        }
        model.webviews.set(tab.id, webview);
        const onNavigate = (e: any) => {
            // Chromium's own error document must not replace the failed URL in the address bar (FR-SHELL-051).
            if (e.isMainFrame === false || /^chrome-error:/i.test(e.url ?? "")) {
                return;
            }
            model.setState(updateTab(model.state(), tab.id, { url: e.url }));
            model.signIn.noteNavigation(tab.id, e.url);
            // In-page navigations (anchors, history.pushState on load) do not count as moving on.
            if (e.type === "did-navigate") {
                model.choices.noteNavigation(tab.id);
                // A page without a favicon would keep the previous site's.
                model.loads.update(tab.id, { favicon: undefined });
            }
        };
        // A popup this tab opened was refused by its sign-in provider (emain/moltenterm-popups.ts closed it).
        const onSignInRefused = (e: any) => model.signIn.notePopupRefused(tab.id, e.detail, webview.getURL());
        // A page asks for the camera, the microphone, the location or notifications (emain/moltenterm-site-permissions.ts,
        // #663); handling the event tells the preload the panel shows the question.
        const onSitePermission = (e: any) => {
            if (!isSiteAsk(e.detail)) return;
            e.preventDefault();
            model.sitePermissions.add(tab.id, e.detail);
        };
        const onSitePermissionDone = (e: any) => model.sitePermissions.remove(e.detail?.requestid);
        const onTitle = (e: any) => model.setState(updateTab(model.state(), tab.id, { title: e.title }));
        // emain turns window.open and target=_blank into this event (emain/preload.ts dispatches it to this webview).
        const onNewWindow = (e: any) => {
            e.preventDefault?.();
            const url = e.detail?.url;
            if (url) {
                model.openLink(url);
            }
        };
        // MOLTENTERM-PATCH (#371): one guest request, filtered against the active inner browser tab.
        const removeContextMenu = getApi().onGuestContextMenu?.((params) => {
            if (params.guestId !== webview.getWebContentsId() || model.state().activeId !== tab.id) return;
            const event = guestMenuEvent(params, webview);
            if (params.linkURL && !params.imageToken && !params.editable && !params.selectionText) {
                model.showLinkMenu(params.linkURL, event);
                return;
            }
            const menu = guestEditMenu(params, (token) => getApi().saveContextMenuImage(token));
            if (menu.length) menu.push({ type: "separator" });
            menu.push(...splitMenuItems(model.blockId));
            ContextMenuModel.getInstance().showContextMenu(menu, event);
        });
        const onFocus = (e: FocusEvent) => {
            if (keepUserFocus(webview.getWebContentsId(), webview, e.relatedTarget as HTMLElement)) {
                return;
            }
            getApi().setWebviewFocus(webview.getWebContentsId());
            model.nodeModel.focusNode();
        };
        const onBlur = () => getApi().setWebviewFocus(null);
        const onStartLoading = () => {
            model.loads.noteStart(tab.id);
            model.errors.noteStart(tab.id);
        };
        const onStopLoading = () => {
            model.loads.noteStop(tab.id);
            model.errors.noteStop(tab.id);
        };
        const onFailLoad = (e: any) => {
            if (!isPageFailure(e)) {
                return;
            }
            model.lifecycle.finishRestoring(tab.id);
            const url = e.validatedURL || webview.getURL();
            model.errors.noteFailure(tab.id, { url, code: e.errorCode, description: e.errorDescription });
            if (url && !/^chrome-error:/i.test(url)) {
                // The previous page's title would name the tab otherwise: the host stands in for it.
                model.setState(updateTab(model.state(), tab.id, { url, title: undefined }));
            }
        };
        const onFavicon = (e: any) => model.loads.noteFavicons(tab.id, e.favicons);
        // emain/preload.ts routes a page's new window by this attribute; the preload cannot call the element's methods.
        let offHeld: () => void = null;
        const onDomReady = () => {
            webview.dataset.webcontentsid = String(webview.getWebContentsId());
            offHeld?.();
            offHeld = onInputHeld(webview.getWebContentsId(), () => model.agents.noteHeldInput(tab.id));
            registerWebview(model.blockId, tab.id, webview.getWebContentsId());
            getApi().setContextMenuGuest?.(webview.getWebContentsId(), model.state().activeId === tab.id);
            reportWebviewShown(
                model.blockId,
                tab.id,
                webview.getWebContentsId(),
                shownRef.current,
                offCarpetRef.current
            );
        };
        // A page reloaded after a discard gets its scroll position back once loaded.
        const onFinishLoad = () => {
            const scroll = model.lifecycle.finishRestoring(tab.id);
            if (scroll != null && (scroll.x > 0 || scroll.y > 0)) {
                webview.executeJavaScript(scrollScript(scroll)).catch(() => {});
            }
        };
        const onVisibility = () => {
            try {
                getApi().setContextMenuGuest?.(webview.getWebContentsId(), model.state().activeId === tab.id);
            } catch {}
        };
        document.addEventListener("visibilitychange", onVisibility);
        webview.addEventListener("did-navigate", onNavigate);
        webview.addEventListener("did-navigate-in-page", onNavigate);
        webview.addEventListener("page-title-updated", onTitle);
        webview.addEventListener("new-window", onNewWindow);
        webview.addEventListener("moltenterm-signin-refused", onSignInRefused);
        webview.addEventListener("moltenterm-site-permission", onSitePermission);
        window.addEventListener("moltenterm-site-permission-done", onSitePermissionDone);
        webview.addEventListener("focus", onFocus);
        webview.addEventListener("blur", onBlur);
        webview.addEventListener("dom-ready", onDomReady);
        webview.addEventListener("did-finish-load", onFinishLoad);

        webview.addEventListener("did-start-loading", onStartLoading);
        webview.addEventListener("did-stop-loading", onStopLoading);
        webview.addEventListener("did-fail-load", onFailLoad);
        webview.addEventListener("page-favicon-updated", onFavicon);
        return () => {
            offHeld?.();
            webview.removeEventListener("did-start-loading", onStartLoading);
            webview.removeEventListener("did-stop-loading", onStopLoading);
            webview.removeEventListener("did-fail-load", onFailLoad);
            webview.removeEventListener("page-favicon-updated", onFavicon);
            document.removeEventListener("visibilitychange", onVisibility);
            removeContextMenu?.();
            const session = ContextMenuModel.getInstance().session;
            if (session?.event.target === webview) session.cancel();
            try {
                getApi().setContextMenuGuest?.(webview.getWebContentsId(), false);
            } catch {}
            webview.removeEventListener("did-navigate", onNavigate);
            webview.removeEventListener("did-navigate-in-page", onNavigate);
            webview.removeEventListener("page-title-updated", onTitle);
            webview.removeEventListener("new-window", onNewWindow);
            webview.removeEventListener("moltenterm-signin-refused", onSignInRefused);
            webview.removeEventListener("moltenterm-site-permission", onSitePermission);
            window.removeEventListener("moltenterm-site-permission-done", onSitePermissionDone);
            webview.removeEventListener("focus", onFocus);
            webview.removeEventListener("blur", onBlur);
            webview.removeEventListener("dom-ready", onDomReady);
            webview.removeEventListener("did-finish-load", onFinishLoad);
            if (model.webviews.get(tab.id) === webview) {
                model.webviews.delete(tab.id);
                model.loads.noteStop(tab.id);
            }
        };
    }, [model, tab.id]);
    return (
        <webview
            ref={ref as any}
            src={initialUrl}
            data-blockid={model.blockId}
            data-browsertab={tab.id}
            preload={webviewPreloadUrl()}
            // @ts-expect-error React types allowpopups as a boolean, Chromium's webview tag expects a string.
            allowpopups="true"
            className={cn("molten-browser-page absolute inset-0 h-full w-full", !active && "invisible pointer-events-none")}
        />
    );
}

// A page an agent controls carries its mark in the panel's row.
function AgentTabMarker({ model, agentTabs, tabId }: { model: BrowserViewModel; agentTabs: AgentTabs; tabId: string }) {
    useLocale();
    const agentTab = agentTabs[tabId];
    if (isSharedTab(agentTab)) {
        return <SharedTabBadge model={model} agentTab={agentTab} tabId={tabId} />;
    }
    const view = controlBarView(agentTab);
    if (view == null) {
        return null;
    }
    const asking = permissionBarView(agentTab);
    if (asking != null) {
        return (
            <i
                role="img"
                aria-label={asking.title}
                title={asking.title}
                className="fa fa-solid fa-circle-question shrink-0 text-11 text-[var(--mt-state-waiting)]"
            />
        );
    }
    return (
        <i
            role="img"
            aria-label={view.title}
            title={view.title}
            className={cn("fa fa-solid fa-robot shrink-0 text-11", view.takenOver ? "text-secondary" : "text-accent")}
        />
    );
}

// A tab the user shared carries a calm badge with the agent's name (FR-BRW-011 AC3); a click on it stops sharing (AC4).
function SharedTabBadge({ model, agentTab, tabId }: { model: BrowserViewModel; agentTab: AgentTab; tabId: string }) {
    const t = useT();
    const name = agentName(agentTab);
    const asking = permissionBarView(agentTab);
    return (
        <>
            {asking != null ? (
                <i
                    role="img"
                    aria-label={asking.title}
                    title={asking.title}
                    className="fa fa-solid fa-circle-question shrink-0 text-11 text-[var(--mt-state-waiting)]"
                />
            ) : null}
            <Pill
                label={name}
                icon="share-nodes"
                title={t("browser.share.badgeTitle", { name })}
                className="molten-browser-share-badge"
                testId="browser-share-badge"
                onClick={() => model.controlAgent(tabId, "stop")}
            />
        </>
    );
}

// A tab's favicon, or the falling dominoes in the working colour while its page loads; a page that failed shows a warning.
function TabIcon({ load, failed }: { load: TabLoad; failed: boolean }) {
    const t = useT();
    const [broken, setBroken] = useState<string>(null);
    if (load?.loading) {
        return (
            <span
                role="progressbar"
                aria-label={t("browser.tabs.loading")}
                className="molten-browser-tab-icon flex items-center justify-center"
            >
                <DominoLoader className="mt-dominos-icon text-[var(--mt-state-working)]" />
            </span>
        );
    }
    if (failed) {
        return (
            <i
                aria-label={t("browser.tabs.failed")}
                className="fa fa-solid fa-triangle-exclamation molten-browser-tab-icon"
            />
        );
    }
    if (load?.favicon == null || broken === load.favicon) {
        return <i className="fa fa-solid fa-globe molten-browser-tab-icon" />;
    }
    return (
        <img
            src={load.favicon}
            alt=""
            draggable={false}
            onError={() => setBroken(load.favicon)}
            className="molten-browser-tab-icon object-contain"
        />
    );
}

// The header's end buttons (DS-SHELL-092): the command panel trigger, magnify and close, at full opacity
// (browser.css), as every panel's header draws them.
function BrowserPanelButtons({ model }: { model: BrowserViewModel }) {
    const t = useT();
    const node = model.layoutNode;
    const magnified = useAtomValue(model.nodeModel.isMagnified);
    const ephemeral = useAtomValueSafe(node.isEphemeral);
    const numLeafs = useAtomValueSafe(node.numLeafs) ?? 1;
    const addToLayout: IconButtonDecl = {
        elemtype: "iconbutton",
        icon: "circle-plus",
        title: t("browser.panel.addToLayout"),
        click: () => node.addEphemeralNodeToLayout?.(),
    };
    const commands: IconButtonDecl = {
        elemtype: "iconbutton",
        icon: "sliders",
        title: t("browser.panel.commands", { shortcut: formatShortcutById("command-panel") }),
        click: (e) => openCommandPanelFromTrigger(model.blockId, (e.target as Element)?.closest?.("button")),
    };
    // A panel that is not focused keeps only close (FR-SHELL-086): the other buttons fade (moltenterm-shell.css).
    return (
        <div className="molten-browser-panel-buttons flex h-full shrink-0 items-center gap-0.5 px-1.5">
            <span className="mt-focus-only flex items-center gap-0.5">
                <PinHeaderButton blockId={model.blockId} />
                <span data-role="command-panel-trigger" className="flex">
                    <IconButton decl={commands} />
                </span>
                {ephemeral ? (
                    <IconButton decl={addToLayout} />
                ) : (
                    <OptMagnifyButton
                        magnified={magnified}
                        toggleMagnify={() => model.toggleMagnify()}
                        disabled={numLeafs <= 1}
                    />
                )}
            </span>
            <HeaderCloseButton magnified={magnified} onClose={() => uxCloseBlock(model.blockId)} />
        </div>
    );
}

// The page's site in the panel's row (FR-SHELL-083, #1187): its full address shows in the sidebar's top field while
// the panel has the focus, where it is edited (a click or ⌘L). The right click keeps the old tab's menu.
function PageAddress({ model, tab }: { model: BrowserViewModel; tab: BrowserTab }) {
    const t = useT();
    const loads = useAtomValue(model.loads.loadsAtom);
    const errors = useAtomValue(model.errors.errorsAtom);
    const list = useAtomValue(model.engines.listAtom);
    if (tab == null) {
        return null;
    }
    const host = isStartPage(tab.url)
        ? t("browser.start.address")
        : browserTabTitle({ id: tab.id, url: tab.url }) || tab.url;
    const keys = formatShortcutById("top-field");
    return (
        <button
            type="button"
            className="flex h-6 min-w-12 shrink cursor-pointer items-center gap-1.5 rounded-6 px-1.5 text-secondary hover:bg-hover hover:text-primary"
            title={`${addressOfPage(tab.url) || host}\n${t("browser.address.title", { keys })}`}
            aria-label={t("browser.address.label", { address: addressOfPage(tab.url) || host })}
            data-testid="browser-address"
            onClick={() => {
                model.nodeModel.focusNode();
                openTopField();
            }}
            onContextMenu={(e) => {
                e.stopPropagation();
                model.showTabMenu(e, tab);
            }}
        >
            {tab.engine ? (
                <i
                    aria-label={t("browser.tabs.openedIn", { browser: engineName(tab.engine, list) })}
                    className={cn(browserIconClass(tab.engine), "molten-browser-tab-icon text-accent")}
                />
            ) : (
                <TabIcon load={loads[tab.id]} failed={errors[tab.id]?.error != null} />
            )}
            <span className="min-w-0 truncate font-mono text-11">{host}</span>
        </button>
    );
}

function BrowserNavBar({ model, state }: { model: BrowserViewModel; state: BrowserState }) {
    const t = useT();
    const active = state.tabs.find((t) => t.id === state.activeId);
    const [draft, setDraft] = useState(addressOfPage(active?.url));
    const [editing, setEditing] = useState(false);
    const loads = useAtomValue(model.loads.loadsAtom);
    const agentTabs = useAtomValue(model.agents.tabsAtom);
    const topField = useAtomValue(SidebarModel.getInstance().enabledAtom);
    const loading = !active?.engine && !!loads[state.activeId]?.loading;
    useEffect(() => {
        if (!editing) {
            setDraft(addressOfPage(active?.url));
        }
    }, [active?.url, active?.id, editing]);
    const navButton = (
        icon: string,
        label: string,
        run: (e: React.MouseEvent) => void,
        title = label,
        className: string = null
    ) => (
        <button
            type="button"
            aria-label={label}
            title={title}
            onClick={run}
            disabled={!!active?.engine}
            className={cn(
                "flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-6 text-secondary hover:bg-hover hover:text-primary disabled:pointer-events-none disabled:opacity-40",
                className
            )}
        >
            <i className={`fa fa-solid fa-${icon} text-12`} />
        </button>
    );
    return (
        <div className="relative flex h-8 shrink-0 items-center gap-1 border-b border-border px-1 overflow-hidden">
            {navButton(
                "arrow-left",
                t("browser.nav.back"),
                () => model.activeWebview()?.canGoBack() && model.activeWebview().goBack()
            )}
            {navButton(
                "arrow-right",
                t("browser.nav.forward"),
                () => model.activeWebview()?.canGoForward() && model.activeWebview().goForward()
            )}
            {loading
                ? navButton(
                      "xmark",
                      t("browser.nav.stop"),
                      () => model.reloadActive(false),
                      t("browser.nav.stopTitle"),
                      "mt-focus-only"
                  )
                : navButton(
                      "rotate-right",
                      t("browser.nav.reload"),
                      (e) => model.reloadActive(e.shiftKey),
                      t("browser.nav.reloadTitle", { shortcut: "Cmd+R", hardShortcut: "Cmd+Shift+R" }),
                      "mt-focus-only"
                  )}
            <span className="mt-focus-only flex shrink-0 items-center">
                <TestContextChip url={active?.url ?? ""} />
            </span>
            {topField ? (
                <PageAddress model={model} tab={active} />
            ) : (
                // FR-SHELL-086: at rest the address reads centred after a link icon; editing it shows the input as is
                <div className="relative flex h-6 min-w-24 flex-1">
                    <input
                        ref={model.urlInputRef}
                        value={draft}
                        spellCheck={false}
                        onFocus={() => setEditing(true)}
                        onBlur={() => setEditing(false)}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Escape") {
                                setDraft(addressOfPage(active?.url));
                                e.currentTarget.blur();
                                return;
                            }
                            if (e.key !== "Enter") {
                                return;
                            }
                            const url = toBrowserUrl(draft);
                            if (url != null) {
                                model.navigate(url);
                            }
                            e.currentTarget.blur();
                        }}
                        className={cn(
                            "h-6 w-full min-w-0 cursor-text rounded-4 border border-transparent bg-transparent px-2 text-12 text-primary outline-none hover:border-border focus:border-accent",
                            !editing && draft && "text-transparent"
                        )}
                    />
                    {!editing && draft ? (
                        <span
                            aria-hidden
                            data-testid="browser-address-shown"
                            className="pointer-events-none absolute inset-0 flex min-w-0 items-center justify-center gap-1.5 px-2 text-12 text-primary"
                        >
                            <i className="fa fa-solid fa-link shrink-0 text-11 text-muted" />
                            <span className="truncate">{shownAddress(draft)}</span>
                        </span>
                    ) : null}
                </div>
            )}
            {active != null ? <AgentTabMarker model={model} agentTabs={agentTabs} tabId={active.id} /> : null}
            <div
                ref={model.layoutNode.dragHandleRef}
                onContextMenu={(e) => model.showPanelMenu(e)}
                onDoubleClick={() => model.toggleMagnify()}
                className={cn("molten-browser-drag h-full min-w-6", topField && "flex-1")}
            />
            <span className="mt-focus-only flex shrink-0 items-center gap-1">
                <ShareButton model={model} tab={active} />
                <EngineButton model={model} tab={active} />
            </span>
            <BrowserPanelButtons model={model} />
            {loading ? (
                <div
                    role="progressbar"
                    aria-label={t("browser.nav.loadingPage")}
                    className="molten-browser-progress pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden"
                >
                    <div className="molten-browser-progress-bar h-full w-1/3 bg-[var(--mt-state-working)]" />
                </div>
            ) : null}
        </div>
    );
}

// Share with agent in the toolbar (FR-BRW-011 AC1): disabled with its reason when no agent runs in the panel's tab
// (#594) or the page is not in MoltenTerm's engine (AC2, AC8).
function ShareButton({ model, tab }: { model: BrowserViewModel; tab: BrowserTab }) {
    useLocale();
    const agentData = useAtomValue(AgentStates.getInstance().dataAtom);
    const workspace = useAtomValue(atoms.workspace);
    const list = useAtomValue(model.engines.listAtom);
    const sessions = useAtomValue(model.agents.sessionsAtom);
    const tabBlockIds = useAtomValue(model.tabBlockIdsAtom);
    const agentTabs = useAtomValue(model.agents.tabsAtom);
    useEffect(() => {
        model.agents.refreshSessions();
    }, [model, agentData, tabBlockIds]);
    if (tab == null) {
        return null;
    }
    const state = shareStateText(agentTabs[tab.id] ?? null);
    const running = ofTab(agentStatesOfWorkspace(agentData, workspace?.oid), tabBlockIds).filter(
        (s) => s.agent || s.agentname
    );
    const reason = tab.engine
        ? unshareableReason(tab, engineName(tab.engine, list))
        : running.length === 0 && ofTab(sessions, tabBlockIds).length === 0
          ? noAgentReason()
          : "";
    // FR-SHELL-086: with one agent in the tab and the page not shared yet, the button names it ("Share with Valentin").
    const named = !reason && agentTabs[tab.id] == null && running.length === 1 ? agentCallName(running[0], "") : "";
    const label = named ? t("browser.share.shareWith", { name: named }) : shareLabel();
    return (
        <button
            type="button"
            aria-label={label}
            aria-disabled={reason ? true : undefined}
            title={t("browser.share.buttonTitle", { action: reason || label, state })}
            onMouseEnter={() => model.agents.refreshSessions()}
            onClick={(e) => {
                if (!reason) {
                    model.showShareMenu(e, tab);
                }
            }}
            data-testid="browser-share-button"
            className={cn(
                "flex h-6 shrink-0 items-center justify-center gap-1.5 rounded-6 text-secondary",
                named ? "bg-hover px-2 text-12" : "w-6",
                reason ? "opacity-40" : "cursor-pointer hover:bg-hover hover:text-primary"
            )}
        >
            <i className="fa fa-solid fa-share-nodes text-12" />
            {named ? <span className="truncate">{label}</span> : null}
        </button>
    );
}

// "Open in <browser>" (FR-BRW-002): one click hands the page off; the caret holds the per-site choice. Hidden when no
// Chromium browser is installed, and on a handed-off entry, whose page offers the way back.
function EngineButton({ model, tab }: { model: BrowserViewModel; tab: BrowserTab }) {
    const t = useT();
    const list = useAtomValue(model.engines.listAtom);
    const sites = useAtomValue(getSettingsKeyAtom("browser:sites"));
    const agentSites = useAtomValue(getSettingsKeyAtom("browser:agentsites"));
    const chosen = list?.chosen;
    if (chosen == null && tab != null && agentSiteDecision(agentSites, tab.url) != null) {
        return <AgentSiteButton model={model} tab={tab} />;
    }
    if (chosen == null || tab == null || siteOf(tab.url) == null) {
        return null;
    }
    const routed = siteEngine(sites, tab.url);
    const always = routed.engine !== "" && routed.engine !== EngineApp;
    const label = tab.engine ? t("browser.menu.openHere") : t("browser.choice.openIn", { browser: chosen.name });
    return (
        <div className="molten-browser-engine flex h-6 min-w-0 shrink items-center rounded-4 border border-border text-12 text-secondary">
            <button
                type="button"
                title={
                    tab.engine
                        ? t("browser.engine.showHereTitle")
                        : t("browser.choice.handOffTitle", { browser: chosen.name })
                }
                onClick={() => (tab.engine ? model.openHere(tab.id) : fireAndForget(() => model.handOffTab(tab.id)))}
                className="flex h-full min-w-0 cursor-pointer items-center gap-1.5 rounded-l-6 px-2 hover:bg-hover hover:text-primary"
            >
                <i
                    className={cn(
                        tab.engine ? "fa-solid fa-window-maximize" : browserIconClass(chosen.id),
                        "text-11",
                        always && !tab.engine && "text-accent"
                    )}
                />
                <span className="min-w-0 truncate whitespace-nowrap">{label}</span>
            </button>
            <button
                type="button"
                aria-label={t("browser.engine.options")}
                title={
                    always
                        ? t("browser.engine.alwaysOpens", {
                              site: routed.site,
                              browser: engineName(routed.engine, list),
                          })
                        : t("browser.engine.options")
                }
                onClick={(e) => model.showEngineMenu(e, tab)}
                className="flex h-full cursor-pointer items-center rounded-r-6 border-l border-border px-1.5 hover:bg-hover hover:text-primary"
            >
                <i className="fa fa-solid fa-chevron-down text-11" />
            </button>
        </div>
    );
}

// Without an installed browser there is no engine button: the agents' site decision keeps a caret of its own.
function AgentSiteButton({ model, tab }: { model: BrowserViewModel; tab: BrowserTab }) {
    const t = useT();
    return (
        <button
            type="button"
            aria-label={t("browser.engine.agentSitePermission")}
            title={t("browser.engine.agentSitePermission")}
            onClick={(e) => model.showAgentSiteMenu(e, tab)}
            className="molten-browser-engine flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-6 border border-border px-1.5 text-12 text-secondary hover:bg-hover hover:text-primary"
        >
            <i className="fa fa-solid fa-robot text-11" />
            <i className="fa fa-solid fa-chevron-down text-11" />
        </button>
    );
}

function BrowserNotice({ model }: { model: BrowserViewModel }) {
    const t = useT();
    const notice = useAtomValue(model.noticeAtom);
    if (!notice) {
        return null;
    }
    return (
        <div
            role="status"
            className="molten-browser-notice flex shrink-0 items-center gap-2 border-b border-border px-2 py-1 text-12 text-secondary"
        >
            <i className="fa fa-solid fa-circle-info shrink-0 text-[var(--mt-state-info)]" />
            <span className="min-w-0 flex-1">{notice}</span>
            <button
                type="button"
                aria-label={t("common.dismiss")}
                onClick={() => model.dismissNotice()}
                className="shrink-0 cursor-pointer rounded-6 px-1 text-secondary hover:bg-hover hover:text-primary"
            >
                <i className="fa fa-solid fa-xmark text-11" />
            </button>
        </div>
    );
}

// What a handed-off entry shows: the page lives in the installed browser, with the ways back.
function HandoffPage({ model, tab }: { model: BrowserViewModel; tab: BrowserTab }) {
    const t = useT();
    const list = useAtomValue(model.engines.listAtom);
    const sites = useAtomValue(getSettingsKeyAtom("browser:sites"));
    const name = engineName(tab.engine, list);
    const routed = siteEngine(sites, tab.url);
    const always = routed.engine !== "" && routed.engine !== EngineApp;
    return (
        <div className="molten-browser-handoff absolute inset-0 flex items-center justify-center overflow-auto p-6">
            <div className="flex max-w-[460px] flex-col items-center gap-3 text-center">
                <i className={cn(browserIconClass(tab.engine), "text-icon-20 text-accent")} />
                <div className="text-13 leading-5 text-primary">{t("browser.tabs.openedIn", { browser: name })}</div>
                {tab.title ? <div className="max-w-full truncate text-12 text-primary">{tab.title}</div> : null}
                <div className="max-w-full truncate text-12 text-secondary" title={tab.url}>
                    {tab.url}
                </div>
                <div className="text-12 text-muted">
                    {t("browser.handoff.keeps", { browser: name })}
                    {always ? " " + t("browser.handoff.alwaysThere", { site: routed.site }) : ""}
                </div>
                <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
                    <Button className="!h-7 !px-3 !text-12" onClick={() => model.bringForward(tab.id)}>
                        {t("browser.menu.bringForward", { browser: name })}
                    </Button>
                    <Button className="outlined grey !h-7 !px-3 !text-12" onClick={() => model.reopenInBrowser(tab.id)}>
                        {t("browser.handoff.reopen")}
                    </Button>
                    <Button className="ghost grey !h-7 !px-3 !text-12" onClick={() => model.openHere(tab.id)}>
                        {t("browser.menu.openHere")}
                    </Button>
                </div>
            </div>
        </div>
    );
}

// A discarded page coming back (#459): its tab's favicon and title over the reloading webview, until it has loaded.
function ReloadingPlaceholder({ model, tab }: { model: BrowserViewModel; tab: BrowserTab }) {
    const t = useT();
    const loads = useAtomValue(model.loads.loadsAtom);
    if (tab == null || tab.engine) {
        return null;
    }
    const favicon = loads[tab.id]?.favicon;
    return (
        <div
            role="status"
            className="molten-browser-reloading pointer-events-none absolute inset-0 flex items-center justify-center bg-background"
        >
            <div className="flex max-w-[360px] flex-col items-center gap-2 text-center">
                {favicon ? (
                    <img src={favicon} alt="" draggable={false} className="h-5 w-5 object-contain" />
                ) : (
                    <i className="fa fa-solid fa-globe text-icon-20 text-secondary" />
                )}
                {tab.title ? <div className="max-w-full truncate text-12 text-primary">{tab.title}</div> : null}
                <div className="text-12 text-muted">{t("browser.reloading")}</div>
            </div>
        </div>
    );
}

// MoltenTerm's start page, drawn over the shown tab's empty page while it stays on it (FR-SHELL-111).
function ActiveStartPage({ model, tabId }: { model: BrowserViewModel; tabId: string }) {
    const state = useAtomValue(model.stateAtom);
    const tab = state.tabs.find((t) => t.id === tabId);
    if (tab == null || tab.engine || !isStartPage(tab.url)) {
        return null;
    }
    return <BrowserStartPage />;
}

// The shown tab's failed page, drawn over its webview (DS-SHELL-092); the failed URL stays in the address bar.
function ActiveErrorPage({ model, tabId }: { model: BrowserViewModel; tabId: string }) {
    const errors = useAtomValue(model.errors.errorsAtom);
    const entry = errors[tabId];
    if (entry?.error == null || model.findTab(tabId)?.engine) {
        return null;
    }
    return (
        <BrowserErrorPage
            error={entry.error}
            retrying={!!entry.retrying}
            onRetry={() => model.retryTab(tabId)}
            onStartDevServer={() => model.startDevServer()}
        />
    );
}

function BrowserView({ model }: ViewComponentProps<BrowserViewModel>) {
    const state = useAtomValue(model.stateAtom);
    const block = useAtomValue(model.blockAtom);
    const isFocused = useAtomValue(model.nodeModel.isFocused);
    const installedSetting = useAtomValue(getSettingsKeyAtom("browser:installed"));
    const defaultSetting = useAtomValue(getSettingsKeyAtom("browser:default"));
    const sitesSetting = useAtomValue(getSettingsKeyAtom("browser:sites"));
    const engineList = useAtomValue(model.engines.listAtom);
    const activity = useAtomValue(TabActivity.getInstance().stateAtom);
    const discarded = useAtomValue(model.lifecycle.discardedAtom);
    const restoring = useAtomValue(model.lifecycle.restoringAtom);
    const agentTabs = useAtomValue(model.agents.tabsAtom);
    const offCarpet = useAtomValue(offCarpetAtom(model.blockId));
    const viewShown = isShowing(activity);
    const blockMeta = block?.meta;
    useEffect(() => {
        for (const id of Object.keys(discarded)) {
            if (shouldRestore(id === state.activeId, viewShown && !offCarpet, agentTabs[id] != null)) {
                model.lifecycle.restore(id);
            }
        }
    }, [model, discarded, state.activeId, viewShown, offCarpet, agentTabs]);
    // A page an agent drives keeps running off-screen on the carpet (#618).
    const agentDriven = Object.keys(agentTabs).length > 0;
    useEffect(() => {
        setKeepLive(model.blockId, agentDriven);
        return () => setKeepLive(model.blockId, false);
    }, [model, agentDriven]);
    useEffect(() => {
        fireAndForget(() => model.engines.ensureLoaded());
    }, [model, installedSetting, defaultSetting, sitesSetting]);
    useEffect(() => {
        model.handleOpenRequests(blockMeta);
        model.handleCloseRequests(blockMeta);
    }, [model, blockMeta]);
    useEffect(() => {
        if (isFocused) {
            noteBrowserPanelFocus(model.blockId);
        }
    }, [model, isFocused]);
    return (
        <div className="molten-browser flex h-full w-full flex-col">
            <BrowserNavBar model={model} state={state} />
            <BrowserNotice model={model} />
            <SignInRefusalBar
                signIn={model.signIn}
                tabId={state.activeId}
                browserName={engineList?.chosen?.name ?? null}
                onContinue={(bar) => model.continueSignIn(state.activeId, bar)}
            />
            <EngineChoiceBar
                choices={model.choices}
                tabId={state.activeId}
                list={engineList}
                onStay={(choice) => model.stayWithChoice(state.activeId, choice)}
                onHandOff={(choice, browser) =>
                    fireAndForget(() => model.handOffWithChoice(state.activeId, choice, browser))
                }
                onDismiss={() => model.dismissChoice(state.activeId)}
            />
            <SitePermissionBar permissions={model.sitePermissions} tabId={state.activeId} />
            <AgentPermissionBar agents={model.agents} tabId={state.activeId} />
            <AgentControlBar agents={model.agents} tabId={state.activeId} />
            <div className="molten-browser-pages relative min-h-0 flex-1">
                {state.tabs.map((tab) =>
                    tab.engine ? (
                        tab.id === state.activeId ? (
                            <HandoffPage key={tab.id} model={model} tab={tab} />
                        ) : null
                    ) : discarded[tab.id] != null ? null : (
                        <TabWebview
                            key={tab.id}
                            model={model}
                            tab={tab}
                            active={tab.id === state.activeId}
                            shown={viewShown && tab.id === state.activeId}
                            offCarpet={offCarpet}
                        />
                    )
                )}
                {discarded[state.activeId] != null || restoring[state.activeId] != null ? (
                    <ReloadingPlaceholder model={model} tab={model.findTab(state.activeId)} />
                ) : null}
                <ActiveStartPage model={model} tabId={state.activeId} />
                <ActiveErrorPage model={model} tabId={state.activeId} />
                <AgentActionCueOverlay agents={model.agents} tabId={state.activeId} />
            </div>
        </div>
    );
}
