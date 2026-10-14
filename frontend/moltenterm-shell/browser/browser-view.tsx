// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The browser panel (FR-SHELL-007, DS-SHELL-007): pages in tabs, like a browser window. Each tab keeps its own live
// <webview>, hidden when inactive, so its page and history survive switching. Every web page Moltenterm opens
// lands here (#132): Wave's web view (one page per panel) is no longer created, and saved ones are migrated at startup.
//
// The panel has no Wave block header (FR-SHELL-012, DS-SHELL-012): its tab strip carries the header's roles (moving
// the panel, magnify, close, the header menu) and the page title lives in its tab only.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { OptMagnifyButton } from "@/app/block/blockutil";
import { Button } from "@/app/element/button";
import { IconButton } from "@/app/element/iconbutton";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { atoms, getApi, getSettingsKeyAtom, refocusNode } from "@/app/store/global";
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
import { agentStatesOfWorkspace } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { openHeaderCommandPanel } from "../command-panel/block-menus";
import { openCommandPanelFromTrigger } from "../command-panel/command-panel-store";
import type { BrowserCommandState } from "../command-panel/providers/browser";
import { Pill } from "../header/pill";
import { I18nModel, t, useLocale, useT } from "../i18n/i18n";
import { translate } from "../i18n/i18n-core";
import { guestEditMenu, guestMenuEvent } from "../menu/guest-menu";
import { openSettingsSection } from "../settings/settings-open";
import { formatShortcutById } from "../shortcuts/format";
import { splitPanel } from "../split/split";
import { splitMenuItems } from "../split/split-menu";
import { TabActivity } from "../tab-activity";
import { isShowing } from "../tab-activity-model";
import { PanelMeta, panelTitle } from "../tab-identity";
import { showToast } from "../toast-store";
import { isOffCarpet, offCarpetAtom, setKeepLive } from "../view360/offcarpet-model";
import { PinHeaderButton } from "../view360/view360-pin";
import { AgentActionCueOverlay, AgentControlBar } from "./agent-control-bar";
import { AgentPermissionBar } from "./agent-permission-bar";
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
    addTab,
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
    makeTabId,
    MoltentermBrowserView,
    moveTab,
    readBrowserState,
    readCloseRequests,
    readOpenRequests,
    setTabEngine,
    toBrowserUrl,
    updateTab,
} from "./browser-model";
import type { SignInBar } from "./browser-popup";
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
    unshareableReason,
} from "./browser-share";
import { dropOnTab, DropTarget, overTab, startTabDrag, tabDropIndex, TabDropIndicator } from "./browser-tab-drag";
import { browserTabMenu } from "./browser-tab-menu";
import "./browser.css";
import { BrowserChoiceModel, EngineChoiceBar } from "./engine-choice-bar";
import { choiceEngineId, EngineChoice } from "./link-choice";
import { BrowserSignInModel, SignInRefusalBar } from "./signin-bar";

export { MoltentermBrowserView };

const PersistDelayMs = 400;
const FallbackUrl = "about:blank";

// The agents' DevTools controller needs each tab's webview (emain/moltenterm-browseragent.ts, FR-BRW-008).
type BrowserAgentElectronApi = ElectronApi & {
    moltentermRegisterWebview?: (blockId: string, browserTabId: string, webContentsId: number) => void;
};

function registerWebview(blockId: string, browserTabId: string, webContentsId: number): void {
    (getApi() as BrowserAgentElectronApi).moltentermRegisterWebview?.(blockId, browserTabId, webContentsId);
}

function webviewPreloadUrl(): string {
    const path = getApi().getWebviewPreload();
    return path ? "file://" + path : undefined;
}

export class BrowserViewModel implements ViewModel {
    viewType = MoltentermBrowserView;
    blockId: string;
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
        fireAndForget(() => this.engines.ensureLoaded());
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

