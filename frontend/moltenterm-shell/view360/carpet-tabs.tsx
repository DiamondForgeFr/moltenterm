// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The tabs of the carpet's tab strip (FR-SHELL-125, DS-SHELL-135), drawn from the strip's rules (carpet-tabs-model.ts)
// and wired by view360-radar.tsx: one tab per carpet panel with its icon or favicon, its title, its kind's margin, its
// close cross, its attention mark and its agent's initial; the visible area framing the tabs on screen; the "+" at
// the end. When even the icons no longer fit, the radar's ticks come back. Nothing here runs per scroll frame.

import { cn } from "@/util/util";
import { CSSProperties, KeyboardEvent, memo, MouseEvent, PointerEvent, ReactNode, useState } from "react";
import { suiteIcon } from "../suite/suite-icons";
import type { CarpetPageFacts } from "./carpet-page-store";
import { agentInitial, carpetTabName, StripLayout, StripText } from "./carpet-tabs-model";
import { radarHint, RadarText, RadarTick } from "./radar-model";

const EyeIcon = suiteIcon("visibleArea");

export type StripHandlers = {
    go: (tick: RadarTick) => void;
    close: (tick: RadarTick) => void;
    menu: (tick: RadarTick, e: MouseEvent) => void;
    add: () => void;
    hover: (tick: RadarTick, el: HTMLElement) => void;
    tabPointerDown: (tick: RadarTick, e: PointerEvent<HTMLElement>) => void;
    tabPointerMove: (e: PointerEvent<HTMLElement>) => void;
    tabPointerUp: (e: PointerEvent<HTMLElement>) => void;
    windowEnter: (e: PointerEvent<HTMLDivElement>) => void;
    windowLeave: () => void;
    windowPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
    windowPointerMove: (e: PointerEvent<HTMLDivElement>) => void;
    windowPointerUp: () => void;
};

// A tab being dragged (AC5): how far it moved, where it would drop, and whether that is inside the visible area.
export type StripDrag = { columnId: string; dx: number; markX: number; inFrame: boolean };

export type CarpetStripProps = {
    ticks: RadarTick[];
    layout: StripLayout;
    // The ticks' pitch, used only when the strip falls back to them.
    pitch: number;
    focusedColumnId: string;
    rovingColumnId: string;
    pages: Record<string, CarpetPageFacts>;
    // The Ctrl+Shift numbers by column, empty unless both keys are held (FR-SHELL-126-AC2).
    numbers?: Record<string, number>;
    drag: StripDrag;
    scrubbing: boolean;
    handlers: StripHandlers;
    // The automatic-360 mark, drawn before the tabs.
    lead?: ReactNode;
};

// The tab's glyph: a page's favicon once loaded (FR-SHELL-125-AC1), otherwise the panel's icon.
function TabGlyph({ tick, favicon }: { tick: RadarTick; favicon: string }) {
    const [broken, setBroken] = useState<string>(null);
    if (favicon && broken !== favicon) {
        return (
            <img className="mt-strip-glyph" src={favicon} alt="" draggable={false} onError={() => setBroken(favicon)} />
        );
    }
    return <i className={cn("mt-strip-glyph fa fa-solid", `fa-${tick.icon}`)} aria-hidden="true" />;
}

// Arrow keys move between the tabs, Home and End go to the ends (AC10: one tab in the tab order).
function moveTabFocus(e: KeyboardEvent<HTMLElement>): boolean {
    const row = e.currentTarget.closest("[role=tablist]");
    if (row == null) {
        return false;
    }
    const tabs = Array.from(row.querySelectorAll<HTMLElement>("[role=tab]"));
    const at = tabs.indexOf(e.currentTarget);
    let next = -1;
    if (e.key === "ArrowLeft") next = Math.max(0, at - 1);
    else if (e.key === "ArrowRight") next = Math.min(tabs.length - 1, at + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next === -1) {
        return false;
    }
    tabs[next]?.focus();
    return true;
}

type TabProps = {
    tick: RadarTick;
    layout: StripLayout;
    focused: boolean;
    roving: boolean;
    page: CarpetPageFacts;
    num?: number;
    drag: StripDrag;
    handlers: StripHandlers;
};

