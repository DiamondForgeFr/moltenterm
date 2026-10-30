// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The carpet's tab strip (FR-SHELL-125, DS-SHELL-135), formerly the radar scrubber (FR-SHELL-068, DS-SHELL-119): one
// tab per carpet panel at the bottom of the carpet, the tabs on screen framed by the visible area, which still scrubs
// the carpet when dragged (#678). A click brings a panel into view, a middle click or the cross closes it, a drag
// reorders the carpet (or shows the panel, dropped inside the visible area), a right click opens the tab menu, and the
// "+" adds a panel at the end. When the tabs no longer fit they keep only their icon, then fall back to the radar's
// ticks. It renders when the columns, the set in view, the focus or a panel's facts change, never per scroll frame.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { uxCloseBlock } from "@/app/store/keymodel";
import type { LayoutModel } from "@/layout/lib/layoutModel";
import { fireAndForget } from "@/util/util";
import { atom, useAtomValue } from "jotai";
import { CSSProperties, memo, useEffect, useMemo, useRef, useState } from "react";
import { browserTabMenu } from "../browser/browser-tab-menu";
import { useLocale } from "../i18n/i18n";
import { SidebarModel } from "../sidebar/sidebar-store";
import { suiteIcon } from "../suite/suite-icons";
import { addCarpetPanel } from "./carpet-add";
import { CarpetLayout, CarpetScrubberPx } from "./carpet-model";
import { activePageTab, CarpetPageFacts, carpetPageModel, makeCarpetPagesAtom } from "./carpet-page-store";
import { CarpetStrip, StripDrag, StripHandlers } from "./carpet-tabs";
import {
    carpetMoveAction,
    carpetTabMenu,
    dropIndex,
    rovingColumnId,
    stepIndex,
    stripLayout,
    StripPlusPx,
    StripText,
    TabGapPx,
    tabNumbers,
} from "./carpet-tabs-model";
import {
    buildRadarTicks,
    radarHint,
    radarPitchPx,
    RadarText,
    RadarTick,
    radarToContentX,
    radarWindowLine,
} from "./radar-model";
import { makeRadarFactsAtom, radarColumns } from "./radar-store";
import "./radar.css";
import type { View360Model } from "./view360-model";
import { pinMenuItems } from "./view360-pin";
import { View360Text } from "./view360-text";

const DragThresholdPx = 3;
const EdgePadPx = 8;
const AutoMarkPx = 20;
const CardWidthPx = 220;
const EyeIcon = suiteIcon("visibleArea");
const NoPages = atom({} as Record<string, CarpetPageFacts>);

type Scrub = {
    pointerId: number;
    startX: number;
    startScroll: number;
    tickCenters: number[];
    columnCenters: number[];
    slope: number;
    moved: boolean;
};

type TabDrag = {
    pointerId: number;
    columnId: string;
    startX: number;
    rowLeft: number;
    rects: DOMRect[];
    frame: DOMRect;
    moved: boolean;
};

type Hover = { columnId: string; x: number };

// The automatic-360 "A" beside the strip while the automatic decision holds the view (#1183): under the workspace
// sidebar no tab bar toggle carries it.
function RadarAutoMark({ view360 }: { view360: View360Model }) {
    const sidebarOn = useAtomValue(SidebarModel.getInstance().enabledAtom);
    const decision = useAtomValue(view360.decisionAtom);
    if (!sidebarOn || !decision.active || decision.source !== "auto") {
        return null;
    }
    return (
        <span className="mt-radar-auto" title={View360Text.heldAuto} data-testid="mt-carpet-radar-auto">
            {View360Text.toggleAutoMark}
        </span>
    );
}

function useAutoMarkShown(view360: View360Model): boolean {
    const sidebarOn = useAtomValue(SidebarModel.getInstance().enabledAtom);
    const decision = useAtomValue(view360.decisionAtom);
    return sidebarOn && decision.active && decision.source === "auto";
}

function centerOf(r: DOMRect): number {
    return r.left + r.width / 2;
}

