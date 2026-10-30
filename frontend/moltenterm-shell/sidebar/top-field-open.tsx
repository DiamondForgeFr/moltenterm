// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The open top field (FR-SHELL-083): its sources, search results, popover and runs. Loaded once the sidebar is on
// screen, or on the first ⌘L or click when that comes first (top-field.tsx), so it stays out of the JS every tab
// view loads up front (NFR-PERF-003, bundle.initialJsMB).

import { atoms, createBlock, getApi, getBlockComponentModel, globalStore, refocusNode, WOS } from "@/app/store/global";
import { WorkspaceService } from "@/app/store/services";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { isMacOS } from "@/util/platformutil";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { agentLabel, AgentStateInfo, agentStateLabel } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { browserBlockDef } from "../browser/browser-model";
import { blockIdOfORef, focusWhenPlaced } from "../browser/focus-placed";
import { panelPaletteEntries } from "../command-panel/command-panel-palette";
import { useT } from "../i18n/i18n";
import { usePaletteEntries } from "../palette/command-palette";
import { runPaletteEntry } from "../palette/palette-actions";
import { ProjectTabMetaKey, tabShownName } from "../project/project-model";
import { showPanel } from "../review/review-panels";
import { useListedReviewsAnswer } from "../reviews/reviews-client";
import { ReviewsModel } from "../reviews/reviews-store";
import { formatKeys, formatShortcutById } from "../shortcuts/format";
import { panelIcon, PanelMeta, tabDisplayName } from "../tab-identity";
import { colourChoiceCss, colourChoiceForeground, colourStops } from "../workspace-colour";
import { workspaceShownName } from "../workspace-default-name";
import { pathBaseName, readWorkspaceProject } from "../workspace-project";
import { loadWorkspaceSources } from "../workspace-rail";
import { isSavedWorkspace, makeWorkspaceRailEntries } from "../workspace-rail-model";
import { SidebarGlyph } from "./sidebar-icons";
import { workspaceJumpKeys } from "./sidebar-keys";
import { SidebarModel } from "./sidebar-store";
import { FocusFactsValue, homeDir, TypedText } from "./top-field";
import {
    AddressMode,
    enterRun,
    fieldHint,
    fieldResults,
    FieldRow,
    FieldRun,
    hostOfUrl,
    paletteFieldRows,
    palettePlacement,
    placePopover,
    PopoverPlace,
} from "./top-field-model";
import { TopFieldModel } from "./top-field-store";

const BlurCloseMs = 120;
const MaxTabsLoaded = 300;
const HiddenTabsMetaKey = "molten:hiddentabs";

type TFn = (key: string, vars?: Record<string, any>) => string;
async function loadObject<T extends WaveObj>(oref: string): Promise<T> {
    const cached = WOS.getObjectValue<T>(oref);
    if (cached != null) {
        return cached;
    }
    try {
        return await WOS.reloadWaveObject<T>(oref);
    } catch {
        return null;
    }
}

type LoadedSources = { views: FieldRow[]; workspaces: FieldRow[] };

