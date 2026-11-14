// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The pane of a page's developer tools, docked below the page in the web page panel (FR-BRW-022, DS-BRW-027): a
// divider, a header (Developer tools, Open in a separate window, Close) and the body the tools cover. The tools are a
// view emain draws over the body; the pane tells it where the body is and whether the window shows it, each time the
// answer changes.

import { getSettingsKeyAtom } from "@/app/store/global";
import { isMacOS } from "@/util/platformutil";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/i18n";
import { modalIsOpen } from "../modal-open";
import { formatShortcutById } from "../shortcuts/format";
import { TabActivity, whileShown } from "../tab-activity";
import {
    BrowserInspectorModel,
    clippingAncestors,
    coveredRect,
    draggedInspectorSize,
    HiddenPlace,
    inspectorApi,
    InspectorEntry,
    inspectorPlace,
    InspectorSizeKey,
    InspectorSizeMax,
    InspectorSizeMin,
    keyedInspectorSize,
    shownRect,
    shownRectWithin,
} from "./browser-inspector";

// How often the pane asks whether a surface of the window lies over it (a hit test of nine points), and where it is.
const CoverCheckMs = 100;

const HeadButton =
    "flex h-6 w-6 cursor-pointer items-center justify-center rounded-4 text-12 text-secondary hover:bg-hover hover:text-primary";

// What the pane needs of its panel; the browser's view model implements it.
export type InspectorPaneHost = {
    inspector: BrowserInspectorModel;
    pageIdOf(tabId: string): number;
    closeInspector(tabId: string): void;
    openPageDevTools(tabId?: string): void;
    inspectorFailed(tabId: string): void;
};

function placeKey(p: { x: number; y: number; width: number; height: number; visible: boolean }): string {
    return `${p.x},${p.y},${p.width},${p.height},${p.visible}`;
}