const CarpetTab = memo(({ tick, layout, focused, roving, page, num, drag, handlers }: TabProps) => {
    const agentName = page?.agentName ?? "";
    const initial = agentInitial(agentName);
    const dragged = drag?.columnId === tick.columnId;
    const style = {
        width: layout.tabPx,
        "--mt-radar-color": tick.color,
        transform: dragged ? `translateX(${drag.dx}px)` : undefined,
    } as CSSProperties;
    return (
        <div
            role="tab"
            tabIndex={roving ? 0 : -1}
            aria-selected={focused}
            aria-label={carpetTabName(tick, agentName)}
            className={cn("mt-strip-tab cursor-pointer", dragged && "dragging")}
            style={style}
            data-column={tick.columnId}
            data-kind={tick.kind}
            data-mode={layout.mode}
            data-visible={tick.visible ? "" : undefined}
            data-focus={focused ? "" : undefined}
            data-attention={tick.attention ?? undefined}
            data-testid="mt-carpet-tab"
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => handlers.tabPointerDown(tick, e)}
            onPointerMove={handlers.tabPointerMove}
            onPointerUp={handlers.tabPointerUp}
            onLostPointerCapture={handlers.tabPointerUp}
            onClick={() => handlers.go(tick)}
            onAuxClick={(e) => {
                if (e.button === 1) {
                    e.preventDefault();
                    handlers.close(tick);
                }
            }}
            onContextMenu={(e) => handlers.menu(tick, e)}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handlers.go(tick);
                    return;
                }
                if (moveTabFocus(e)) {
                    e.preventDefault();
                }
            }}
            onPointerEnter={(e) => handlers.hover(tick, e.currentTarget)}
            onFocus={(e) => handlers.hover(tick, e.currentTarget)}
        >
            {num != null ? (
                <span className="mt-strip-num" aria-hidden="true" data-testid="mt-carpet-tab-num">
                    {num}
                </span>
            ) : (
                <TabGlyph tick={tick} favicon={page?.favicon} />
            )}
            {layout.mode === "titles" && <span className="mt-strip-title">{tick.title}</span>}
            {(tick.attention != null || initial) && (
                <span className="mt-strip-marks" aria-hidden="true">
                    {tick.attention != null && <span className="mt-strip-attention" />}
                    {initial && <span className="mt-strip-agent">{initial}</span>}
                </span>
            )}
            {layout.mode === "titles" && (
                <span
                    role="button"
                    tabIndex={-1}
                    aria-label={StripText.close}
                    className="mt-strip-close cursor-pointer"
                    data-testid="mt-carpet-tab-close"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                        e.stopPropagation();
                        handlers.close(tick);
                    }}
                >
                    <i className="fa fa-solid fa-xmark" aria-hidden="true" />
                </span>
            )}
            <span className="mt-strip-kind" aria-hidden="true" />
        </div>
    );
});
CarpetTab.displayName = "CarpetTab";

function TickButton({ tick, pitch, handlers }: { tick: RadarTick; pitch: number; handlers: StripHandlers }) {
    const style = { width: pitch, "--mt-radar-color": tick.color } as CSSProperties;
    return (
        <button
            type="button"
            className="mt-radar-hit cursor-pointer"
            style={style}
            data-column={tick.columnId}
            data-kind={tick.kind}
            data-visible={tick.visible ? "" : undefined}
            data-attention={tick.attention ?? undefined}
            aria-label={`${tick.title}, ${radarHint(tick)}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => handlers.go(tick)}
            onAuxClick={(e) => {
                if (e.button === 1) {
                    e.preventDefault();
                    handlers.close(tick);
                }
            }}
            onContextMenu={(e) => handlers.menu(tick, e)}
            onPointerEnter={(e) => handlers.hover(tick, e.currentTarget)}
            onFocus={(e) => handlers.hover(tick, e.currentTarget)}
        >
            <span className="mt-radar-tick" />
        </button>
    );
}

// The "+" (AC7): always at the end of the strip, it opens the panel picker at the end of the carpet.
function StripPlus({ onAdd }: { onAdd: () => void }) {
    return (
        <button
            type="button"
            className="mt-strip-plus cursor-pointer"
            aria-label={StripText.add}
            title={StripText.add}
            data-testid="mt-carpet-add"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onAdd}
        >
            <i className="fa fa-solid fa-plus" aria-hidden="true" />
        </button>
    );
}

export function CarpetStrip(props: CarpetStripProps) {
    const { ticks, layout, pitch, focusedColumnId, rovingColumnId, pages, numbers, drag, scrubbing, handlers, lead } =
        props;
    const tabsMode = layout.mode !== "ticks";
    const first = ticks.findIndex((t) => t.visible);
    const last = first === -1 ? -1 : ticks.length - 1 - [...ticks].reverse().findIndex((t) => t.visible);
    const render = (tick: RadarTick) =>
        tabsMode ? (
            <CarpetTab
                key={tick.columnId}
                tick={tick}
                layout={layout}
                focused={tick.columnId === focusedColumnId}
                roving={tick.columnId === rovingColumnId}
                page={pages?.[tick.focusBlockId]}
                num={numbers?.[tick.columnId]}
                drag={drag?.columnId === tick.columnId ? drag : null}
                handlers={handlers}
            />
        ) : (
            <TickButton key={tick.columnId} tick={tick} pitch={pitch} handlers={handlers} />
        );
    return (
        <>
            {lead}
            {ticks.length > 0 && (
                <div
                    className={cn(tabsMode ? "mt-strip-tabs" : "mt-radar-ticks", drag != null && "dragging")}
                    role={tabsMode ? "tablist" : "group"}
                    aria-label={RadarText.label}
                    data-mode={layout.mode}
                    data-testid="mt-carpet-tabs"
                >
                    {first === -1 ? (
                        ticks.map(render)
                    ) : (
                        <>
                            {ticks.slice(0, first).map(render)}
                            <div
                                className={cn("mt-radar-window", scrubbing && "dragging", drag?.inFrame && "drop")}
                                role="none"
                                data-testid="mt-carpet-radar-window"
                                onPointerEnter={handlers.windowEnter}
                                onPointerLeave={handlers.windowLeave}
                                onPointerDown={handlers.windowPointerDown}
                                onPointerMove={handlers.windowPointerMove}
                                onPointerUp={handlers.windowPointerUp}
                                onLostPointerCapture={handlers.windowPointerUp}
                            >
                                {ticks.slice(first, last + 1).map(render)}
                                <span className="mt-radar-eye" aria-hidden>
                                    <EyeIcon strokeWidth={2} aria-hidden />
                                </span>
                            </div>
                            {ticks.slice(last + 1).map(render)}
                        </>
                    )}
                    {drag != null && <span className="mt-strip-drop" style={{ left: drag.markX }} aria-hidden />}
                </div>
            )}
            <StripPlus onAdd={handlers.add} />
        </>
    );
}
