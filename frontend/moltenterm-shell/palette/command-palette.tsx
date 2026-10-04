// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The command palette (FR-SHELL-013, DS-SHELL-013): one component for the empty pane (Wave's launcher view) and for
// the global modal. A grouped, fuzzy-filtered list driven by the keyboard; the mouse works too.

import { atoms, getApi } from "@/app/store/global";
import { WorkspaceService } from "@/app/store/services";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import React, { useEffect, useMemo, useRef, useState } from "react";
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
    paletteKeyCommand,
} from "./palette-model";
import { buildPaletteEntries, paletteGroupTitles, PaletteWorkspace } from "./palette-sources";

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
        list.push({ id: ws.oid, name: ws.name, icon: ws.icon, color: ws.color, active: ws.oid === activeId });
        if (ws.oid !== activeId) {
            folders.push(effectiveWorkspaceFolder(ws), readWorkspaceProject(ws).dir);
        }
    }
    return { list, folders: folders.filter((f) => f) };
}

function usePaletteEntries() {
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
            }),
        [fullConfig, wsId, folder, recentKey, others, home, projectLinked]
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
    const aside = entry.cli ?? entry.hint;
    return (
        <div
            role="option"
            aria-selected={selected}
            data-index={index}
            onMouseMove={() => onHover(index)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => onOpen(entry, e.altKey || e.metaKey)}
            title={entry.cli ? `${entry.label} — ${entry.cli}` : entry.label}
            className={cn(
                "flex cursor-pointer items-center gap-2.5 px-3.5 py-1.5 text-[13px]",
                selected ? "molten-palette-selected text-primary" : "text-secondary"
            )}
        >
            <i
                className={cn(makeIconClass(entry.icon, true, { defaultIcon: "browser" }), "w-4 shrink-0 text-center")}
                style={{ color: entry.color }}
            />
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
    const { entries, titles } = usePaletteEntries();
    const [query, setQuery] = useState("");
    const [selected, setSelected] = useState(0);
    const ownInputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const sections = useMemo(() => filterPalette(entries, query, titles), [entries, query, titles]);
    const flat = useMemo(() => flattenSections(sections), [sections]);
    const input = inputRef ?? ownInputRef;

    useEffect(() => {
        setSelected(Math.max(bestMatchIndex(sections, query), 0));
    }, [query]);
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
        const placement: PalettePlacement = right && blockId ? "right" : inPlace;
        if (host === "modal") {
            onClose?.("open");
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
            // In a pane there is nothing to close (Cmd+W closes the pane): Esc clears the filter.
            if (host === "modal") {
                onClose?.("dismiss");
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
                {blockId && <span>⇥ open to the right</span>}
                <span>esc {host === "modal" ? "close" : "clear"}</span>
            </div>
        </div>
    );
}
