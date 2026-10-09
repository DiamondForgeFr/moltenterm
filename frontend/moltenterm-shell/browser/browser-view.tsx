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
import { getApi, getSettingsKeyAtom, refocusNode } from "@/app/store/global";
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
import { guestEditMenu, guestMenuEvent } from "../menu/guest-menu";
import { splitMenuItems } from "../split/split-menu";
import { AgentActionCueOverlay, AgentControlBar } from "./agent-control-bar";
import { AgentPermissionBar } from "./agent-permission-bar";
import {
    agentSiteDecision,
    AgentTabs,
    BrowserAgentModel,
    controlBarView,
    permissionBarView,
    setAgentSite,
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
    readBrowserState,
    readCloseRequests,
    readOpenRequests,
    setTabEngine,
    toBrowserUrl,
    updateTab,
} from "./browser-model";
import type { SignInBar } from "./browser-popup";
import { noteBrowserPanelFocus } from "./browser-routing";
import { dropOnTab, DropTarget, overTab, startTabDrag, tabDropIndex, TabDropIndicator } from "./browser-tab-drag";
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
    viewName = atom("Browser");
    noPadding = atom(true);
    noHeader = atom(true);
    stateAtom: PrimitiveAtom<BrowserState>;
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
    // The first-link engine choice per tab (FR-BRW-006).
    choices = new BrowserChoiceModel();
    // The tabs agents drive, and their control bars (FR-BRW-008).
    agents: BrowserAgentModel;
    handledCloseIds = new Set<string>();

    constructor({ blockId, nodeModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.layoutNode = nodeModel as Partial<NodeModel>;
        this.blockAtom = makeBlockAtom(blockId);
        this.stateAtom = atom(this.initialState()) as PrimitiveAtom<BrowserState>;
        this.agents = new BrowserAgentModel(blockId);
        this.agents.start();
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
            return { engine: EngineApp, fallback: `the installed browser could not be reached (${e})` };
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
        this.signIn.forget(id);
        this.loads.forget(id);
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
            this.showNotice(`The site choice could not be saved: ${e}`);
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
                this.showNotice(`The site choice could not be saved: ${e}`);
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
                  { label: `Bring ${name} Forward`, click: () => this.bringForward(tab.id) },
                  { label: `Reopen in ${name}`, click: () => this.reopenInBrowser(tab.id) },
                  { label: "Open in MoltenTerm", click: () => this.openHere(tab.id) },
              ]
            : [{ label: `Open in ${name}`, click: () => fireAndForget(() => this.handOffTab(tab.id)) }];
        if (site != null) {
            const always = routed.engine !== "" && routed.engine !== EngineApp;
            menu.push(
                { type: "separator" },
                {
                    label: `Always Open ${site} in ${always ? engineName(routed.engine, list) : chosen.name}`,
                    type: "checkbox",
                    checked: always,
                    click: () => {
                        this.toggleSiteChoice(tab.url);
                        if (!always && !tab.engine) {
                            fireAndForget(() => this.handOffTab(tab.id));
                        }
                    },
                }
            );
        }
        menu.push(...this.agentSiteMenu(tab));
        ContextMenuModel.getInstance().showContextMenu(menu, e);
    }

    // The agents' decision for the page's site (FR-BRW-009 AC3), with Forget: the next agent action there asks again.
    agentSiteMenu(tab: BrowserTab): ContextMenuItem[] {
        const decided = agentSiteDecision(globalStore.get(getSettingsKeyAtom("browser:agentsites")), tab?.url);
        if (decided == null) {
            return [];
        }
        const verb = decided.decision === "block" ? "Blocked" : "Allowed";
        return [
            { type: "separator" },
            { label: `Agents: ${verb} on ${decided.site}`, enabled: false },
            {
                label: `Forget the Agents' Decision for ${decided.site}`,
                click: () =>
                    fireAndForget(async () => {
                        try {
                            await setAgentSite(decided.site, "");
                        } catch (err) {
                            this.showNotice(`The agents' decision could not be forgotten: ${err}`);
                        }
                    }),
            },
        ];
    }

    showAgentSiteMenu(e: React.MouseEvent, tab: BrowserTab): void {
        const menu = this.agentSiteMenu(tab).filter((item) => item.type !== "separator");
        if (menu.length === 0) {
            return;
        }
        ContextMenuModel.getInstance().showContextMenu(menu, e);
    }

    showLinkMenu(url: string, event?: React.MouseEvent): void {
        const chosen = this.engines.chosen();
        const menu: ContextMenuItem[] = [{ label: "Open Link in New Tab", click: () => this.newTab(url) }];
        if (chosen != null && siteOf(url) != null) {
            menu.push({
                label: `Open Link in ${chosen.name}`,
                click: () => fireAndForget(() => this.handOffLink(url)),
            });
        }
        menu.push(
            { type: "separator" },
            { label: "Copy Link Address", click: () => fireAndForget(() => navigator.clipboard.writeText(url)) }
        );
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

    // The block header's menu, which the panel no longer shows.
    showPanelMenu(e: React.MouseEvent): void {
        e.preventDefault();
        e.stopPropagation();
        const magnified = globalStore.get(this.nodeModel.isMagnified);
        ContextMenuModel.getInstance().showContextMenu(
            [
                ...splitMenuItems(this.blockId),
                { type: "separator" },
                {
                    label: magnified ? "Un-Magnify Block" : "Magnify Block",
                    click: () => this.nodeModel.toggleMagnify(),
                },
                { type: "separator" },
                { label: "Copy BlockId", click: () => navigator.clipboard.writeText(this.blockId) },
                { type: "separator" },
                { label: "Close Block", click: () => uxCloseBlock(this.blockId) },
            ],
            e
        );
    }

    activeWebview(): WebviewTag {
        return this.webviews.get(this.state().activeId);
    }

    // The Reload button and Cmd+R act on the shown tab: Stop while it loads, else reload (ignoring the cache with
    // Shift+click or Cmd+Shift+R).
    reloadActive(ignoreCache: boolean): void {
        const id = this.state().activeId;
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
        this.signIn.forget(id);
        this.loads.forget(id);
        this.choices.forget(id);
        this.setState(closeTab(this.state(), id));
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

    dispose(): void {
        if (this.persistTimer != null) {
            clearTimeout(this.persistTimer);
        }
        this.agents.dispose();
    }
}

function makeBlockAtom(blockId: string): Atom<Block> {
    return WOS.getWaveObjectAtom<Block>(makeORef("block", blockId));
}

function TabWebview({ model, tab, active }: { model: BrowserViewModel; tab: BrowserTab; active: boolean }) {
    const ref = useRef<WebviewTag>(null);
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
            if (e.isMainFrame === false) {
                return;
            }
            model.setState(updateTab(model.state(), tab.id, { url: e.url }));
            model.signIn.noteNavigation(tab.id, e.url);
            // In-page navigations (anchors, history.pushState on load) do not count as moving on.
            if (e.type === "did-navigate") {
                model.choices.noteNavigation(tab.id);
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
        const onStartLoading = () => model.loads.noteStart(tab.id);
        const onStopLoading = () => model.loads.noteStop(tab.id);
        const onFavicon = (e: any) => model.loads.noteFavicons(tab.id, e.favicons);
        // emain/preload.ts routes a page's new window by this attribute; the preload cannot call the element's methods.
        const onDomReady = () => {
            webview.dataset.webcontentsid = String(webview.getWebContentsId());
            registerWebview(model.blockId, tab.id, webview.getWebContentsId());
            getApi().setContextMenuGuest?.(webview.getWebContentsId(), model.state().activeId === tab.id);
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

        webview.addEventListener("did-start-loading", onStartLoading);
        webview.addEventListener("did-stop-loading", onStopLoading);
        webview.addEventListener("page-favicon-updated", onFavicon);
        return () => {
            webview.removeEventListener("did-start-loading", onStartLoading);
            webview.removeEventListener("did-stop-loading", onStopLoading);
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

function BrowserTabStrip({ model, state }: { model: BrowserViewModel; state: BrowserState }) {
    const [dragId, setDragId] = useState<string>(null);
    const [dropTarget, setDropTarget] = useState<DropTarget>(null);
    const list = useAtomValue(model.engines.listAtom);
    const loads = useAtomValue(model.loads.loadsAtom);
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
        <div className="flex h-8 shrink-0 items-end border-b border-border pl-1">
            <div
                ref={scrollRef}
                onWheel={onWheel}
                onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                        setDropTarget(null);
                    }
                }}
                className="molten-browser-tabs flex min-w-0 shrink items-end gap-0.5 overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
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
                        title={tab.engine ? `${tab.url}\nOpened in ${engineName(tab.engine, list)}` : tab.url}
                        data-tabid={tab.id}
                        data-engine={tab.engine ?? EngineApp}
                        className={cn(
                            "molten-browser-tab group relative flex h-7 min-w-[72px] flex-[0_1_200px] cursor-pointer items-center gap-1 rounded-t border border-b-0 px-2 text-xs",
                            tab.id === state.activeId
                                ? "border-border bg-hover text-primary"
                                : "border-transparent text-secondary hover:bg-hover/50",
                            tab.id === dragId && "opacity-50"
                        )}
                    >
                        {showDrop && dropTarget.overId === tab.id ? (
                            <TabDropIndicator after={dropTarget.after} />
                        ) : null}
                        {tab.engine ? (
                            <i
                                aria-label={`Opened in ${engineName(tab.engine, list)}`}
                                className={cn(browserIconClass(tab.engine), "shrink-0 text-[11px] text-accent")}
                            />
                        ) : (
                            <TabIcon load={loads[tab.id]} />
                        )}
                        <span className={cn("min-w-0 flex-1 truncate", tab.engine && "text-secondary")}>
                            {browserTabTitle(tab) || "New tab"}
                        </span>
                        <AgentTabMarker agentTabs={agentTabs} tabId={tab.id} />
                        {state.tabs.length > 1 ? (
                            <button
                                type="button"
                                aria-label="Close tab"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    model.closeTab(tab.id);
                                }}
                                className="shrink-0 cursor-pointer rounded px-0.5 text-secondary opacity-60 hover:bg-hover hover:opacity-100"
                            >
                                <i className="fa fa-solid fa-xmark text-[10px]" />
                            </button>
                        ) : null}
                    </div>
                ))}
            </div>
            <button
                type="button"
                aria-label="New tab"
                title="New tab (Cmd+T)"
                onClick={() => model.newTab()}
                className="mb-0.5 ml-0.5 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-secondary hover:bg-hover hover:text-primary"
            >
                <i className="fa fa-solid fa-plus text-xs" />
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
function AgentTabMarker({ agentTabs, tabId }: { agentTabs: AgentTabs; tabId: string }) {
    const view = controlBarView(agentTabs[tabId]);
    if (view == null) {
        return null;
    }
    const asking = permissionBarView(agentTabs[tabId]);
    if (asking != null) {
        return (
            <i
                role="img"
                aria-label={asking.title}
                title={asking.title}
                className="fa fa-solid fa-circle-question shrink-0 text-[10px] text-[var(--mt-state-waiting)]"
            />
        );
    }
    return (
        <i
            role="img"
            aria-label={view.title}
            title={view.title}
            className={cn(
                "fa fa-solid fa-robot shrink-0 text-[10px]",
                view.takenOver ? "text-secondary" : "text-accent"
            )}
        />
    );
}

