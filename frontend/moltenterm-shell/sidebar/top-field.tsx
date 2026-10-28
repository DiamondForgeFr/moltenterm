// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The field at the top of the sidebar (FR-SHELL-083, #1187). Closed, it shows the focused panel: a page's address, or
// "<panel> · <view>". ⌘L or a click opens it: it searches views, agents, workspaces, pull requests, panels and
// actions (every command of the palette), and opens an address with Enter, ⌥Enter or ⌘Enter as its hint line says.
//
// This module is the resting field only; the open field loads once the sidebar is on screen (top-field-open.tsx), out
// of the JS every tab view loads up front (NFR-PERF-003, bundle.initialJsMB). Opened before it arrives, the field
// shows a stand-in input that keeps what is typed and hands it over.

import { atoms, getApi, refocusNode, WOS } from "@/app/store/global";
import { getLayoutModelForStaticTab, LayoutNode } from "@/layout/index";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { atom, Atom, useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { agentLabel } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { MoltentermBrowserView, readBrowserState } from "../browser/browser-model";
import { useLocale, useT } from "../i18n/i18n";
import { formatShortcutById } from "../shortcuts/format";
import { panelIcon, PanelMeta, panelTitle, tabDisplayName } from "../tab-identity";
import { SidebarGlyph } from "./sidebar-icons";
import { SidebarModel } from "./sidebar-store";
import { fieldContext } from "./top-field-context";
import type * as TopFieldOpen from "./top-field-open";
import { TopFieldModel } from "./top-field-store";

const NullNodeAtom = atom(null) as Atom<LayoutNode>;
// After the first paint, so the open field's code never competes with start-up.
const PreloadDelayMs = 1500;
const StandInBlurMs = 120;

// What was typed into the stand-in field, and where the caret was.
export type TypedText = { value: string; start: number; end: number };

let openFieldModule: typeof TopFieldOpen = null;
let openFieldLoading: Promise<void> = null;

function loadOpenField(): Promise<void> {
    openFieldLoading ??= import("./top-field-open").then(
        (m) => {
            openFieldModule = m;
        },
        (e) => {
            openFieldLoading = null;
            throw e;
        }
    );
    return openFieldLoading;
}

export function homeDir(): string {
    try {
        return getApi()?.getHomeDir?.() ?? "";
    } catch {
        return "";
    }
}

// The focused panel and its view, as the closed field shows them.
function useFocusFacts() {
    const layoutModel = getLayoutModelForStaticTab();
    const node = useAtomValue(layoutModel?.focusedNode ?? NullNodeAtom);
    const blockId = node?.data?.blockId ?? null;
    const block = useAtomValue(
        useMemo(
            () =>
                blockId ? WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)) : (atom(null) as Atom<Block>),
            [blockId]
        )
    );
    const tabId = useAtomValue(atoms.staticTabId);
    const tab = useAtomValue(useMemo(() => WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)), [tabId]));
    const firstId = tab?.blockids?.[0];
    const first = useAtomValue(
        useMemo(
            () =>
                firstId ? WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", firstId)) : (atom(null) as Atom<Block>),
            [firstId]
        )
    );
    const agentData = useAtomValue(AgentStates.getInstance().dataAtom);
    useLocale();
    const meta = block?.meta as PanelMeta;
    const isPage = meta?.view === MoltentermBrowserView;
    const pageState = isPage ? readBrowserState(block.meta, "") : null;
    const url = pageState?.tabs.find((tab) => tab.id === pageState.activeId)?.url;
    const agent = blockId ? agentData?.states?.[blockId] : null;
    const panelLabel =
        agent?.agent || agent?.agentname ? agent.firstname || agentLabel(agent) : panelTitle(meta, homeDir());
    const viewName = tab ? tabDisplayName(tab.name, first?.meta as PanelMeta, homeDir()) : "";
    return {
        blockId,
        tabId,
        isPage,
        url: url ?? "",
        panelLabel,
        panelIcon: meta ? panelIcon(meta) : null,
        viewName,
        panelCount: tab?.blockids?.length ?? 0,
        isTerm: meta?.view === "term",
    };
}

export type FocusFactsValue = ReturnType<typeof useFocusFacts>;