// Views and workspaces of every workspace, read when the field opens.
async function loadSources(t: TFn, activeId: string): Promise<LoadedSources> {
    const sources = await loadWorkspaceSources();
    const active = sources.find((s) => s.workspace?.oid === activeId)?.workspace;
    const entries = makeWorkspaceRailEntries(sources, active).filter((e) => e.saved || e.active);
    const views: FieldRow[] = [];
    const workspaces: FieldRow[] = [];
    const home = homeDir();
    let loaded = 0;
    entries.forEach((entry, index) => {
        const ws = sources.find((s) => s.workspace?.oid === entry.id)?.workspace;
        if (ws == null || entry.active || !isSavedWorkspace(ws)) {
            return;
        }
        const stops = colourStops(ws.color);
        const project = readWorkspaceProject(ws).dir;
        const name = workspaceShownName(ws.name, t);
        workspaces.push({
            id: `workspace:${ws.oid}`,
            group: "workspace",
            label: name,
            note: project ? pathBaseName(project) : undefined,
            where:
                index < 9
                    ? `${t("topField.where.workspace")} · ${formatKeys(workspaceJumpKeys(index + 1, isMacOS()))}`
                    : t("topField.where.workspace"),
            workspaceName: name,
            letter: {
                text: (Array.from(name)[0] ?? "").toUpperCase(),
                paint: stops.length > 0 ? colourChoiceCss(ws.color) : "var(--color-secondary)",
                ink: stops.length > 0 ? colourChoiceForeground(ws.color) : "black",
            },
            keywords: ["workspace"],
            run: { kind: "workspace", workspaceId: ws.oid },
        });
    });
    for (const s of sources) {
        const ws = s.workspace;
        if (ws == null || (!isSavedWorkspace(ws) && ws.oid !== activeId)) {
            continue;
        }
        const here = ws.oid === activeId;
        const hidden = new Set<string>((ws.meta as Record<string, any>)?.[HiddenTabsMetaKey] ?? []);
        const wsName = workspaceShownName(ws.name, t) || t("rail.unsavedWorkspace");
        for (const tabId of ws.tabids ?? []) {
            if (hidden.has(tabId) || loaded >= MaxTabsLoaded) {
                continue;
            }
            loaded++;
            const tab = await loadObject<Tab>(WOS.makeORef("tab", tabId));
            if (tab == null) {
                continue;
            }
            const firstId = tab.blockids?.[0];
            const first = firstId ? await loadObject<Block>(WOS.makeORef("block", firstId)) : null;
            const pinned = !!(tab.meta as Record<string, unknown>)?.[ProjectTabMetaKey];
            const kind = t(pinned ? "topField.where.pinnedView" : "topField.where.openView");
            views.push({
                id: `view:${tabId}`,
                group: "view",
                label: tabDisplayName(tabShownName(tab), first?.meta as PanelMeta, home),
                where: here ? kind : `${wsName} · ${kind}`,
                icon: panelIcon(first?.meta as PanelMeta),
                here,
                current: here && tabId === ws.activetabid,
                run: { kind: "view", tabId, workspaceId: ws.oid },
            });
        }
    }
    return { views, workspaces };
}

function agentRows(
    states: Record<string, AgentStateInfo>,
    activeId: string,
    names: Map<string, string>,
    t: TFn
): FieldRow[] {
    return Object.values(states ?? {})
        .filter((s) => s?.blockid && (s.agent || s.agentname) && !s.cleared)
        .sort((a, b) => (a.workspaceid === activeId ? 0 : 1) - (b.workspaceid === activeId ? 0 : 1))
        .map((s) => {
            const other = s.workspaceid && s.workspaceid !== activeId ? names.get(s.workspaceid) : null;
            return {
                id: `agent:${s.blockid}`,
                group: "agent",
                label: agentLabel(s),
                note: agentStateLabel(s.state),
                where: other ? `${t("topField.where.agent")} · ${other}` : t("topField.where.agent"),
                icon: "robot",
                keywords: [s.firstname, s.agent, s.agentname].filter((k) => k),
                run: { kind: "agent", blockId: s.blockid },
            } as FieldRow;
        });
}

function extraRows(focus: FocusFactsValue, t: TFn): FieldRow[] {
    const rows: FieldRow[] = [
        {
            id: "action:togglesidebar",
            group: "action",
            label: t("topField.actions.toggleSidebar"),
            where: formatShortcutById("toggle-sidebar") || t("topField.where.action"),
            icon: "table-columns",
            keywords: ["sidebar", "hide", "show"],
            run: { kind: "togglesidebar" },
        },
    ];
    if (focus.isTerm && focus.blockId) {
        rows.push({
            id: "action:clearterm",
            group: "action",
            label: t("topField.actions.clearTerminal"),
            where: formatShortcutById("term-clear") || t("topField.where.action"),
            icon: "eraser",
            keywords: ["clear", "terminal", "scrollback", "cls"],
            run: { kind: "clearterm", blockId: focus.blockId },
        });
    }
    return rows;
}

// A new temporary view holding the page: the new tab's starting panel becomes the page before it is ever shown, so
// no shell starts for nothing.
async function openInNewView(url: string): Promise<void> {
    const ws = globalStore.get(atoms.workspace);
    if (ws?.oid == null) {
        return;
    }
    const tabId = await WorkspaceService.CreateTab(ws.oid, "", false);
    const tab = await WOS.reloadWaveObject<Tab>(WOS.makeORef("tab", tabId));
    const firstId = tab?.blockids?.[0];
    if (firstId) {
        await RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("block", firstId),
            meta: { ...browserBlockDef(url).meta, controller: null, "cmd:cwd": null } as MetaType,
        });
    } else {
        await RpcApi.CreateBlockCommand(TabRpcClient, { tabid: tabId, blockdef: browserBlockDef(url), focused: true });
    }
    getApi().setActiveTab(tabId);
}

