// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The command palette (FR-SHELL-013, DS-SHELL-013): one component for the empty pane (Wave's launcher view) and for
// the global modal. A grouped, fuzzy-filtered list driven by the keyboard; the mouse works too.

import { atoms, getApi } from "@/app/store/global";
import { WorkspaceService } from "@/app/store/services";
import * as WOS from "@/app/store/wos";
import { getLayoutModelForStaticTab, LayoutNode } from "@/layout/index";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { atom, Atom, useAtomValue } from "jotai";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { BrowserEngineModel } from "../browser/browser-engine";
import { MoltentermBrowserView } from "../browser/browser-model";
import { formatShortcutById } from "../shortcuts/format";
import { cancelSplit, consumeSplit, isPendingSplit } from "../split/split";
import { SplitFromMetaKey } from "../split/split-model";
import { TermUpdates } from "../termupdate/termupdate-store";
import { WorkspaceIcon } from "../workspace-icon";
import { workspaceIconSource } from "../workspace-icon-model";
import { effectiveWorkspaceFolder, readRecentFolders, readWorkspaceProject } from "../workspace-project";
import { isSavedWorkspace } from "../workspace-rail-model";
import { PalettePlacement, runPaletteEntry } from "./palette-actions";
import {
    bestMatchIndex,
    filterPalette,
    flattenSections,
    highlightRuns,
    matchEntry,
    moveSelection,
    PaletteEntry,
    PaletteGroupOrder,
    paletteKeyCommand,
    PickerGroupOrder,
} from "./palette-model";
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
        if (ws == null || !isSavedWorkspace(ws)) {
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
            folders.push(effectiveWorkspaceFolder(ws), readWorkspaceProject(ws).dir);
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
    const source = useBlock(sourceId);
    return useMemo(() => {
        if (sourceId == null) {
            return null;
        }
        return {
            blockId: sourceId,
            meta: source?.meta ?? {},
            splitKeys: formatShortcutById("split-right"),
            companionKeys: formatShortcutById("companion"),
        };
    }, [sourceId, source?.meta]);
}

function usePaletteEntries(picker: PickerSource) {
    const fullConfig = useAtomValue(atoms.fullConfigAtom);
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
    const installedBrowser = browserList?.chosen ?? null;
    const hasBrowserPanel = (tab?.blockids ?? []).some(
        (blockId) => WOS.getObjectValue<Block>(WOS.makeORef("block", blockId))?.meta?.view === MoltentermBrowserView
    );
    const folder = effectiveWorkspaceFolder(ws);
    const projectLinked = readWorkspaceProject(ws).dir !== "";
    // A fresh array on every render: its content, joined, is what the memo depends on.
    const recentKey = readRecentFolders(ws).join("\n");
    const home = getHome();
    const entries = useMemo(
        () =>
            buildPaletteEntries({
                presets: fullConfig?.presets,
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
            }),
        [
            fullConfig,
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
        ]
    );
    const titles = useMemo(() => paletteGroupTitles(folder, home), [folder, home]);
    return { entries, titles };
}

function Highlighted({ text, indices }: { text: string; indices: number[] }) {
    if (!indices?.length) {
        return <>{text}</>;
    }
    return (
        <>
            {highlightRuns(text, indices).map((run, i) =>
                run.hit ? (
                    <span key={i} className="text-accent">
                        {run.text}
                    </span>
                ) : (
                    <React.Fragment key={i}>{run.text}</React.Fragment>
                )
            )}
        </>
    );
}

type PaletteRowProps = {
    entry: PaletteEntry;
    index: number;
    selected: boolean;
    query: string;
    onHover: (index: number) => void;
    onOpen: (entry: PaletteEntry, right: boolean) => void;
};

function PaletteRow({ entry, index, selected, query, onHover, onOpen }: PaletteRowProps) {
    const indices = query ? (matchEntry(query, entry)?.indices ?? []) : [];
    const aside = [entry.keyPath ?? entry.cli ?? entry.hint, entry.shortcut].filter((s) => s).join("  ·  ");
    return (
        <div
            role="option"
            aria-selected={selected}
            data-index={index}
            onMouseMove={() => onHover(index)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => onOpen(entry, e.altKey || e.metaKey)}
            title={entry.cli && !entry.keyPath ? `${entry.label} — ${entry.cli}` : entry.label}
            className={cn(
                "flex cursor-pointer items-center gap-2.5 px-3.5 py-1.5 text-[13px]",
                selected ? "molten-palette-selected text-primary" : "text-secondary"
            )}
        >
            {entry.badge?.image || entry.badge?.logo ? (
                <span className="flex w-4 shrink-0 items-center justify-center" data-role="palette-workspace-badge">
                    <WorkspaceIcon source={entry.badge} className="text-[11px]" />
                </span>
            ) : (
                <i
                    className={cn(
                        makeIconClass(entry.icon, true, { defaultIcon: "browser" }),
                        "w-4 shrink-0 text-center"
                    )}
                    style={{ color: entry.color }}
                />
            )}
            <span className="shrink-0 whitespace-nowrap">
                <Highlighted text={entry.label} indices={indices} />
            </span>
            {entry.detail && <span className="min-w-0 truncate text-xs text-muted">{entry.detail}</span>}
            {aside && (
                <span
                    className={cn(
                        "ml-auto max-w-[45%] shrink-0 truncate pl-3 font-mono text-[11px]",
                        selected ? "text-secondary" : "text-muted"
                    )}
                >
                    {aside}
                </span>
            )}
        </div>
    );
}

