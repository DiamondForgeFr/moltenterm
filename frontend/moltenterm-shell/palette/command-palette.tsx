// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The command palette (FR-SHELL-013, DS-SHELL-013): one component for the empty pane (Wave's launcher view) and for
// the global modal. A grouped, fuzzy-filtered list driven by the keyboard; the mouse works too.

import { atoms, getApi, getSettingsKeyAtom } from "@/app/store/global";
import { WorkspaceService } from "@/app/store/services";
import * as WOS from "@/app/store/wos";
import { getLayoutModelForStaticTab, LayoutNode } from "@/layout/index";
import { cn, fireAndForget } from "@/util/util";
import { atom, Atom, useAtomValue } from "jotai";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useFeatureMatrix } from "../agent-info/agent-features-model";
import type { AgentStateInfo } from "../agent-state-model";
import { BossBubbleModel } from "../boss/boss-store";
import { useBossName } from "../boss/use-boss-name";
import { BrainstormLastLeftAtom } from "../brainstorm/brainstorm-boot";
import { BrowserEngineModel } from "../browser/browser-engine";
import { MoltentermBrowserView } from "../browser/browser-model";
import { DefaultSearchSettingKey } from "../browser/search-engine-model";
import { useBrainstormGates } from "../build/use-feature-on";
import { useKnownCodingAgents } from "../coding-agent/coding-agent";
import { panelPaletteEntries } from "../command-panel/command-panel-palette";
import { getContextFolder, isInWindowContext, useContextFolder } from "../contexts/context-store";
import { useLocale, useT } from "../i18n/i18n";
import { FavoritesRow } from "../newview/favorites-row";
import {
    chooserAriaKey,
    chooserFooterKey,
    chooserKey,
    chooserPreselect,
    firstAgentIndex,
    paletteListing,
    webTargetFavorite,
} from "../newview/new-view-model";
import { NewViewMorphHint } from "../newview/new-view-morph-hint";
import { formatShortcutById } from "../shortcuts/format";
import { keepToggleMove, pinMoves, viewMenuPlan } from "../sidebar/view-menu-model";
import { keepViewKeysLabel } from "../sidebar/view-pin-actions";
import { isProjectTab } from "../sidebar/view-pins-model";
import { ViewPins } from "../sidebar/view-pins-store";
import { cancelSplit, consumeSplit, isPendingSplit, readSplitFrom } from "../split/split";
import {
    pickerFitsInline,
    PickerMinPx,
    pickerPopoverRect,
    pickerSourceMeta,
    SplitFromMetaKey,
    SplitNewPanelMetaKey,
} from "../split/split-model";
import { TermUpdates } from "../termupdate/termupdate-store";
import { workspaceIconSource } from "../workspace-icon-model";
import {
    boundingFolder,
    effectiveWorkspaceFolder,
    readRecentFolders,
    readWorkspaceProject,
} from "../workspace-project";
import { isSavedWorkspace } from "../workspace-rail-model";
import { PalettePlacement, runPaletteEntry } from "./palette-actions";
import {
    bestMatchIndex,
    filterPalette,
    flattenSections,
    moveSelection,
    PaletteEntry,
    PaletteGroupOrder,
    paletteKeyCommand,
    paletteOpenPlan,
    PickerGroupOrder,
} from "./palette-model";
import { PaletteRow } from "./palette-row";
import { buildPaletteEntries, paletteGroupTitles, PaletteWorkspace, PickerSource } from "./palette-sources";

export type CommandPaletteHost = "pane" | "modal";

type CommandPaletteProps = {
    host: CommandPaletteHost;
    // The pane the palette lives in (pane host), or the pane that was focused when the modal opened.
    blockId: string;
    // Where Enter opens an entry: the pane itself, or a new pane of the tab.
    inPlace: PalettePlacement;
    inputRef?: React.RefObject<HTMLInputElement>;
    autoFocus?: boolean;
    // "open" when an entry was chosen (its pane takes the focus), "dismiss" on Esc.
    onClose?: (reason: "open" | "dismiss") => void;
    // A new view's chooser (FR-SHELL-089): favourites on top, Enter opens in the view, Escape cancels the view.
    newView?: NewViewChooser;
};