    // A page already opened in the installed browser, kept in the tab strip without taking the panel over.
    addHandoffEntry(url: string, engine: string): void {
        this.setState(addTab(this.state(), url, makeTabId, { engine, activate: false }));
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

    // A link sent to the installed browser from the page's menu: a new handed-off entry, or a tab here on a fallback.
    async handOffLink(url: string): Promise<void> {
        const route = await this.askBrowser(() => browserOpen(url, EngineInstalled));
        if (route.engine === EngineApp) {
            this.newTab(url);
            this.showNotice(fallbackNotice(route));
            return;
        }
        this.addHandoffEntry(url, route.engine);
    }

    // A page's new window (window.open, target=_blank): a new tab, unless its site is set to the installed browser.
    openLink(url: string): void {
        if (!this.engines.needsRouting(url)) {
            this.newTab(url);
            return;
        }
        fireAndForget(async () => {
            const route = await this.askBrowser(() => browserOpen(url));
            if (route.engine !== EngineApp) {
                this.addHandoffEntry(url, route.engine);
                return;
            }
            this.newTab(url);
            this.showNotice(fallbackNotice(route));
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
        const menu: ContextMenuItem[] = [
            { label: t("browser.menu.openLinkNewTab"), icon: "plus", click: () => this.newTab(url) },
        ];
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

    newTab(url?: string): void {
        const defaultUrl = globalStore.get(getSettingsKeyAtom("web:defaulturl")) || FallbackUrl;
        this.setState(addTab(this.state(), url || defaultUrl));
    }

    // A link opened elsewhere in the app (#140): a new active tab here, and the panel takes the focus. askSite: the
    // tab asks which engine the site uses (FR-BRW-006); the page loads meanwhile.
    openUrlInNewTab(url: string, askSite?: string): void {
        this.newTab(url);
        if (askSite) {
            this.choices.ask(this.state().activeId, url, askSite);
        }
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
        let agentOpened = false;
        for (const request of fresh) {
            this.handledOpenIds.add(request.id);
            if (request.agent) {
                // Shown in the panel, but the focus stays where the user is (the agent's terminal).
                this.setState(addTab(this.state(), request.url, makeTabId, { id: request.tabId }));
                agentOpened = true;
                continue;
            }
            if (request.engine) {
                this.addHandoffEntry(request.url, request.engine);
                continue;
            }
            this.newTab(request.url);
            const site = request.ask ? siteOf(request.url) : null;
            if (site != null) {
                this.choices.ask(this.state().activeId, request.url, site, request.keepFocus);
            }
        }
        fireAndForget(() =>
            RpcApi.SetMetaCommand(TabRpcClient, {
                oref: makeORef("block", this.blockId),
                meta: consumeOpenRequestsMeta(requests) as MetaType,
            })
        );
        if (agentOpened) {
            // The agent's session waits for the saved tab before its next call can use it.
            this.persistNow();
        }
        if (fresh.some((r) => !r.keepFocus && !r.agent)) {
            this.focusPanel();
        }
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

    // The copy opens right after its tab, as in a browser, and is shown.
    duplicateTab(id: string): void {
        const tab = this.findTab(id);
        if (tab == null) {
            return;
        }
        const shown = activateTab(this.state(), id);
        const next = addTab(shown, tab.url, makeTabId, tab.engine ? { engine: tab.engine } : undefined);
        const index = next.tabs.findIndex((t) => t.id === id);
        this.setState(moveTab(next, next.activeId, index + 1));
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
        return shareAgents(states, sessions, (id) => panelTitle(metas.get(id) as PanelMeta));
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
                message: res?.message ?? "",
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
    return e instanceof Error ? e.message : String(e);
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
        const onFocus = () => {
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
        const onDomReady = () => {
            webview.dataset.webcontentsid = String(webview.getWebContentsId());
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
        webview.addEventListener("focus", onFocus);
        webview.addEventListener("blur", onBlur);
        webview.addEventListener("dom-ready", onDomReady);
        webview.addEventListener("did-finish-load", onFinishLoad);

        webview.addEventListener("did-start-loading", onStartLoading);
        webview.addEventListener("did-stop-loading", onStopLoading);
        webview.addEventListener("did-fail-load", onFailLoad);
        webview.addEventListener("page-favicon-updated", onFavicon);
        return () => {
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
            className={cn("absolute inset-0 h-full w-full", !active && "invisible pointer-events-none")}
        />
    );
}

// The tab strip draws the app's tabs at 28 px (FR-SHELL-051, DS-SHELL-092, DS-SHELL-098): 14 px icon, a left 12/500
// name, a quiet fill on the active tab, the close control on hover or focus only (browser.css).
function BrowserTabStrip({ model, state }: { model: BrowserViewModel; state: BrowserState }) {
    const t = useT();
    const [dragId, setDragId] = useState<string>(null);
    const [dropTarget, setDropTarget] = useState<DropTarget>(null);
    const list = useAtomValue(model.engines.listAtom);
    const loads = useAtomValue(model.loads.loadsAtom);
    const errors = useAtomValue(model.errors.errorsAtom);
    const agentTabs = useAtomValue(model.agents.tabsAtom);
    const scrollRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const active = scrollRef.current?.querySelector<HTMLElement>(`[data-tabid="${state.activeId}"]`);
        active?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }, [state.activeId, state.tabs.length]);
    const showDrop = dropTarget != null && tabDropIndex(state.tabs, dragId, dropTarget) != null;
    const endDrag = () => {
        setDragId(null);
        setDropTarget(null);
    };
    // Tabs shrink to their minimum width, then the strip scrolls; a vertical wheel scrolls it sideways too.
    const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            e.currentTarget.scrollLeft += e.deltaY;
        }
    };
    return (
        <div className="molten-browser-tabstrip flex h-8 shrink-0 items-center border-b border-border pl-1">
            <div
                ref={scrollRef}
                onWheel={onWheel}
                onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                        setDropTarget(null);
                    }
                }}
                className="molten-browser-tabs flex h-full min-w-0 shrink items-center overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
            >
                {state.tabs.map((tab) => (
                    <div
                        key={tab.id}
                        draggable
                        onDragStart={(e) => {
                            startTabDrag(e, tab.id);
                            setDragId(tab.id);
                        }}
                        onDragOver={(e) => {
                            const target = overTab(e, dragId, tab.id);
                            if (target == null) {
                                return;
                            }
                            if (dropTarget?.overId !== target.overId || dropTarget.after !== target.after) {
                                setDropTarget(target);
                            }
                        }}
                        onDrop={(e) => {
                            model.setState(dropOnTab(e, model.state(), dragId, overTab(e, dragId, tab.id)));
                            endDrag();
                        }}
                        onDragEnd={(e) => {
                            e.stopPropagation();
                            endDrag();
                        }}
                        onClick={() => {
                            model.setState(activateTab(model.state(), tab.id));
                            model.bringForward(tab.id);
                        }}
                        onAuxClick={(e) => {
                            if (e.button === 1) {
                                e.preventDefault();
                                model.closeTab(tab.id);
                            }
                        }}
                        onContextMenu={(e) => {
                            e.stopPropagation();
                            model.showTabMenu(e, tab);
                        }}
                        title={
                            tab.engine
                                ? `${tab.url}\n${t("browser.tabs.openedIn", { browser: engineName(tab.engine, list) })}`
                                : tab.url
                        }
                        data-tabid={tab.id}
                        data-engine={tab.engine ?? EngineApp}
                        className={cn(
                            "molten-browser-tab group relative flex h-7 min-w-[72px] flex-[0_1_200px] cursor-pointer items-center",
                            tab.id === state.activeId && "active",
                            state.tabs.length > 1 && "closable",
                            tab.id === dragId && "dragging opacity-50"
                        )}
                    >
                        {showDrop && dropTarget.overId === tab.id ? (
                            <TabDropIndicator after={dropTarget.after} />
                        ) : null}
                        <div className="molten-browser-tab-inner">
                            {tab.engine ? (
                                <i
                                    aria-label={t("browser.tabs.openedIn", { browser: engineName(tab.engine, list) })}
                                    className={cn(browserIconClass(tab.engine), "molten-browser-tab-icon text-accent")}
                                />
                            ) : (
                                <TabIcon load={loads[tab.id]} failed={errors[tab.id]?.error != null} />
                            )}
                            <span className="molten-browser-tab-name">
                                {browserTabTitle(tab) || t("browser.tabs.newTab")}
                            </span>
                            <AgentTabMarker model={model} agentTabs={agentTabs} tabId={tab.id} />
                        </div>
                        {state.tabs.length > 1 ? (
                            <button
                                type="button"
                                aria-label={t("browser.tabs.closeTab")}
                                title={t("browser.tabs.closeTab")}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    model.closeTab(tab.id);
                                }}
                                className="molten-browser-tab-close cursor-pointer"
                            >
                                <i className="fa fa-solid fa-xmark" />
                            </button>
                        ) : null}
                    </div>
                ))}
            </div>
            <button
                type="button"
                aria-label={t("browser.tabs.newTab")}
                title={t("browser.tabs.newTabTitle", { shortcut: "Cmd+T" })}
                onClick={() => model.newTab()}
                className="ml-0.5 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-6 text-secondary hover:bg-hover hover:text-primary"
            >
                <i className="fa fa-solid fa-plus text-12" />
            </button>
            <div
                ref={model.layoutNode.dragHandleRef}
                onContextMenu={(e) => model.showPanelMenu(e)}
                onDoubleClick={() => model.toggleMagnify()}
                className="molten-browser-drag h-full min-w-6 flex-1"
            />
            <BrowserPanelButtons model={model} />
        </div>
    );
}