export function CommandPalette({ host, blockId, inPlace, inputRef, autoFocus, onClose }: CommandPaletteProps) {
    const picker = usePickerSource(host, blockId);
    const { entries, titles } = usePaletteEntries(picker);
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState(0);
    const ownInputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const order = picker != null ? PickerGroupOrder : PaletteGroupOrder;
    const sections = useMemo(() => filterPalette(entries, query, titles, order), [entries, query, titles, order]);
    const flat = useMemo(() => flattenSections(sections), [sections]);
    const input = inputRef ?? ownInputRef;
    const layoutModel = getLayoutModelForStaticTab();
    const focusedNode = useAtomValue(layoutModel?.focusedNode ?? NullNodeAtom);
    const focusedBlockId = focusedNode?.data?.blockId;
    const queryRef = useRef(query);
    queryRef.current = query;
    const pickerWasFocused = useRef(false);

    useEffect(() => {
        setSelected(Math.max(bestMatchIndex(sections, query), 0));
    }, [query]);
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
        // In a split's picker the entry fills the new panel: it was opened for that.
        const placement: PalettePlacement = right && blockId && picker == null ? "right" : inPlace;
        if (host === "modal") {
            onClose?.("open");
        }
        if (picker != null) {
            consumeSplit(blockId);
        }
        fireAndForget(() => runPaletteEntry(entry.run, { placement, blockId }));
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.nativeEvent.isComposing) {
            return;
        }
        const command = paletteKeyCommand({
            key: e.key,
            shift: e.shiftKey,
            ctrl: e.ctrlKey,
            meta: e.metaKey,
            alt: e.altKey,
        });
        if (command == null) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
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

    let index = 0;
    return (
        <div
            className={cn(
                "flex w-full max-w-[560px] flex-col overflow-hidden rounded-md border border-border bg-modalbg shadow-2xl",
                host === "modal" ? "max-h-[60vh]" : "max-h-full"
            )}
            role="dialog"
            aria-label="Command palette"
        >
            <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
                <span className="font-mono text-accent">❯</span>
                <input
                    ref={input}
                    type="text"
                    value={query}
                    spellCheck={false}
                    placeholder="Open an agent, a panel, a folder…"
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onKeyDown}
                    className="min-w-0 flex-1 bg-transparent text-sm text-primary outline-none placeholder:text-muted"
                    aria-label="Search the command palette"
                    aria-controls="molten-palette-list"
                />
            </div>
            <div ref={listRef} id="molten-palette-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto py-1">
                {flat.length === 0 && <div className="px-3.5 py-3 text-xs text-muted">Nothing matches "{query}"</div>}
                {sections.map((section) => (
                    <div key={section.group}>
                        {/* Not uppercased: a title can hold a path, and paths are case-sensitive. */}
                        <div className="truncate px-3.5 pt-2 pb-0.5 text-[11px] font-semibold tracking-wide text-muted">
                            {section.title}
                        </div>
                        {section.entries.map((entry) => {
                            const i = index++;
                            return (
                                <PaletteRow
                                    key={entry.id}
                                    entry={entry}
                                    index={i}
                                    selected={i === selected}
                                    query={query}
                                    onHover={setSelected}
                                    onOpen={open}
                                />
                            );
                        })}
                    </div>
                ))}
            </div>
            <div className="flex flex-wrap gap-x-3.5 gap-y-1 border-t border-border px-3.5 py-2 text-[10.5px] text-muted">
                <span>↑↓ choose</span>
                <span>↵ {inPlace === "replace" ? "open here" : "open"}</span>
                {blockId && picker == null && <span>⇥ open to the right</span>}
                <span>esc {host === "modal" ? "close" : picker != null ? "cancel the split" : "clear"}</span>
            </div>
        </div>
    );
}