// A tab's favicon, or a spinner in the working colour while its page loads.
function TabIcon({ load }: { load: TabLoad }) {
    const [broken, setBroken] = useState<string>(null);
    if (load?.loading) {
        return (
            <span
                role="progressbar"
                aria-label="Loading"
                className="molten-browser-tab-spinner h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-[var(--mt-state-working)] border-t-transparent motion-reduce:animate-none"
            />
        );
    }
    if (load?.favicon == null || broken === load.favicon) {
        return <i className="fa fa-solid fa-globe w-3 shrink-0 text-center text-[10px] text-muted" />;
    }
    return (
        <img
            src={load.favicon}
            alt=""
            draggable={false}
            onError={() => setBroken(load.favicon)}
            className="h-3 w-3 shrink-0 object-contain"
        />
    );
}

function BrowserPanelButtons({ model }: { model: BrowserViewModel }) {
    const node = model.layoutNode;
    const magnified = useAtomValue(model.nodeModel.isMagnified);
    const ephemeral = useAtomValueSafe(node.isEphemeral);
    const numLeafs = useAtomValueSafe(node.numLeafs) ?? 1;
    const addToLayout: IconButtonDecl = {
        elemtype: "iconbutton",
        icon: "circle-plus",
        title: "Add to Layout",
        click: () => node.addEphemeralNodeToLayout?.(),
    };
    const close: IconButtonDecl = {
        elemtype: "iconbutton",
        icon: "xmark-large",
        title: "Close",
        click: () => uxCloseBlock(model.blockId),
    };
    return (
        <div className="molten-browser-panel-buttons flex h-full shrink-0 items-center gap-1.5 px-2 text-secondary">
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
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-secondary hover:bg-hover hover:text-primary disabled:pointer-events-none disabled:opacity-40"
        >
            <i className={`fa fa-solid fa-${icon} text-xs`} />
        </button>
    );
    return (
        <div className="relative flex h-8 shrink-0 items-center gap-1 border-b border-border px-1">
            {navButton(
                "arrow-left",
                "Back",
                () => model.activeWebview()?.canGoBack() && model.activeWebview().goBack()
            )}
            {navButton(
                "arrow-right",
                "Forward",
                () => model.activeWebview()?.canGoForward() && model.activeWebview().goForward()
            )}
            {loading
                ? navButton("xmark", "Stop", () => model.reloadActive(false), "Stop loading this page")
                : navButton(
                      "rotate-right",
                      "Reload",
                      (e) => model.reloadActive(e.shiftKey),
                      "Reload (Cmd+R)\nShift-click or Cmd+Shift+R: reload ignoring the cache"
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
                className="h-6 min-w-0 flex-1 rounded border border-border bg-transparent px-2 text-xs text-primary outline-none focus:border-accent"
            />
            <EngineButton model={model} tab={active} />
            {loading ? (
                <div
                    role="progressbar"
                    aria-label="Loading the page"
                    className="molten-browser-progress pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden"
                >
                    <div className="molten-browser-progress-bar h-full w-1/3 bg-[var(--mt-state-working)]" />
                </div>
            ) : null}
        </div>
    );
}

// "Open in <browser>" (FR-BRW-002): one click hands the page off; the caret holds the per-site choice. Hidden when no
// Chromium browser is installed, and on a handed-off entry, whose page offers the way back.
function EngineButton({ model, tab }: { model: BrowserViewModel; tab: BrowserTab }) {
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
    const label = tab.engine ? "Open in MoltenTerm" : `Open in ${chosen.name}`;
    return (
        <div className="molten-browser-engine flex h-6 shrink-0 items-center rounded border border-border text-xs text-secondary">
            <button
                type="button"
                title={
                    tab.engine
                        ? "Show this page in MoltenTerm's panel"
                        : `Open this page in ${chosen.name}, with your sessions and extensions`
                }
                onClick={() => (tab.engine ? model.openHere(tab.id) : fireAndForget(() => model.handOffTab(tab.id)))}
                className="flex h-full cursor-pointer items-center gap-1.5 rounded-l px-2 hover:bg-hover hover:text-primary"
            >
                <i
                    className={cn(
                        tab.engine ? "fa-solid fa-window-maximize" : browserIconClass(chosen.id),
                        "text-[11px]",
                        always && !tab.engine && "text-accent"
                    )}
                />
                <span className="whitespace-nowrap">{label}</span>
            </button>
            <button
                type="button"
                aria-label="Browser options"
                title={always ? `${routed.site} always opens in ${engineName(routed.engine, list)}` : "Browser options"}
                onClick={(e) => model.showEngineMenu(e, tab)}
                className="flex h-full cursor-pointer items-center rounded-r border-l border-border px-1.5 hover:bg-hover hover:text-primary"
            >
                <i className="fa fa-solid fa-chevron-down text-[9px]" />
            </button>
        </div>
    );
}

// Without an installed browser there is no engine button: the agents' site decision keeps a caret of its own.
function AgentSiteButton({ model, tab }: { model: BrowserViewModel; tab: BrowserTab }) {
    return (
        <button
            type="button"
            aria-label="Agent site permission"
            title="Agent site permission"
            onClick={(e) => model.showAgentSiteMenu(e, tab)}
            className="molten-browser-engine flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded border border-border px-1.5 text-xs text-secondary hover:bg-hover hover:text-primary"
        >
            <i className="fa fa-solid fa-robot text-[10px]" />
            <i className="fa fa-solid fa-chevron-down text-[9px]" />
        </button>
    );
}

function BrowserNotice({ model }: { model: BrowserViewModel }) {
    const notice = useAtomValue(model.noticeAtom);
    if (!notice) {
        return null;
    }
    return (
        <div
            role="status"
            className="molten-browser-notice flex shrink-0 items-center gap-2 border-b border-border px-2 py-1 text-xs text-secondary"
        >
            <i className="fa fa-solid fa-circle-info shrink-0 text-[var(--mt-state-waiting)]" />
            <span className="min-w-0 flex-1">{notice}</span>
            <button
                type="button"
                aria-label="Dismiss"
                onClick={() => model.dismissNotice()}
                className="shrink-0 cursor-pointer rounded px-1 text-secondary hover:bg-hover hover:text-primary"
            >
                <i className="fa fa-solid fa-xmark text-[10px]" />
            </button>
        </div>
    );
}

// What a handed-off entry shows: the page lives in the installed browser, with the ways back.
function HandoffPage({ model, tab }: { model: BrowserViewModel; tab: BrowserTab }) {
    const list = useAtomValue(model.engines.listAtom);
    const sites = useAtomValue(getSettingsKeyAtom("browser:sites"));
    const name = engineName(tab.engine, list);
    const routed = siteEngine(sites, tab.url);
    const always = routed.engine !== "" && routed.engine !== EngineApp;
    return (
        <div className="molten-browser-handoff absolute inset-0 flex items-center justify-center overflow-auto p-6">
            <div className="flex max-w-[460px] flex-col items-center gap-3 text-center">
                <i className={cn(browserIconClass(tab.engine), "text-3xl text-accent")} />
                <div className="text-sm text-primary">Opened in {name}</div>
                {tab.title ? <div className="max-w-full truncate text-xs text-primary">{tab.title}</div> : null}
                <div className="max-w-full truncate text-xs text-secondary" title={tab.url}>
                    {tab.url}
                </div>
                <div className="text-xs text-muted">
                    {name} keeps your sessions, passwords and extensions for this page.
                    {always ? ` ${routed.site} always opens there.` : ""}
                </div>
                <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
                    <Button className="!h-7 !px-3 !text-xs" onClick={() => model.bringForward(tab.id)}>
                        Bring {name} forward
                    </Button>
                    <Button className="outlined grey !h-7 !px-3 !text-xs" onClick={() => model.reopenInBrowser(tab.id)}>
                        Reopen the page
                    </Button>
                    <Button className="ghost grey !h-7 !px-3 !text-xs" onClick={() => model.openHere(tab.id)}>
                        Open in MoltenTerm
                    </Button>
                </div>
            </div>
        </div>
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
    const blockMeta = block?.meta;
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
                    ) : (
                        <TabWebview key={tab.id} model={model} tab={tab} active={tab.id === state.activeId} />
                    )
                )}
                <AgentActionCueOverlay agents={model.agents} tabId={state.activeId} />
            </div>
        </div>
    );
}