// A tab an agent controls carries its mark, so the user sees it even when the tab is not shown.
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

// A tab's favicon, or a spinner in the working colour while its page loads; a page that failed shows a warning.
function TabIcon({ load, failed }: { load: TabLoad; failed: boolean }) {
    const t = useT();
    const [broken, setBroken] = useState<string>(null);
    if (load?.loading) {
        return (
            <span className="molten-browser-tab-icon flex items-center justify-center">
                <span
                    role="progressbar"
                    aria-label={t("browser.tabs.loading")}
                    className="molten-browser-tab-spinner h-3 w-3 animate-spin rounded-full border-[1.5px] border-[var(--mt-state-working)] border-t-transparent motion-reduce:animate-none"
                />
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
    const close: IconButtonDecl = {
        elemtype: "iconbutton",
        icon: "xmark-large",
        title: t("common.close"),
        click: () => uxCloseBlock(model.blockId),
    };
    const commands: IconButtonDecl = {
        elemtype: "iconbutton",
        icon: "sliders",
        title: t("browser.panel.commands", { shortcut: formatShortcutById("command-panel") }),
        click: (e) => openCommandPanelFromTrigger(model.blockId, (e.target as Element)?.closest?.("button")),
    };
    return (
        <div className="molten-browser-panel-buttons flex h-full shrink-0 items-center gap-0.5 px-1.5">
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
            <IconButton decl={close} />
        </div>
    );
}

function BrowserNavBar({ model, state }: { model: BrowserViewModel; state: BrowserState }) {
    const t = useT();
    const active = state.tabs.find((t) => t.id === state.activeId);
    const [draft, setDraft] = useState(active?.url ?? "");
    const [editing, setEditing] = useState(false);
    const loads = useAtomValue(model.loads.loadsAtom);
    const loading = !active?.engine && !!loads[state.activeId]?.loading;
    useEffect(() => {
        if (!editing) {
            setDraft(active?.url ?? "");
        }
    }, [active?.url, active?.id, editing]);
    const navButton = (icon: string, label: string, run: (e: React.MouseEvent) => void, title = label) => (
        <button
            type="button"
            aria-label={label}
            title={title}
            onClick={run}
            disabled={!!active?.engine}
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-6 text-secondary hover:bg-hover hover:text-primary disabled:pointer-events-none disabled:opacity-40"
        >
            <i className={`fa fa-solid fa-${icon} text-12`} />
        </button>
    );
    return (
        <div className="relative flex h-8 shrink-0 items-center gap-1 border-b border-border px-1">
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
                ? navButton("xmark", t("browser.nav.stop"), () => model.reloadActive(false), t("browser.nav.stopTitle"))
                : navButton(
                      "rotate-right",
                      t("browser.nav.reload"),
                      (e) => model.reloadActive(e.shiftKey),
                      t("browser.nav.reloadTitle", { shortcut: "Cmd+R", hardShortcut: "Cmd+Shift+R" })
                  )}
            <input
                ref={model.urlInputRef}
                value={draft}
                spellCheck={false}
                onFocus={() => setEditing(true)}
                onBlur={() => setEditing(false)}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Escape") {
                        setDraft(active?.url ?? "");
                        e.currentTarget.blur();
                        return;
                    }
                    if (e.key !== "Enter") {
                        return;
                    }
                    const url = toBrowserUrl(draft);
                    if (url != null && active?.engine) {
                        model.reopenInBrowser(active.id, url);
                    } else if (url != null) {
                        model.activeWebview()?.loadURL(url);
                        model.setState(updateTab(model.state(), state.activeId, { url }));
                    }
                    e.currentTarget.blur();
                }}
                className="h-6 min-w-0 flex-1 rounded-4 border border-border bg-transparent px-2 text-12 text-primary outline-none focus:border-accent"
            />
            <ShareButton model={model} tab={active} />
            <EngineButton model={model} tab={active} />
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
    useEffect(() => {
        model.agents.refreshSessions();
    }, [model, agentData, tabBlockIds]);
    if (tab == null) {
        return null;
    }
    const running = ofTab(agentStatesOfWorkspace(agentData, workspace?.oid), tabBlockIds).filter(
        (s) => s.agent || s.agentname
    );
    const reason = tab.engine
        ? unshareableReason(tab, engineName(tab.engine, list))
        : running.length === 0 && ofTab(sessions, tabBlockIds).length === 0
          ? noAgentReason()
          : "";
    return (
        <button
            type="button"
            aria-label={shareLabel()}
            aria-disabled={reason ? true : undefined}
            title={reason || shareLabel()}
            onMouseEnter={() => model.agents.refreshSessions()}
            onClick={(e) => {
                if (!reason) {
                    model.showShareMenu(e, tab);
                }
            }}
            data-testid="browser-share-button"
            className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-6 text-secondary",
                reason ? "opacity-40" : "cursor-pointer hover:bg-hover hover:text-primary"
            )}
        >
            <i className="fa fa-solid fa-share-nodes text-12" />
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
        <div className="molten-browser-engine flex h-6 shrink-0 items-center rounded-4 border border-border text-12 text-secondary">
            <button
                type="button"
                title={
                    tab.engine
                        ? t("browser.engine.showHereTitle")
                        : t("browser.choice.handOffTitle", { browser: chosen.name })
                }
                onClick={() => (tab.engine ? model.openHere(tab.id) : fireAndForget(() => model.handOffTab(tab.id)))}
                className="flex h-full cursor-pointer items-center gap-1.5 rounded-l-6 px-2 hover:bg-hover hover:text-primary"
            >
                <i
                    className={cn(
                        tab.engine ? "fa-solid fa-window-maximize" : browserIconClass(chosen.id),
                        "text-11",
                        always && !tab.engine && "text-accent"
                    )}
                />
                <span className="whitespace-nowrap">{label}</span>
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
            <i className="fa fa-solid fa-circle-info shrink-0 text-[var(--mt-state-waiting)]" />
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
            <BrowserTabStrip model={model} state={state} />
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
            <AgentPermissionBar agents={model.agents} tabId={state.activeId} />
            <AgentControlBar agents={model.agents} tabId={state.activeId} />
            <div className="relative min-h-0 flex-1">
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
                <ActiveErrorPage model={model} tabId={state.activeId} />
                <AgentActionCueOverlay agents={model.agents} tabId={state.activeId} />
            </div>
        </div>
    );
}