export const View360Radar = memo(({ layoutModel, layout }: { layoutModel: LayoutModel; layout: CarpetLayout }) => {
    const view360 = layoutModel.moltenView360;
    const locale = useLocale();
    const visibleIds = useAtomValue(view360.visibleColumnIdsAtom);
    const focusedNode = useAtomValue(layoutModel.focusedNode);
    const autoShown = useAutoMarkShown(view360);
    const rootNode = layoutModel.treeState?.rootNode;
    const columns = useMemo(() => radarColumns(rootNode, layout), [rootNode, layout]);
    const blockKey = columns.flatMap((c) => c.leaves.map((l) => l.blockId)).join(",");
    const factsAtom = useMemo(() => makeRadarFactsAtom(blockKey ? blockKey.split(",") : []), [blockKey]);
    const facts = useAtomValue(factsAtom);
    // The locale is a dependency: tick titles carry translated text ("Panel", "+2 panels").
    const ticks = useMemo(() => buildRadarTicks(columns, facts, visibleIds), [columns, facts, visibleIds, locale]);
    // A page's view model registers while its block renders, which may come after this strip: one more pass once
    // the blocks are drawn picks up the pages added with them.
    const [pagesEpoch, setPagesEpoch] = useState(0);
    useEffect(() => {
        const frame = requestAnimationFrame(() => setPagesEpoch((n) => n + 1));
        return () => cancelAnimationFrame(frame);
    }, [blockKey]);
    const pageKey = ticks
        .filter((t) => t.page)
        .map((t) => t.focusBlockId)
        .join(",");
    const pagesAtom = useMemo(
        () => (pageKey ? makeCarpetPagesAtom(pageKey.split(",")) : NoPages),
        [pageKey, pagesEpoch]
    );
    const pages = useAtomValue(pagesAtom);
    // Wave's Ctrl+Shift hold (main process: both keys down, none else, reset when either goes up or the window loses
    // focus), the one that numbers the panels.
    const ctrlShiftHeld = useAtomValue(atoms.controlShiftDelayAtom);
    const leafOrder = useAtomValue(layoutModel.leafOrder);
    const numbers = useMemo(
        () =>
            tabNumbers(
                ticks,
                leafOrder.map((leaf) => leaf.nodeid),
                ctrlShiftHeld
            ),
        [ticks, leafOrder, ctrlShiftHeld]
    );
    const [hover, setHover] = useState<Hover>(null);
    const [scrubbing, setScrubbing] = useState(false);
    const [drag, setDrag] = useState<StripDrag>(null);
    // The window's centre in the row while the pointer is over it, null otherwise.
    const [windowX, setWindowX] = useState<number>(null);
    const rowRef = useRef<HTMLDivElement>(null);
    const scrubRef = useRef<Scrub>(null);
    const tabDragRef = useRef<TabDrag>(null);
    const suppressClickRef = useRef(false);

    const focusedColumnId = useMemo(
        () => (focusedNode == null ? null : view360.carpetColumnOf(focusedNode.id)),
        [focusedNode, layout, view360]
    );

    const surface = layout.surface;
    const availPx = surface.width - 2 * EdgePadPx - (autoShown ? AutoMarkPx : 0);
    const strip = stripLayout(ticks.length, availPx);
    const pitch = radarPitchPx(ticks.length, availPx - StripPlusPx - 4 * EdgePadPx);
    const rowStyle: CSSProperties = {
        transform: `translate3d(${surface.left}px, ${surface.top + surface.height - CarpetScrubberPx}px, 0)`,
        width: surface.width,
        height: CarpetScrubberPx,
    };
    const columnIds = ticks.map((t) => t.columnId);

    const suppressNextClick = () => {
        suppressClickRef.current = true;
        setTimeout(() => (suppressClickRef.current = false), 0);
    };
    const goTo = (tick: RadarTick) => {
        if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
        }
        view360.scrollToColumn(tick.columnId);
        layoutModel.focusNode(tick.focusNodeId);
    };
    const reveal = (tick: RadarTick) => {
        requestAnimationFrame(() => {
            view360.scrollToColumn(tick.columnId);
            layoutModel.focusNode(tick.focusNodeId);
        });
    };
    // Reordering moves a top-level column of the tree (AC5): the normal layout follows the same order.
    const moveTo = (tick: RadarTick, toIndex: number, show: boolean) => {
        const action = carpetMoveAction(layoutModel.treeState?.rootNode, columnIds, tick.columnId, toIndex);
        if (action != null) {
            layoutModel.treeReducer(action);
        }
        if (show) {
            reveal(tick);
        }
    };
    // The same path as Cmd+W (AC4): a terminal running a program asks first (FR-SHELL-061).
    const close = (tick: RadarTick) => {
        if (tick.focusBlockId) {
            uxCloseBlock(tick.focusBlockId);
        }
    };
    const closeOthers = (tick: RadarTick) => {
        for (const column of columns) {
            if (column.columnId === tick.columnId) {
                continue;
            }
            for (const leaf of column.leaves) {
                uxCloseBlock(leaf.blockId);
            }
        }
    };
    const showMenu = (tick: RadarTick, e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setHover(null);
        const at = columnIds.indexOf(tick.columnId);
        const left = stepIndex(columnIds, tick.columnId, -1);
        const right = stepIndex(columnIds, tick.columnId, 1);
        const page = tick.page ? carpetPageModel(tick.focusBlockId) : null;
        fireAndForget(async () => {
            let pageItems: ContextMenuItem[] = [];
            if (page != null) {
                const tab = activePageTab(globalStore.get(page.stateAtom));
                const share = tab != null && page.shareItems != null ? await page.shareItems(tab) : [];
                // A state of this tab alone: the page's own Close / Close others closed browser tabs inside one
                // panel, the tab's Close and Close others below act on the panels.
                pageItems = browserTabMenu({ tabs: tab == null ? [] : [tab], activeId: tab?.id }, tab, page, share);
            }
            const menu = carpetTabMenu({
                pageItems,
                pinItems: pinMenuItems(tick.focusBlockId, undefined),
                canMoveLeft: left != null,
                canMoveRight: right != null,
                hasOthers: at !== -1 && columnIds.length > 1,
                close: () => close(tick),
                closeOthers: () => closeOthers(tick),
                moveLeft: () => moveTo(tick, left, false),
                moveRight: () => moveTo(tick, right, false),
            });
            ContextMenuModel.getInstance().showContextMenu(menu, e);
        });
    };
    const onHover = (tick: RadarTick, el: HTMLElement) => {
        if (tabDragRef.current?.moved) {
            return;
        }
        const row = rowRef.current?.getBoundingClientRect();
        const rect = el.getBoundingClientRect();
        if (row == null) {
            return;
        }
        setHover({ columnId: tick.columnId, x: rect.left + rect.width / 2 - row.left });
    };

    // ---- dragging the visible area scrubs the carpet (FR-SHELL-068 AC1) ----
    const onWindowPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) {
            return;
        }
        const row = rowRef.current;
        if (row == null) {
            return;
        }
        const tickCenters = Array.from(row.querySelectorAll<HTMLElement>(".mt-radar-hit, .mt-strip-tab")).map((el) =>
            centerOf(el.getBoundingClientRect())
        );
        const columnCenters = layout.columns.map((c) => c.x + c.width / 2);
        const avgWidth = layout.contentWidth / Math.max(1, layout.columns.length);
        const step = strip.mode === "ticks" ? pitch : strip.tabPx + TabGapPx;
        scrubRef.current = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startScroll: view360.scrollLeft,
            tickCenters,
            columnCenters,
            slope: avgWidth / Math.max(1, step),
            moved: false,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
    };
    const onWindowPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const scrub = scrubRef.current;
        if (scrub == null || scrub.pointerId !== e.pointerId) {
            return;
        }
        if (!scrub.moved && Math.abs(e.clientX - scrub.startX) < DragThresholdPx) {
            return;
        }
        if (!scrub.moved) {
            scrub.moved = true;
            setScrubbing(true);
            setHover(null);
        }
        const from = radarToContentX(scrub.startX, scrub.tickCenters, scrub.columnCenters, scrub.slope);
        const to = radarToContentX(e.clientX, scrub.tickCenters, scrub.columnCenters, scrub.slope);
        view360.scrollTo(scrub.startScroll + to - from);
    };
    const onWindowPointerUp = () => {
        const scrub = scrubRef.current;
        scrubRef.current = null;
        if (scrub?.moved) {
            // The release over a tick would also click it.
            suppressNextClick();
            setScrubbing(false);
        }
    };
    const onWindowEnter = (e: React.PointerEvent<HTMLDivElement>) => {
        const row = rowRef.current?.getBoundingClientRect();
        const rect = e.currentTarget.getBoundingClientRect();
        if (row == null) {
            return;
        }
        setWindowX(rect.left + rect.width / 2 - row.left);
    };

    // ---- dragging a tab reorders the carpet, or shows the panel dropped in the visible area (AC5) ----
    const dropAt = (d: TabDrag, x: number) => {
        const index = dropIndex(d.rects.map(centerOf), x);
        const n = d.rects.length;
        const edge = index < n ? d.rects[index].left - TabGapPx / 2 : d.rects[n - 1].right + TabGapPx / 2;
        const inFrame = d.frame != null && x >= d.frame.left && x <= d.frame.right;
        return { index, markX: edge - d.rowLeft, inFrame };
    };
    const onTabPointerDown = (tick: RadarTick, e: React.PointerEvent<HTMLElement>) => {
        e.stopPropagation();
        if (e.button !== 0) {
            return;
        }
        const row = rowRef.current;
        if (row == null) {
            return;
        }
        const rects = Array.from(row.querySelectorAll<HTMLElement>(".mt-strip-tab")).map((el) =>
            el.getBoundingClientRect()
        );
        const frame = row.querySelector<HTMLElement>(".mt-radar-window")?.getBoundingClientRect() ?? null;
        // The drop mark is drawn inside the tab list, after the automatic-360 mark.
        const list = row.querySelector<HTMLElement>(".mt-strip-tabs") ?? row;
        tabDragRef.current = {
            pointerId: e.pointerId,
            columnId: tick.columnId,
            startX: e.clientX,
            rowLeft: list.getBoundingClientRect().left,
            rects,
            frame,
            moved: false,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
    };
    const onTabPointerMove = (e: React.PointerEvent<HTMLElement>) => {
        const d = tabDragRef.current;
        if (d == null || d.pointerId !== e.pointerId) {
            return;
        }
        if (!d.moved && Math.abs(e.clientX - d.startX) < DragThresholdPx) {
            return;
        }
        if (!d.moved) {
            d.moved = true;
            setHover(null);
        }
        const at = dropAt(d, e.clientX);
        setDrag({ columnId: d.columnId, dx: e.clientX - d.startX, markX: at.markX, inFrame: at.inFrame });
    };
    const onTabPointerUp = (e: React.PointerEvent<HTMLElement>) => {
        const d = tabDragRef.current;
        if (d == null || d.pointerId !== e.pointerId) {
            return;
        }
        tabDragRef.current = null;
        if (!d.moved) {
            return;
        }
        setDrag(null);
        suppressNextClick();
        if (e.type !== "pointerup") {
            return;
        }
        const tick = ticks.find((t) => t.columnId === d.columnId);
        if (tick == null) {
            return;
        }
        const at = dropAt(d, e.clientX);
        moveTo(tick, at.index, at.inFrame);
    };

    const handlers: StripHandlers = {
        go: goTo,
        close,
        menu: showMenu,
        add: () => fireAndForget(() => addCarpetPanel(layoutModel, "end")),
        hover: onHover,
        tabPointerDown: onTabPointerDown,
        tabPointerMove: onTabPointerMove,
        tabPointerUp: onTabPointerUp,
        windowEnter: onWindowEnter,
        windowLeave: () => setWindowX(null),
        windowPointerDown: onWindowPointerDown,
        windowPointerMove: onWindowPointerMove,
        windowPointerUp: onWindowPointerUp,
    };

    const hoveredTick = hover == null ? null : ticks.find((t) => t.columnId === hover.columnId);
    // On the window's edge, the last tab left behind outside it no longer speaks: the card is the window's.
    const windowCard = windowX != null && (hoveredTick == null || !hoveredTick.visible);
    const hovered = windowCard ? null : hoveredTick;
    const cardX = windowCard ? windowX : (hover?.x ?? 0);
    const cardLeft = Math.min(Math.max(cardX - CardWidthPx / 2, 4), surface.width - CardWidthPx - 4);
    const busy = scrubbing || drag != null;
    const opener = hovered?.page ? (pages[hovered.focusBlockId]?.agentName ?? "") : "";

    return (
        <div
            ref={rowRef}
            className="mt-radar"
            style={rowStyle}
            data-mode={strip.mode}
            data-testid="mt-carpet-radar"
            onPointerLeave={() => {
                // The frame may have moved under a still pointer (a tab added): leaving the strip ends both cards.
                setHover(null);
                setWindowX(null);
            }}
        >
            <CarpetStrip
                ticks={ticks}
                layout={strip}
                pitch={pitch}
                focusedColumnId={focusedColumnId}
                rovingColumnId={rovingColumnId(ticks, focusedColumnId)}
                pages={pages}
                numbers={numbers}
                drag={drag}
                scrubbing={scrubbing}
                handlers={handlers}
                lead={<RadarAutoMark view360={view360} />}
            />
            {hovered != null && !busy && (
                <div
                    className="mt-radar-card"
                    style={{ left: cardLeft, width: CardWidthPx }}
                    data-attention={hovered.attention ?? undefined}
                    role="tooltip"
                >
                    <b>{hovered.title}</b>
                    <i>{radarHint(hovered)}</i>
                    {opener && <i className="mt-radar-card-opener">{StripText.openedBy(opener)}</i>}
                    {hovered.visible && windowX != null && (
                        <span className="mt-radar-card-window">
                            <EyeIcon strokeWidth={2} aria-hidden />
                            {radarWindowLine()}
                        </span>
                    )}
                </div>
            )}
            {windowCard && !busy && (
                <div
                    className="mt-radar-card"
                    style={{ left: cardLeft, width: CardWidthPx }}
                    data-window=""
                    role="tooltip"
                >
                    <b>
                        <EyeIcon strokeWidth={2} aria-hidden />
                        {RadarText.window}
                    </b>
                    <i>{RadarText.windowHint}</i>
                </div>
            )}
        </div>
    );
});
View360Radar.displayName = "View360Radar";
