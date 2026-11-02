// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The drop zones' layer (FR-SHELL-060, DS-SHELL-102): over the panel under the pointer, a quiet ring and the ghost
// of the zone's new panel; the dragged tab as a chip. It also follows the two drags the page does not hand over by
// itself: react-dnd's file drags (Wave's file browser) and the Sessions rows' HTML5 drags. Mounted once, inside
// react-dnd's provider (app.tsx).

import { getLayoutModelForStaticTab } from "@/layout/index";
import type { LayoutNode } from "@/layout/lib/types";
import { useAtomValue } from "jotai";
import { CSSProperties, ReactNode, useEffect, useRef } from "react";
import { useDragLayer, useDrop } from "react-dnd";
import { t, useLocale } from "../i18n/i18n";
import { DropZone, fileItemFromDragged, Rect, SessionDragType, zoneGhostRect } from "./drop-model";
import type { DropState } from "./drop-session";
import { panelDrop, panelDropStateAtom } from "./drop-zones";
import "./drop-zones.css";
import { landingSide, PanelMoveTarget, panelMoveTargetAt, panelName, zoneLabel } from "./panel-move";

// Wave's tile drag (TileLayout.tsx).
const TileItemType = "TILE_ITEM";

// Wave's file browser rows (preview-directory.tsx).
const FileItemType = "FILE_ITEM";
const GhostInsetPx = 4;
const ChipOffsetPx = 12;

function hasSessionType(e: DragEvent): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes(SessionDragType);
}

// react-dnd's file drags: begun, followed and ended from its monitor; the drop lands on the catcher laid over the
// zone, so Wave's own targets (a folder that copies the file) keep the rest of the panel.
function useFileDrags() {
    const { fileDragging, item, offset } = useDragLayer((monitor) => ({
        fileDragging: monitor.isDragging() && monitor.getItemType() === FileItemType,
        item: monitor.getItem<DraggedFile>(),
        offset: monitor.getClientOffset(),
    }));
    const begun = useRef(false);
    useEffect(() => {
        if (fileDragging && !begun.current) {
            begun.current = true;
            panelDrop.begin(fileItemFromDragged(item), offset?.x, offset?.y);
            return;
        }
        if (!fileDragging && begun.current) {
            begun.current = false;
            // Dropped elsewhere, or cancelled (Escape ends a native drag).
            if (panelDrop.state?.item.kind === "file") {
                panelDrop.cancel();
            }
            return;
        }
        if (fileDragging && offset != null) {
            panelDrop.move(offset.x, offset.y);
        }
    }, [fileDragging, offset?.x, offset?.y]);
    const [, drop] = useDrop(
        () => ({
            accept: FileItemType,
            drop: (_, monitor) => {
                const at = monitor.getClientOffset();
                panelDrop.drop(at?.x, at?.y);
                return { molten: true };
            },
        }),
        []
    );
    return drop;
}

// The Sessions rows' HTML5 drags: the row begins the session (sessions-view.tsx); the page's dragover and drop are
// taken here, before a terminal's own file drop.
function useSessionDrags() {
    useEffect(() => {
        const onOver = (e: DragEvent) => {
            if (!hasSessionType(e) || panelDrop.state?.item.kind !== "session") {
                return;
            }
            const zone = panelDrop.move(e.clientX, e.clientY);
            if (zone == null) {
                return;
            }
            // Kept from the panel's own handlers: a terminal sets "copy" for file drops, which a "move" drag refuses.
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer) {
                e.dataTransfer.dropEffect = "move";
            }
        };
        const onDrop = (e: DragEvent) => {
            if (!hasSessionType(e) || panelDrop.state?.item.kind !== "session") {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            panelDrop.drop(e.clientX, e.clientY);
        };
        document.addEventListener("dragover", onOver, true);
        document.addEventListener("drop", onDrop, true);
        return () => {
            document.removeEventListener("dragover", onOver, true);
            document.removeEventListener("drop", onDrop, true);
        };
    }, []);
}