// The open field's look before its code arrives: it takes the keys typed right after ⌘L and hands them over.
function StandInField({
    focus,
    onClose,
    typedRef,
}: {
    focus: FocusFactsValue;
    onClose: () => void;
    typedRef: React.RefObject<TypedText>;
}) {
    const t = useT();
    const inputRef = useRef<HTMLInputElement>(null);
    const [value, setValue] = useState(focus.isPage ? focus.url : "");
    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, []);
    const keep = (input: HTMLInputElement) => {
        typedRef.current = { value: input.value, start: input.selectionStart ?? 0, end: input.selectionEnd ?? 0 };
    };
    return (
        <div className="relative" data-testid="top-field-loading">
            <span className="pointer-events-none absolute top-[10px] left-2.5 flex text-muted">
                <SidebarGlyph name={focus.isPage ? "globe" : "search"} size={14} />
            </span>
            <input
                ref={inputRef}
                value={value}
                autoComplete="off"
                spellCheck={false}
                aria-label={t("topField.inputLabel")}
                placeholder={t("topField.placeholder")}
                data-testid="top-field-input"
                onChange={(e) => {
                    setValue(e.target.value);
                    keep(e.target);
                }}
                onSelect={(e) => keep(e.currentTarget)}
                onKeyDown={(e) => {
                    if (e.key !== "Escape") {
                        return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    onClose();
                    if (focus.blockId) {
                        refocusNode(focus.blockId);
                    }
                }}
                onBlur={() =>
                    setTimeout(() => {
                        // Replaced by the open field: that one has the focus now.
                        if (inputRef.current?.isConnected && document.activeElement !== inputRef.current) {
                            onClose();
                        }
                    }, StandInBlurMs)
                }
                className="h-[34px] w-full rounded-6 border border-[var(--mt-accent)] bg-black/35 pr-2.5 pl-8 text-12 text-primary outline-none"
            />
        </div>
    );
}

export function TopField() {
    const t = useT();
    const model = TopFieldModel.getInstance();
    const open = useAtomValue(model.openAtom);
    const focus = useFocusFacts();
    const [, setLoaded] = useState(openFieldModule != null);
    const typedRef = useRef<TypedText>(null);
    const ctx = fieldContext(focus);
    const keys = formatShortcutById("top-field");
    useEffect(() => {
        const timer = setTimeout(() => fireAndForget(loadOpenField), PreloadDelayMs);
        return () => clearTimeout(timer);
    }, []);
    useEffect(() => {
        if (!open) {
            typedRef.current = null;
            return;
        }
        if (openFieldModule != null) {
            return;
        }
        let live = true;
        fireAndForget(async () => {
            await loadOpenField();
            if (live) {
                setLoaded(true);
            }
        });
        return () => {
            live = false;
        };
    }, [open]);
    const close = () => {
        model.close();
        const sidebar = SidebarModel.getInstance();
        if (sidebar.isHidden()) {
            sidebar.setPeek(false);
        }
    };
    if (open) {
        const OpenField = openFieldModule?.OpenField;
        if (OpenField == null) {
            return <StandInField focus={focus} onClose={close} typedRef={typedRef} />;
        }
        return <OpenField focus={focus} onClose={close} typed={typedRef.current ?? undefined} />;
    }
    return (
        <button
            type="button"
            className="mt-sb-cmd flex h-[34px] w-full shrink-0 cursor-text items-center gap-2 rounded-6 bg-white/[0.08] px-2.5 text-left text-12 text-secondary transition-colors duration-120 ease-mt hover:bg-white/[0.12]"
            aria-label={t("topField.buttonLabel", { keys })}
            title={ctx.url ? ctx.text : undefined}
            data-testid="top-field"
            onClick={() => model.open()}
        >
            <span className="flex shrink-0">
                {ctx.url ? (
                    <SidebarGlyph name="globe" size={14} />
                ) : ctx.icon && ctx.icon !== "magnifying-glass" ? (
                    <i className={cn(makeIconClass(ctx.icon, true), "w-[14px] text-center text-icon-14")} aria-hidden />
                ) : (
                    <SidebarGlyph name="search" size={14} />
                )}
            </span>
            <span
                className={cn(
                    "min-w-0 flex-1 truncate",
                    ctx.url && "font-mono text-11 text-primary",
                    !ctx.text && "text-muted"
                )}
                data-testid="top-field-context"
            >
                {ctx.text || t("topField.placeholder")}
            </span>
            {keys ? (
                <kbd className="shrink-0 rounded-4 bg-black/25 px-1 font-sans text-11 text-muted">{keys}</kbd>
            ) : null}
        </button>
    );
}