type BrowserNavigable = { navigate?: (url: string) => void };

async function openAddress(url: string, mode: AddressMode, focus: FocusFactsValue): Promise<void> {
    if (mode === "here" && focus.isPage && focus.blockId) {
        const model = getBlockComponentModel(focus.blockId)?.viewModel as BrowserNavigable;
        if (typeof model?.navigate === "function") {
            model.navigate(url);
            refocusNode(focus.blockId);
            return;
        }
    }
    if (mode === "beside" && focus.blockId) {
        const oref = await RpcApi.CreateBlockCommand(TabRpcClient, {
            tabid: focus.tabId,
            blockdef: browserBlockDef(url),
            targetblockid: focus.blockId,
            targetaction: "splitright",
            focused: true,
        });
        focusWhenPlaced(blockIdOfORef(oref));
        return;
    }
    if (mode === "beside") {
        await createBlock(browserBlockDef(url));
        return;
    }
    await openInNewView(url);
}

type TermLike = { termRef?: { current?: { terminal?: { clear: () => void } } } };

async function runField(run: FieldRun, alt: boolean, focus: FocusFactsValue): Promise<void> {
    switch (run.kind) {
        case "address":
            await openAddress(run.url, run.mode, focus);
            return;
        case "view": {
            const active = globalStore.get(atoms.workspace)?.oid;
            if (run.workspaceId === active) {
                getApi().setActiveTab(run.tabId);
                return;
            }
            await WorkspaceService.SetActiveTab(run.workspaceId, run.tabId);
            getApi().switchWorkspace(run.workspaceId);
            return;
        }
        case "agent":
            await showPanel(run.blockId);
            return;
        case "workspace":
            getApi().switchWorkspace(run.workspaceId);
            return;
        case "pr":
            await ReviewsModel.getInstance().openReviews(run.dir, run.number);
            return;
        case "togglesidebar":
            SidebarModel.getInstance().toggleHidden();
            return;
        case "clearterm":
            (getBlockComponentModel(run.blockId)?.viewModel as TermLike)?.termRef?.current?.terminal?.clear();
            refocusNode(run.blockId);
            return;
        case "palette": {
            await runPaletteEntry(run.run, {
                placement: palettePlacement(run.run, alt, focus),
                blockId: focus.blockId,
            });
            return;
        }
    }
}

function RowLetter({ letter }: { letter: FieldRow["letter"] }) {
    return (
        <span
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-4 text-11 font-semibold"
            style={{ background: letter.paint, color: letter.ink }}
            aria-hidden
        >
            {letter.text}
        </span>
    );
}

function ResultRow({
    row,
    index,
    selected,
    onHover,
    onRun,
}: {
    row: FieldRow;
    index: number;
    selected: boolean;
    onHover: (i: number) => void;
    onRun: (row: FieldRow, e: React.MouseEvent) => void;
}) {
    return (
        <div
            role="option"
            aria-selected={selected}
            data-index={index}
            data-testid="top-field-row"
            data-row-id={row.id}
            onMouseMove={() => onHover(index)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => onRun(row, e)}
            className={cn(
                "flex min-h-[34px] w-full cursor-pointer items-center gap-[9px] rounded-4 px-[9px] py-1 text-left text-12 text-primary",
                selected && "bg-[color-mix(in_srgb,var(--mt-accent)_32%,transparent)]"
            )}
        >
            {row.letter ? (
                <RowLetter letter={row.letter} />
            ) : (
                <i
                    className={cn(
                        makeIconClass(row.icon, true, { defaultIcon: "circle" }),
                        "w-4 shrink-0 text-center text-secondary"
                    )}
                    style={row.color ? { color: row.color } : undefined}
                    aria-hidden
                />
            )}
            <span className="min-w-0 flex-1 truncate">
                {row.strong ? <b className="font-semibold">{row.strong} </b> : null}
                {row.group === "workspace" ? <b className="font-semibold">{row.label}</b> : row.label}
                {row.note ? <span className="text-muted"> {row.note}</span> : null}
            </span>
            {row.where ? <span className="shrink-0 text-11 whitespace-nowrap text-muted">{row.where}</span> : null}
            {row.key ? <kbd className="shrink-0 font-sans text-11 text-muted">{row.key}</kbd> : null}
        </div>
    );
}