export type NewViewChooser = {
    favorites: PaletteEntry[];
    // Each favourite's direct shortcut as shown, by position.
    favoriteKeys: string[];
    onOpen: (entry: PaletteEntry) => void;
    onCancel: () => void;
    // Nothing matches (#1672): the view goes and the agent gets the morph call with what was typed, not sent.
    onAskAgent: (agent: AgentStateInfo, request: string) => Promise<void>;
    // Opened by "Start an agent" (#1672): the first agent of the list is selected instead of a favourite.
    focusAgents?: boolean;
    // Opened as a new panel (#1742): the id of the entry selected first, a favourite or a row of the list.
    preselect?: string;
    // A new panel's chooser: Escape cancels the new panel, which the footer and the dialog's label say.
    inPanel?: boolean;
};

type OtherWorkspaces = { list: PaletteWorkspace[]; folders: string[] };

let homeDir: string = null;

function getHome(): string {
    if (homeDir == null) {
        try {
            homeDir = getApi()?.getHomeDir?.() ?? "";
        } catch {
            homeDir = "";
        }
    }
    return homeDir;
}

async function loadWorkspaces(activeId: string): Promise<OtherWorkspaces> {
    const list: PaletteWorkspace[] = [];
    const folders: string[] = [];
    for (const entry of (await WorkspaceService.ListWorkspaces()) ?? []) {
        const ws = await WorkspaceService.GetWorkspace(entry.workspaceid);
        if (ws == null || !isSavedWorkspace(ws) || !isInWindowContext(ws.meta)) {
            continue;
        }
        const { image, logo } = workspaceIconSource(ws);
        list.push({
            id: ws.oid,
            name: ws.name,
            icon: ws.icon,
            color: ws.color,
            image,
            logo,
            active: ws.oid === activeId,
        });
        if (ws.oid !== activeId) {
            folders.push(effectiveWorkspaceFolder(ws, getContextFolder(ws)), readWorkspaceProject(ws).dir);
        }
    }
    return { list, folders: folders.filter((f) => f) };
}

const NullBlockAtom = atom(null) as Atom<Block>;
const NullNodeAtom = atom(null) as Atom<LayoutNode>;

function useBlock(blockId: string): Block {
    return useAtomValue(blockId ? WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)) : NullBlockAtom);
}

// The palette is a split's picker when its pane was opened by a split (FR-SHELL-042, DS-SHELL-066).
function usePickerSource(host: CommandPaletteHost, blockId: string): PickerSource {
    const own = useBlock(host === "pane" ? blockId : null);
    const from = own?.meta?.[SplitFromMetaKey as keyof MetaType];
    const sourceId = typeof from === "string" && from !== "" ? from : null;
    const newPanel = own?.meta?.[SplitNewPanelMetaKey as keyof MetaType] === true;
    const source = useBlock(sourceId);
    // Only what the picker reads of the source: its other meta changes (a terminal's state) must not rebuild the list.
    const view = source?.meta?.view;
    const cwd = source?.meta?.["cmd:cwd"];
    const connection = source?.meta?.connection;
    const ws = useAtomValue(atoms.workspace);
    const bound = boundingFolder(ws, useContextFolder(ws));
    return useMemo(() => {
        if (sourceId == null) {
            return null;
        }
        // A new column's picker opens its terminal and files in the workspace folder, a split's where the source is,
        // unless the source lies outside the workspace's bounding folder (#2516).
        const meta = pickerSourceMeta(
            { [SplitNewPanelMetaKey]: newPanel },
            { view, "cmd:cwd": cwd, connection },
            bound
        );
        return {
            blockId: sourceId,
            meta,
            splitKeys: formatShortcutById("split-right"),
            companionKeys: formatShortcutById("companion"),
        };
    }, [sourceId, newPanel, view, cwd, connection, bound]);
}