// A panel dragged by its header (Wave's tile drag, FR-SHELL-086): the same ring, ghost and chip as the other drags,
// on the nearest of the four zones of the panel under the pointer. TileLayout.tsx carries the drop out.
function usePanelMoveTarget(): PanelMoveTarget {
    const { tileDragging, item, offset } = useDragLayer((monitor) => ({
        tileDragging: monitor.isDragging() && monitor.getItemType() === TileItemType,
        item: monitor.getItem<LayoutNode>(),
        offset: monitor.getClientOffset(),
    }));
    useLocale();
    if (!tileDragging || offset == null) {
        return null;
    }
    return panelMoveTargetAt(item?.data?.blockId, offset.x, offset.y);
}

function ghostStyleFor(rect: Rect, zone: DropZone): CSSProperties {
    const ghost = rect != null && zone != null ? zoneGhostRect(zone, rect.width, rect.height) : null;
    if (ghost == null) {
        return null;
    }
    return {
        left: rect.left + ghost.left + GhostInsetPx,
        top: rect.top + ghost.top + GhostInsetPx,
        width: Math.max(0, ghost.width - 2 * GhostInsetPx),
        height: Math.max(0, ghost.height - 2 * GhostInsetPx),
    };
}

// The zone a tab or file drop shows: where it lands once the 360 view's rule applies, and the chip that says so.
function dropZoneShown(state: DropState): { zone: DropZone; label: string } {
    const { target, zone } = state;
    if (target == null || zone == null) {
        return { zone: null, label: null };
    }
    if (zone === "center") {
        return { zone, label: t("split.zone.here", { name: panelName(target.blockId) }) };
    }
    const layoutModel = getLayoutModelForStaticTab();
    const node = layoutModel?.getNodeByBlockId(target.blockId);
    const side = node == null ? zone : landingSide(layoutModel, node.id, zone);
    return { zone: side, label: zoneLabel(side, panelName(target.blockId)) };
}

function DropFrame({
    rect,
    zone,
    label,
    children,
}: {
    rect: Rect;
    zone: DropZone;
    label: string;
    children?: ReactNode;
}) {
    const ghostStyle = ghostStyleFor(rect, zone);
    return (
        <div className="molten-drop-layer" data-testid="molten-drop-layer" aria-hidden="true">
            {rect != null ? (
                <div
                    className="molten-drop-panel"
                    style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
                />
            ) : null}
            {ghostStyle != null ? (
                <div className="molten-drop-ghost" data-zone={zone} style={ghostStyle}>
                    {label ? (
                        <span className="molten-drop-zone-chip" data-testid="molten-drop-zone-chip">
                            {label}
                        </span>
                    ) : null}
                </div>
            ) : null}
            {children}
        </div>
    );
}

export function PanelDropZones() {
    const state = useAtomValue(panelDropStateAtom);
    const fileDrop = useFileDrags();
    useSessionDrags();
    const panelMove = usePanelMoveTarget();
    if (state == null) {
        if (panelMove == null) {
            return null;
        }
        return <DropFrame rect={panelMove.target.rect} zone={panelMove.side} label={panelMove.label} />;
    }
    const { item, target, x, y } = state;
    const rect = target?.rect;
    const shown = dropZoneShown(state);
    const ghostStyle = ghostStyleFor(rect, state.zone);
    return (
        <DropFrame rect={rect} zone={shown.zone} label={shown.label}>
            {item.kind === "file" && ghostStyle != null ? (
                <div ref={fileDrop as any} className="molten-drop-catcher" style={ghostStyle} />
            ) : null}
            {item.kind === "tab" && x >= 0 ? (
                <div className="molten-drop-chip" style={{ left: x + ChipOffsetPx, top: y + ChipOffsetPx }}>
                    {item.name}
                </div>
            ) : null}
        </DropFrame>
    );
}