function usePopoverPlace(anchorRef: React.RefObject<HTMLElement>, open: boolean): PopoverPlace {
    const [place, setPlace] = useState<PopoverPlace>(null);
    useLayoutEffect(() => {
        if (!open || anchorRef.current == null) {
            setPlace(null);
            return;
        }
        const measure = () => {
            const r = anchorRef.current?.getBoundingClientRect();
            if (r == null) {
                return;
            }
            setPlace(placePopover(r, window.innerWidth));
        };
        measure();
        // A hidden sidebar is still sliding in when ⌘L opens the field: place the popover again once it has arrived.
        window.addEventListener("resize", measure);
        window.addEventListener("transitionend", measure, true);
        return () => {
            window.removeEventListener("resize", measure);
            window.removeEventListener("transitionend", measure, true);
        };
    }, [open, anchorRef]);
    return place;
}

export function OpenField({
    focus,
    onClose,
    typed,
}: {
    focus: FocusFactsValue;
    onClose: () => void;
    typed?: TypedText;
}) {
    const t = useT();
    const ws = useAtomValue(atoms.workspace);
    const openCount = useAtomValue(TopFieldModel.getInstance().openCountAtom);
    const inputRef = useRef<HTMLInputElement>(null);
    const boxRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const [query, setQuery] = useState(typed?.value ?? (focus.isPage ? focus.url : ""));
    const typedRef = useRef(typed);
    const [selected, setSelected] = useState(0);
    const [loaded, setLoaded] = useState<LoadedSources>({ views: [], workspaces: [] });
    const agentData = useAtomValue(AgentStates.getInstance().dataAtom);
    const { entries } = usePaletteEntries(null);
    const dir = readWorkspaceProject(ws).dir;
    const reviews = useListedReviewsAnswer(dir);
    const place = usePopoverPlace(boxRef, true);
    const searching = query.trim() !== "";
    useEffect(() => {
        let live = true;
        fireAndForget(async () => {
            try {
                const next = await loadSources(t, ws?.oid);
                if (live) {
                    setLoaded(next);
                }
            } catch (e) {
                console.log("top field: sources", e);
            }
        });
        return () => {
            live = false;
        };
    }, [ws?.oid]);
    useEffect(() => {
        inputRef.current?.focus();
        // Typed into the stand-in field while this code loaded: keep the caret where it was.
        const first = typedRef.current;
        typedRef.current = null;
        if (first != null) {
            inputRef.current?.setSelectionRange(first.start, first.end);
            return;
        }
        inputRef.current?.select();
    }, [openCount]);
    const names = useMemo(() => {
        const m = new Map<string, string>();
        for (const row of loaded.workspaces) {
            if (row.run.kind === "workspace") {
                m.set(row.run.workspaceId, row.label);
            }
        }
        return m;
    }, [loaded]);
    const panelCommands = useMemo(
        () =>
            searching && focus.blockId ? panelPaletteEntries(focus.blockId, formatShortcutById("command-panel")) : [],
        [searching, focus.blockId]
    );
    const rows = useMemo(() => {
        const prs: FieldRow[] = [...(reviews?.ready ?? []), ...(reviews?.drafts ?? [])].map((pr) => ({
            id: `pr:${pr.number}`,
            group: "pr",
            label: `#${pr.number} ${pr.title}`,
            where: t(pr.draft ? "topField.where.draftPr" : "topField.where.pr"),
            icon: "code-pull-request",
            keywords: [pr.branch, "pr", "pull request"].filter((k) => k),
            run: { kind: "pr", dir, number: pr.number },
        }));
        return [
            ...loaded.views,
            ...agentRows(agentData?.states, ws?.oid, names, t),
            ...loaded.workspaces,
            ...prs,
            ...paletteFieldRows([...entries, ...panelCommands]),
            ...extraRows(focus, t),
        ];
    }, [loaded, agentData, ws?.oid, names, reviews, dir, entries, panelCommands, focus, t]);
    const wsName = workspaceShownName(ws?.name, t) || t("rail.unsavedWorkspace");
    const fieldFocus = {
        onPage: focus.isPage,
        pageHost: focus.url ? hostOfUrl(focus.url) : "",
        viewName: focus.viewName,
    };
    const res = useMemo(
        () => fieldResults(query, rows, fieldFocus, wsName),
        [query, rows, focus.isPage, focus.url, focus.viewName, wsName]
    );
    useEffect(() => {
        setSelected((s) => Math.min(s, Math.max(0, res.flat.length - 1)));
    }, [res.flat.length]);
    useEffect(() => {
        listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
    }, [selected]);
    const run = (row: FieldRow, keys: { alt?: boolean; meta?: boolean }) => {
        const next = enterRun(row, keys);
        if (next == null) {
            return;
        }
        onClose();
        fireAndForget(async () => {
            try {
                await runField(next, !!keys.alt, focus);
            } catch (e) {
                console.log("top field: run", e);
            }
        });
    };
    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.nativeEvent.isComposing) {
            return;
        }
        if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
            e.preventDefault();
            setSelected((s) => Math.min(res.flat.length - 1, s + 1));
            return;
        }
        if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
            e.preventDefault();
            setSelected((s) => Math.max(0, s - 1));
            return;
        }
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
            if (focus.blockId) {
                refocusNode(focus.blockId);
            }
            return;
        }
        if (e.key !== "Enter") {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        run(res.flat[selected], { alt: e.altKey, meta: e.metaKey || e.ctrlKey });
    };
    let index = 0;
    const popover =
        place == null
            ? null
            : createPortal(
                  <div
                      role="listbox"
                      id="molten-top-field-list"
                      aria-label={t("topField.resultsLabel")}
                      data-testid="top-field-results"
                      className="mt-sb-omni-pop fixed z-[650] flex max-h-[70vh] flex-col rounded-4 p-[5px]"
                      style={{ left: place.left, top: place.top, width: place.width }}
                      onMouseDown={(e) => e.preventDefault()}
                  >
                      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
                          {res.sections.map((section, si) => (
                              <div key={si}>
                                  {section.title ? (
                                      <div className="px-[9px] pt-1.5 pb-[3px] text-11 tracking-[0.07em] text-muted uppercase">
                                          {section.title}
                                      </div>
                                  ) : null}
                                  {section.rows.map((row) => {
                                      const i = index++;
                                      return (
                                          <ResultRow
                                              key={row.id}
                                              row={row}
                                              index={i}
                                              selected={i === selected}
                                              onHover={setSelected}
                                              onRun={(r, ev) =>
                                                  run(r, { alt: ev.altKey, meta: ev.metaKey || ev.ctrlKey })
                                              }
                                          />
                                      );
                                  })}
                              </div>
                          ))}
                          {res.flat.length === 0 ? (
                              <div className="p-3 text-12 text-muted">{t("topField.noMatch")}</div>
                          ) : null}
                      </div>
                      <div
                          className="mt-1 flex flex-wrap gap-x-2.5 gap-y-1 border-t border-white/10 px-[9px] pt-[7px] pb-[3px] text-11 text-muted"
                          data-testid="top-field-hint"
                      >
                          <span>{t("topField.hint.anAddress")}</span>
                          {fieldHint(focus.isPage).map((h) => (
                              <span key={h.keys}>
                                  <kbd className="font-sans">{h.keys}</kbd> {h.text}
                              </span>
                          ))}
                      </div>
                  </div>,
                  document.body
              );
    return (
        <div ref={boxRef} className="relative" data-testid="top-field-open">
            <span className="pointer-events-none absolute top-[10px] left-2.5 flex text-muted">
                <SidebarGlyph name={focus.isPage ? "globe" : "search"} size={14} />
            </span>
            <input
                ref={inputRef}
                value={query}
                autoComplete="off"
                spellCheck={false}
                aria-label={t("topField.inputLabel")}
                aria-controls="molten-top-field-list"
                placeholder={t("topField.placeholder")}
                data-testid="top-field-input"
                onChange={(e) => {
                    setQuery(e.target.value);
                    setSelected(0);
                }}
                onKeyDown={onKeyDown}
                onBlur={() =>
                    setTimeout(() => {
                        if (document.activeElement !== inputRef.current) {
                            onClose();
                        }
                    }, BlurCloseMs)
                }
                className="h-[34px] w-full rounded-6 border border-[var(--mt-accent)] bg-black/35 pr-2.5 pl-8 text-12 text-primary outline-none"
            />
            {popover}
        </div>
    );
}
