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
import {
    activateTab,
    addTab,
    browserMeta,
    BrowserState,
    BrowserTab,
    browserTabTitle,
    closeTab,
    consumeOpenRequestsMeta,
    MoltentermBrowserView,
    moveTab,
    readBrowserState,
    readOpenRequests,
    toBrowserUrl,
    updateTab,
} from "./browser-model";
import { noteBrowserPanelFocus } from "./browser-routing";

export { MoltentermBrowserView };

const PersistDelayMs = 400;
const FallbackUrl = "about:blank";

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

    constructor({ blockId, nodeModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.layoutNode = nodeModel as Partial<NodeModel>;
        this.blockAtom = makeBlockAtom(blockId);
        this.stateAtom = atom(this.initialState()) as PrimitiveAtom<BrowserState>;
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
        this.persistTimer = setTimeout(() => {
            this.persistTimer = null;
            fireAndForget(() =>
                RpcApi.SetMetaCommand(TabRpcClient, {
                    oref: makeORef("block", this.blockId),
                    meta: browserMeta(this.state()),
                })
            );
        }, PersistDelayMs);
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

    newTab(url?: string): void {
        const defaultUrl = globalStore.get(getSettingsKeyAtom("web:defaulturl")) || FallbackUrl;
        this.setState(addTab(this.state(), url || defaultUrl));
    }

    // A link opened elsewhere in the app (#140): a new active tab here, and the panel takes the focus.
    openUrlInNewTab(url: string): void {
        this.newTab(url);
        this.focusPanel();
    }

    focusPanel(): void {
        this.nodeModel.focusNode();
        // The new tab's webview mounts after this render; focus it once it exists.
        setTimeout(() => refocusNode(this.blockId), 50);
    }

    // Pages wsh queues for this panel (BrowserOpenKeyPrefix), opened as tabs in queue order. Only the entries read
    // here leave the queue, so a page wsh adds meanwhile is kept; ids already opened are skipped until their removal
    // comes back.
    handleOpenRequests(meta: Record<string, any>): void {
        const requests = readOpenRequests(meta);
        if (requests.length === 0) {
            return;
        }
        const fresh = requests.filter((r) => !this.handledOpenIds.has(r.id));
        for (const request of fresh) {
            this.handledOpenIds.add(request.id);
            this.newTab(request.url);
        }
        fireAndForget(() =>
            RpcApi.SetMetaCommand(TabRpcClient, {
                oref: makeORef("block", this.blockId),
                meta: consumeOpenRequestsMeta(requests) as MetaType,
            })
        );
        if (fresh.length > 0) {
            this.focusPanel();
        }
    }

    closeTab(id: string): void {
        this.webviews.delete(id);
        this.setState(closeTab(this.state(), id));
    }

    giveFocus(): boolean {
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
    }
}

function makeBlockAtom(blockId: string): Atom<Block> {
    return WOS.getWaveObjectAtom<Block>(makeORef("block", blockId));
}

function TabWebview({ model, tab, active }: { model: BrowserViewModel; tab: BrowserTab; active: boolean }) {
    const ref = useRef<WebviewTag>(null);
    // The src is set once: later navigation happens inside the page, and re-rendering with a new src would reload it.
    const [initialUrl] = useState(tab.url);
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
        };
        const onTitle = (e: any) => model.setState(updateTab(model.state(), tab.id, { title: e.title }));
        // emain turns window.open and target=_blank into this event (emain/preload.ts dispatches it to this webview).
        const onNewWindow = (e: any) => {
            e.preventDefault?.();
            const url = e.detail?.url;
            if (url) {
                model.newTab(url);
            }
        };
        const onFocus = () => {
            getApi().setWebviewFocus(webview.getWebContentsId());
            model.nodeModel.focusNode();
        };
        const onBlur = () => getApi().setWebviewFocus(null);
        // emain/preload.ts routes a page's new window by this attribute; the preload cannot call the element's methods.
        const onDomReady = () => {
            webview.dataset.webcontentsid = String(webview.getWebContentsId());
        };
        webview.addEventListener("did-navigate", onNavigate);
        webview.addEventListener("did-navigate-in-page", onNavigate);
        webview.addEventListener("page-title-updated", onTitle);
        webview.addEventListener("new-window", onNewWindow);
        webview.addEventListener("focus", onFocus);
        webview.addEventListener("blur", onBlur);
        webview.addEventListener("dom-ready", onDomReady);
        return () => {
            webview.removeEventListener("did-navigate", onNavigate);
            webview.removeEventListener("did-navigate-in-page", onNavigate);
            webview.removeEventListener("page-title-updated", onTitle);
            webview.removeEventListener("new-window", onNewWindow);
            webview.removeEventListener("focus", onFocus);
            webview.removeEventListener("blur", onBlur);
            webview.removeEventListener("dom-ready", onDomReady);
            if (model.webviews.get(tab.id) === webview) {
                model.webviews.delete(tab.id);
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
    const scrollRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const active = scrollRef.current?.querySelector<HTMLElement>(`[data-tabid="${state.activeId}"]`);
        active?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }, [state.activeId, state.tabs.length]);
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
                className="molten-browser-tabs flex min-w-0 shrink items-end gap-0.5 overflow-x-auto overflow-y-hidden [scrollbar-width:none]"
            >
                {state.tabs.map((tab, index) => (
                    <div
                        key={tab.id}
                        draggable
                        onDragStart={() => setDragId(tab.id)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => {
                            if (dragId != null) {
                                model.setState(moveTab(model.state(), dragId, index));
                            }
                            setDragId(null);
                        }}
                        onClick={() => model.setState(activateTab(model.state(), tab.id))}
                        onAuxClick={(e) => {
                            if (e.button === 1) {
                                e.preventDefault();
                                model.closeTab(tab.id);
                            }
                        }}
                        title={tab.url}
                        data-tabid={tab.id}
                        className={cn(
                            "molten-browser-tab group flex h-7 min-w-[72px] flex-[0_1_200px] cursor-pointer items-center gap-1 rounded-t border border-b-0 px-2 text-xs",
                            tab.id === state.activeId
                                ? "border-border bg-hover text-primary"
                                : "border-transparent text-secondary hover:bg-hover/50"
                        )}
                    >
                        <span className="min-w-0 flex-1 truncate">{browserTabTitle(tab) || "New tab"}</span>
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
    useEffect(() => {
        if (!editing) {
            setDraft(active?.url ?? "");
        }
    }, [active?.url, active?.id, editing]);
    const navButton = (icon: string, label: string, run: () => void) => (
        <button
            type="button"
            aria-label={label}
            title={label}
            onClick={run}
            className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-secondary hover:bg-hover hover:text-primary"
        >
            <i className={`fa fa-solid fa-${icon} text-xs`} />
        </button>
    );
    return (
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-1">
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
            {navButton("rotate-right", "Reload", () => model.activeWebview()?.reload())}
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
                    if (url != null) {
                        model.activeWebview()?.loadURL(url);
                        model.setState(updateTab(model.state(), state.activeId, { url }));
                    }
                    e.currentTarget.blur();
                }}
                className="h-6 min-w-0 flex-1 rounded border border-border bg-transparent px-2 text-xs text-primary outline-none focus:border-accent"
            />
        </div>
    );
}

function BrowserView({ model }: ViewComponentProps<BrowserViewModel>) {
    const state = useAtomValue(model.stateAtom);
    const block = useAtomValue(model.blockAtom);
    const isFocused = useAtomValue(model.nodeModel.isFocused);
    const blockMeta = block?.meta;
    useEffect(() => {
        model.handleOpenRequests(blockMeta);
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
            <div className="relative min-h-0 flex-1">
                {state.tabs.map((tab) => (
                    <TabWebview key={tab.id} model={model} tab={tab} active={tab.id === state.activeId} />
                ))}
            </div>
        </div>
    );
}