export function InspectorPane({
    host,
    tabId,
    entry,
    active,
    shown,
}: {
    host: InspectorPaneHost;
    tabId: string;
    entry: InspectorEntry;
    // The panel's shown page: the pane takes its room in the panel.
    active: boolean;
    // ... in a view that shows: the tools show.
    shown: boolean;
}) {
    const t = useT();
    const size = useAtomValue(host.inspector.sizeAtom);
    const stored = useAtomValue(getSettingsKeyAtom(InspectorSizeKey));
    const paneRef = useRef<HTMLDivElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const pageIdRef = useRef<number>(null);
    const sentRef = useRef("");
    const shownRef = useRef(shown && active);
    shownRef.current = shown && active;
    const dragRef = useRef<{ y: number; size: number; height: number; last: number }>(null);
    const [dragging, setDragging] = useState(false);
    // Places the tools again now (the pane moved, showed or hid); null until the placement effect runs.
    const placeNowRef = useRef<() => void>(null);

    // The setting came back with the divider's size (or another panel's): this panel follows it again.
    useEffect(() => {
        host.inspector.setDragSize(null);
    }, [host, stored]);

    // Each open or Inspect asks emain again: it makes the tools, or selects the element in the ones it has.
    useEffect(() => {
        const api = inspectorApi();
        const pageId = host.pageIdOf(tabId);
        if (pageId == null || api?.moltentermInspectorOpen == null) {
            host.inspectorFailed(tabId);
            return;
        }
        let live = true;
        pageIdRef.current = pageId;
        host.inspector.pageIds.set(tabId, pageId);
        const body = bodyRef.current;
        const place =
            body != null && shownRef.current && !modalIsOpen() ? inspectorPlace(shownRect(body), true) : HiddenPlace;
        api.moltentermInspectorOpen(pageId, place, entry.point ?? null).then(
            (ok) => {
                // A pane closed (or asked again) meanwhile: its answer is no one's.
                if (!live) {
                    return;
                }
                if (!ok) {
                    host.inspectorFailed(tabId);
                    return;
                }
                // The view shows on the pane's first place after the answer: one sent before it went nowhere.
                sentRef.current = "";
                placeNowRef.current?.();
            },
            () => live && host.inspectorFailed(tabId)
        );
        return () => {
            live = false;
        };
    }, [host, tabId, entry.nonce]);

    useEffect(
        () => () => {
            const pageId = pageIdRef.current;
            if (pageId != null) {
                inspectorApi()
                    ?.moltentermInspectorClose?.(pageId)
                    ?.catch((e) => console.log("browser inspector: closing failed", e));
            }
        },
        []
    );

    // The tools follow the pane when it changes size, when anything scrolls (the 360 carpet), when the window resizes or
    // a transition ends, and at the cover check, which also catches a panel moving by a transform. The clipping
    // ancestors are read again only when the layout changes. Hidden while a dialog is up, the divider is dragged (a
    // pointer-up lost over the native view would leave the drag stuck) or something lies over the pane.
    useEffect(() => {
        const body = bodyRef.current;
        if (body == null) {
            return;
        }
        let clippers = clippingAncestors(body);
        let covered = false;
        const placeNow = (checkCover: boolean) => {
            const pageId = pageIdRef.current;
            if (pageId == null) {
                return;
            }
            let place = HiddenPlace;
            if (shownRef.current && dragRef.current == null && !modalIsOpen()) {
                const rect = shownRectWithin(body, clippers);
                if (checkCover) {
                    covered = rect.right > rect.left && rect.bottom > rect.top && coveredRect(rect, body);
                }
                place = inspectorPlace(rect, !covered);
            }
            const key = placeKey(place);
            if (key === sentRef.current) {
                return;
            }
            sentRef.current = key;
            inspectorApi()?.moltentermInspectorPlace?.(pageId, place);
        };
        const onLayout = () => {
            clippers = clippingAncestors(body);
            placeNow(false);
        };
        const onMove = () => placeNow(false);
        placeNowRef.current = () => placeNow(true);
        const resize = new ResizeObserver(onLayout);
        resize.observe(body);
        window.addEventListener("resize", onLayout);
        document.addEventListener("scroll", onMove, true);
        document.addEventListener("transitionend", onLayout, true);
        document.addEventListener("animationend", onLayout, true);
        const stopCheck = TabActivity.getInstance().every(
            whileShown(CoverCheckMs),
            () => placeNow(true),
            "browser-inspector"
        );
        placeNow(true);
        return () => {
            placeNowRef.current = null;
            stopCheck();
            resize.disconnect();
            window.removeEventListener("resize", onLayout);
            document.removeEventListener("scroll", onMove, true);
            document.removeEventListener("transitionend", onLayout, true);
            document.removeEventListener("animationend", onLayout, true);
        };
    }, []);

    // The page shown or hidden, the view shown or hidden: placed at once rather than at the next check.
    useEffect(() => {
        placeNowRef.current?.();
    }, [shown, active]);

    const shortcut = formatShortcutById(isMacOS() ? "browser-inspect" : "browser-inspect-other");
    const endDrag = (save: boolean) => {
        const drag = dragRef.current;
        dragRef.current = null;
        setDragging(false);
        if (drag != null && save && drag.last !== drag.size) {
            host.inspector.saveSize(drag.last);
        }
        placeNowRef.current?.();
    };
    return (
        <div
            ref={paneRef}
            className={cn("molten-browser-inspector flex shrink-0 flex-col", !active && "hidden")}
            style={{ height: `${size * 100}%` }}
            data-testid="browser-inspector"
        >
            <div
                role="separator"
                aria-orientation="horizontal"
                aria-label={t("browser.inspector.resize")}
                aria-valuemin={Math.round(InspectorSizeMin * 100)}
                aria-valuemax={Math.round(InspectorSizeMax * 100)}
                aria-valuenow={Math.round(size * 100)}
                tabIndex={0}
                className={cn("molten-browser-inspector-grip", dragging && "is-on")}
                data-testid="browser-inspector-grip"
                onPointerDown={(e) => {
                    if (e.button !== 0) {
                        return;
                    }
                    e.preventDefault();
                    e.currentTarget.setPointerCapture?.(e.pointerId);
                    const height = paneRef.current?.parentElement?.clientHeight ?? 0;
                    dragRef.current = { y: e.clientY, size, height, last: size };
                    setDragging(true);
                    placeNowRef.current?.();
                }}
                onPointerMove={(e) => {
                    const drag = dragRef.current;
                    if (drag == null) {
                        return;
                    }
                    drag.last = draggedInspectorSize(drag.size, drag.y, e.clientY, drag.height);
                    host.inspector.setDragSize(drag.last);
                }}
                onPointerUp={(e) => {
                    const drag = dragRef.current;
                    if (drag != null) {
                        drag.last = draggedInspectorSize(drag.size, drag.y, e.clientY, drag.height);
                    }
                    endDrag(true);
                }}
                // The pointer-up may never come (released outside the window): the capture's end closes the drag where
                // the divider was.
                onLostPointerCapture={() => endDrag(true)}
                onPointerCancel={() => {
                    endDrag(false);
                    host.inspector.setDragSize(null);
                }}
                onKeyDown={(e) => {
                    const next = keyedInspectorSize(size, e.key);
                    if (next == null) {
                        return;
                    }
                    e.preventDefault();
                    host.inspector.saveSize(next);
                }}
            />
            <div className="molten-browser-inspector-head flex h-7 shrink-0 items-center gap-1 pr-1 pl-2 text-12">
                <i aria-hidden="true" className="fa fa-solid fa-code shrink-0 text-11 text-muted" />
                <span className="min-w-0 flex-1 truncate text-secondary">{t("browser.inspector.title")}</span>
                <button
                    type="button"
                    className={HeadButton}
                    title={t("browser.inspector.window")}
                    aria-label={t("browser.inspector.window")}
                    data-testid="browser-inspector-window"
                    onClick={() => host.openPageDevTools(tabId)}
                >
                    <i aria-hidden="true" className="fa fa-solid fa-arrow-up-right-from-square" />
                </button>
                <button
                    type="button"
                    className={HeadButton}
                    title={t("browser.inspector.closeTitle", { shortcut })}
                    aria-label={t("browser.inspector.close")}
                    data-testid="browser-inspector-close"
                    onClick={() => host.closeInspector(tabId)}
                >
                    <i aria-hidden="true" className="fa fa-solid fa-xmark" />
                </button>
            </div>
            <div ref={bodyRef} className="molten-browser-inspector-body relative min-h-0 flex-1" />
        </div>
    );
}