// Also the sidebar's top field (#1187): every palette command stays reachable from it.
export function usePaletteEntries(picker: PickerSource) {
    const fullConfig = useAtomValue(atoms.fullConfigAtom);
    const installedAgents = useKnownCodingAgents();
    const ws = useAtomValue(atoms.workspace);
    const [others, setOthers] = useState<OtherWorkspaces>({ list: [], folders: [] });
    const wsId = ws?.oid;
    useEffect(() => {
        let live = true;
        fireAndForget(async () => {
            const loaded = await loadWorkspaces(wsId);
            if (live) {
                setOthers(loaded);
            }
        });
        return () => {
            live = false;
        };
    }, [wsId]);
    const browserList = useAtomValue(BrowserEngineModel.getInstance().listAtom);
    const tabId = useAtomValue(atoms.staticTabId);
    const tab = useAtomValue(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
    useEffect(() => {
        fireAndForget(() => BrowserEngineModel.getInstance().ensureLoaded());
    }, []);
    const outdatedTerminals = useAtomValue(TermUpdates.getInstance().countAtom);
    const pins = ViewPins.getInstance();
    const viewState = useAtomValue(pins.stateAtom(tabId));
    const viewModified = useAtomValue(pins.modifiedAtom(tabId));
    const locale = useLocale();
    const matrix = useFeatureMatrix();
    const bossShown = useAtomValue(BossBubbleModel.getInstance().showAtom);
    const bossName = useBossName();
    const projectTab = isProjectTab(tab);
    const hasTab = tab != null;
    const viewPin = useMemo(
        () => ({
            moves: hasTab ? pinMoves(viewMenuPlan(viewState, viewModified, projectTab)) : [],
            keepMove: keepToggleMove(viewState, projectTab),
            keepHint: keepViewKeysLabel(),
        }),
        [viewState, viewModified, projectTab, hasTab, locale]
    );
    const installedBrowser = browserList?.chosen ?? null;
    const hasBrowserPanel = (tab?.blockids ?? []).some(
        (blockId) => WOS.getObjectValue<Block>(WOS.makeORef("block", blockId))?.meta?.view === MoltentermBrowserView
    );
    const folder = effectiveWorkspaceFolder(ws, useContextFolder(ws));
    const projectLinked = readWorkspaceProject(ws).dir !== "";
    // A fresh array on every render: its content, joined, is what the memo depends on.
    const recentKey = readRecentFolders(ws).join("\n");
    const home = getHome();
    const gates = useBrainstormGates();
    // The brainstorm last left is offered to resume (#2284).
    const lastLeft = useAtomValue(BrainstormLastLeftAtom);
    const brainstorm = useMemo(() => ({ ...gates, resume: lastLeft?.title ?? "" }), [gates, lastLeft]);
    const entries = useMemo(
        () =>
            buildPaletteEntries({
                presets: fullConfig?.presets,
                installedAgents,
                matrix,
                widgets: fullConfig?.widgets,
                workspaceId: wsId,
                folder,
                recentFolders: recentKey === "" ? [] : recentKey.split("\n"),
                otherFolders: others.folders,
                workspaces: others.list,
                home,
                projectLinked,
                installedBrowser,
                hasBrowserPanel,
                outdatedTerminals,
                picker,
                shortcutsHint: formatShortcutById("shortcuts"),
                viewPin,
                bossName: bossShown ? bossName : undefined,
                brainstorm,
            }),
        [
            fullConfig,
            installedAgents,
            wsId,
            folder,
            recentKey,
            others,
            home,
            projectLinked,
            installedBrowser,
            hasBrowserPanel,
            outdatedTerminals,
            picker,
            locale,
            viewPin,
            matrix,
            bossShown,
            bossName,
            brainstorm,
        ]
    );
    const titles = useMemo(() => paletteGroupTitles(folder, home), [folder, home, locale]);
    return { entries, titles };
}

type PopoverRect = { left: number; top: number; width: number; height: number };

// A split's picker keeps at least six rows (FR-SHELL-046-AC6, DS-SHELL-084): inline while the new panel has the room,
// else a popover anchored to the panel, above the layout. The anchor is a hidden element left in the pane, so the
// pane's own free height is measured even while the palette is in the popover.
function usePickerPopover(enabled: boolean, anchorRef: React.RefObject<HTMLElement>): PopoverRect {
    const [rect, setRect] = useState<PopoverRect>(null);
    useLayoutEffect(() => {
        const container = anchorRef.current?.parentElement;
        if (!enabled || container == null) {
            setRect(null);
            return;
        }
        const measure = () => {
            const style = getComputedStyle(container);
            const free = container.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
            if (pickerFitsInline(free)) {
                setRect(null);
                return;
            }
            const panel = (container.closest("[data-blockid]") ?? container).getBoundingClientRect();
            const next = pickerPopoverRect(panel, { width: window.innerWidth, height: window.innerHeight });
            setRect((prev) =>
                prev != null &&
                prev.left === next.left &&
                prev.top === next.top &&
                prev.width === next.width &&
                prev.height === next.height
                    ? prev
                    : next
            );
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(container);
        window.addEventListener("resize", measure);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", measure);
        };
    }, [enabled, anchorRef]);
    return rect;
}

export function CommandPalette({ host, blockId, inPlace, inputRef, autoFocus, onClose, newView }: CommandPaletteProps) {
    const t = useT();
    const picker = usePickerSource(host, blockId);
    const { entries, titles } = usePaletteEntries(picker);
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState(0);
    const favCount = newView?.favorites?.length ?? 0;
    // The selected favourite of a new view's chooser; -1 while the selection is in the list.
    const [fav, setFav] = useState(favCount > 0 ? 0 : -1);
    // "Start an agent" (#1672): the selection goes to the first agent once the cleared search shows the whole list.
    const agentsFocus = useRef(false);
    // The launcher's empty result action, Enter's when nothing matches (#1672).
    const morphAction = useRef<() => void>(null);
    const ownInputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const baseOrder = picker != null ? PickerGroupOrder : PaletteGroupOrder;
    // The origin pane's command panel items join the list once something is typed (FR-SHELL-047), built then and
    // not on the palette's open path.
    const searching = query.trim() !== "";
    const searchTemplate = useAtomValue(getSettingsKeyAtom(DefaultSearchSettingKey));
    const panelEntries = useMemo(
        () =>
            searching && host === "modal" && blockId
                ? panelPaletteEntries(blockId, formatShortcutById("command-panel"))
                : [],
        [host, blockId, searching]
    );
    const locale = useLocale();
    // In every mode (#2312, #2545) the typed words always have a way forward: an address opens, any other words are a
    // web search, last when a result is found through what its row shows, first and selected when none is.
    const inChooser = newView != null;
    const listing = useMemo(() => {
        const all = searching && panelEntries.length > 0 ? [...entries, ...panelEntries] : entries;
        return paletteListing(all, query, searchTemplate, baseOrder, inChooser, t);
    }, [entries, panelEntries, searching, query, inChooser, searchTemplate, baseOrder, locale]);
    const { listed, order, webFirst } = listing;
    // The way forward of an empty result (#1672) stays under the web row: asking the agent for a tool when no result
    // matches what was typed, which a web search does not replace.
    const morphOffered = inChooser && webFirst && !listing.address;
    const sections = useMemo(() => filterPalette(listed, query, titles, order), [listed, query, titles, order]);
    const flat = useMemo(() => flattenSections(sections), [sections]);
    const input = inputRef ?? ownInputRef;
    const layoutModel = getLayoutModelForStaticTab();
    const focusedNode = useAtomValue(layoutModel?.focusedNode ?? NullNodeAtom);
    const focusedBlockId = focusedNode?.data?.blockId;
    const queryRef = useRef(query);
    queryRef.current = query;
    const pickerWasFocused = useRef(false);
    const anchorRef = useRef<HTMLSpanElement>(null);
    const pickerInPane = host === "pane" && picker != null;
    const popover = usePickerPopover(pickerInPane, anchorRef);
    const inPopover = popover != null;

    // Moving between the pane and the popover mounts the palette again: the search keeps its focus.
    useEffect(() => {
        if (!pickerInPane || focusedBlockId !== blockId) {
            return;
        }
        input.current?.focus();
    }, [inPopover]);

    useEffect(() => {
        if (agentsFocus.current) {
            agentsFocus.current = false;
            setFav(-1);
            setSelected(Math.max(firstAgentIndex(flat), 0));
            return;
        }
        setSelected(Math.max(bestMatchIndex(sections, query), 0));
        if (favCount > 0) {
            setFav(query.trim() === "" ? 0 : -1);
        }
    }, [query]);
    // A new panel's chooser (#1742) starts on the type of the focused panel, until the developer moves the selection.
    const preselectPending = useRef(newView?.preselect != null);
    useEffect(() => {
        if (!preselectPending.current || newView?.preselect == null) {
            return;
        }
        const pick = chooserPreselect(newView.favorites, flat, newView.preselect);
        if (pick == null) {
            return;
        }
        preselectPending.current = false;
        setFav(pick.fav);
        setSelected(pick.selected);
    }, [flat, newView]);
    // A chooser opened by the Library's "Start an agent" (#1672) starts on the first agent.
    const focusAgents = newView?.focusAgents === true;
    useEffect(() => {
        if (!focusAgents) {
            return;
        }
        setFav(-1);
        setSelected(Math.max(firstAgentIndex(flat), 0));
    }, [focusAgents]);
    // A click on another panel before anything was chosen or typed cancels the split; the clicked panel keeps the
    // focus (DS-SHELL-066).
    useEffect(() => {
        if (picker == null || !blockId) {
            return;
        }
        if (focusedBlockId === blockId) {
            pickerWasFocused.current = true;
            return;
        }
        if (!pickerWasFocused.current || focusedBlockId == null || queryRef.current.trim() !== "") {
            return;
        }
        // The picker was split again (Cmd+D in it): the new picker comes from this one, which stays.
        if (readSplitFrom(focusedBlockId) === blockId) {
            return;
        }
        if (!isPendingSplit(blockId)) {
            return;
        }
        fireAndForget(() => cancelSplit(blockId, true));
    }, [focusedBlockId, picker, blockId]);
    useEffect(() => {
        if (autoFocus) {
            input.current?.focus();
        }
    }, [autoFocus, input]);
    useEffect(() => {
        listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
    }, [selected]);

    const open = (entry: PaletteEntry, right: boolean) => {
        if (entry == null) {
            return;
        }
        if (newView != null) {
            newView.onOpen(entry);
            return;
        }
        // In a split's picker the entry fills the new panel: it was opened for that.
        const plan = paletteOpenPlan(entry.run, { inPlace, right, blockId, picker: picker != null });
        if (host === "modal") {
            onClose?.("open");
        }
        if (plan.kind === "elsewhere") {
            // An action that opens nothing in the new panel (a tab, the settings, a workspace) cancels the split
            // first, so no empty panel stays behind; "back to the origin" is the source panel.
            fireAndForget(async () => {
                await cancelSplit(blockId, !plan.focusOrigin);
                if (!plan.focusOrigin) {
                    await runPaletteEntry(entry.run, { placement: "new", blockId: picker.blockId });
                }
            });
            return;
        }
        if (plan.consumeSplit) {
            consumeSplit(blockId);
        }
        fireAndForget(() => runPaletteEntry(entry.run, { placement: plan.placement, blockId }));
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.nativeEvent.isComposing) {
            return;
        }
        const key = { key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey };
        preselectPending.current = false;
        if (newView != null) {
            const action = chooserKey({ fav, favCount, selected, listCount: flat.length, query }, key);
            if (action != null) {
                e.preventDefault();
                e.stopPropagation();
                switch (action.kind) {
                    case "fav":
                        setFav(action.index);
                        break;
                    case "list":
                        setFav(-1);
                        setSelected(action.index);
                        break;
                    case "openfav":
                        newView.onOpen(newView.favorites[action.index]);
                        break;
                    case "cancel":
                        newView.onCancel();
                        break;
                }
                return;
            }
        }
        const command = paletteKeyCommand(key);
        if (command == null) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        if (command === "open" && flat.length === 0 && morphAction.current != null) {
            morphAction.current();
            return;
        }
        if (command === "open" || command === "open-right") {
            open(flat[selected], command === "open-right");
            return;
        }
        if (command === "close") {
            // In a pane there is nothing to close (Cmd+W closes the pane): Esc clears the filter. A split's picker
            // cancels the split instead (DS-SHELL-066).
            if (host === "modal") {
                onClose?.("dismiss");
            } else if (picker != null) {
                fireAndForget(async () => {
                    if (!(await cancelSplit(blockId))) {
                        setQuery("");
                    }
                });
            } else {
                setQuery("");
            }
            return;
        }
        setSelected(moveSelection(selected, command, flat.length));
    };

    const startAgent = () => {
        agentsFocus.current = true;
        setQuery("");
        input.current?.focus();
    };

    const onListHover = (i: number) => {
        preselectPending.current = false;
        setFav(-1);
        setSelected(i);
    };

    let index = 0;
    const palette = (
        <div
            className={cn(
                "flex w-full max-w-[560px] flex-col overflow-hidden rounded-4 border border-border bg-surface-3 shadow-command",
                host === "modal" ? "max-h-[60vh]" : "max-h-full",
                inPopover && "h-full"
            )}
            style={pickerInPane && !inPopover ? { minHeight: PickerMinPx } : undefined}
            role="dialog"
            aria-label={t(newView != null ? chooserAriaKey(newView.inPanel === true) : "palette.ariaPalette")}
            data-role={pickerInPane ? (inPopover ? "split-picker-popover" : "split-picker") : undefined}
        >
            {newView != null ? (
                <FavoritesRow
                    favorites={newView.favorites}
                    keys={newView.favoriteKeys}
                    selected={fav}
                    target={fav < 0 ? webTargetFavorite(newView.favorites, flat[selected]) : -1}
                    onHover={setFav}
                    onOpen={newView.onOpen}
                />
            ) : null}
            <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
                <span className="font-mono text-accent">❯</span>
                <input
                    ref={input}
                    type="text"
                    value={query}
                    spellCheck={false}
                    placeholder={t("palette.placeholder")}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onKeyDown}
                    className="min-w-0 flex-1 bg-transparent text-13 leading-5 text-primary outline-none placeholder:text-muted"
                    aria-label={t("palette.ariaSearch")}
                    aria-controls="molten-palette-list"
                />
            </div>
            <div ref={listRef} id="molten-palette-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto py-1">
                {flat.length === 0 && (
                    <div className="px-3.5 py-3 text-12 text-muted">{t("palette.noMatch", { query })}</div>
                )}
                {sections.map((section) => (
                    <div
                        key={section.group}
                        className={cn(section.group === "web" && !webFirst && "mt-1 border-t border-border pt-1")}
                    >
                        {/* Not uppercased: a title can hold a path, and paths are case-sensitive. */}
                        {section.title !== "" && (
                            <div className="truncate px-3.5 pt-2 pb-0.5 text-11 font-semibold tracking-wide text-muted">
                                {section.title}
                            </div>
                        )}
                        {section.entries.map((entry) => {
                            const i = index++;
                            return (
                                <PaletteRow
                                    key={entry.id}
                                    entry={entry}
                                    index={i}
                                    selected={fav < 0 && i === selected}
                                    query={query}
                                    onHover={onListHover}
                                    onOpen={open}
                                />
                            );
                        })}
                    </div>
                ))}
                {morphOffered && newView != null && (
                    <NewViewMorphHint
                        query={query}
                        onAsk={newView.onAskAgent}
                        onStartAgent={startAgent}
                        actionRef={morphAction}
                    />
                )}
            </div>
            {newView != null ? (
                <div
                    className="flex flex-wrap gap-x-3.5 gap-y-1 border-t border-border px-3.5 py-2 text-11 text-muted"
                    data-testid="new-view-hint"
                >
                    <span>← → {t("newView.hint.choose")}</span>
                    <span>↵ {t("newView.hint.open")}</span>
                    <span>↓ {t("newView.hint.all")}</span>
                    <span>esc {t(chooserFooterKey(newView.inPanel === true))}</span>
                </div>
            ) : (
                <div className="flex flex-wrap gap-x-3.5 gap-y-1 border-t border-border px-3.5 py-2 text-11 text-muted">
                    <span>↑↓ {t("palette.footer.choose")}</span>
                    <span>↵ {t(inPlace === "replace" ? "palette.footer.openHere" : "palette.footer.open")}</span>
                    {blockId && picker == null && <span>⇥ {t("palette.footer.openRight")}</span>}
                    <span>
                        esc{" "}
                        {t(
                            host === "modal"
                                ? "palette.footer.close"
                                : picker != null
                                  ? "palette.footer.cancelSplit"
                                  : "palette.footer.clear"
                        )}
                    </span>
                </div>
            )}
        </div>
    );
    if (!pickerInPane) {
        return palette;
    }
    return (
        <>
            <span ref={anchorRef} className="hidden" aria-hidden />
            {inPopover
                ? createPortal(
                      <div
                          className="fixed z-[600] flex"
                          style={{ left: popover.left, top: popover.top, width: popover.width, height: popover.height }}
                      >
                          {palette}
                      </div>,
                      document.body
                  )
                : palette}
        </>
    );
}
