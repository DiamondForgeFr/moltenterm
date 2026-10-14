// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The carpet's IntersectionObserver (FR-SHELL-069, DS-SHELL-120): one observer per carpet, its root the carpet
// surface and its margin one default column on each side, so the neighbours of the columns in view stay ready. It
// watches one invisible sensor per carpet column, drawn inside the surface where the column is and moved by the same
// --mt-carpet-scroll variable: scrolling renders nothing and polls nothing, the observer reports only crossings.

import { globalStore } from "@/app/store/jotaiStore";
import type { LayoutModel } from "@/layout/lib/layoutModel";
import { findNode } from "@/layout/lib/layoutNode";
import type { LayoutNode } from "@/layout/lib/types";
import { memo, useEffect, useMemo, useRef } from "react";
import { CarpetLayout, CarpetScrollVar, DefaultCarpetColumnPx } from "./carpet-model";
import { CarpetColumnBlocks, keepLiveAtom, OffCarpetTracker } from "./offcarpet-model";
import "./view360-offcarpet.css";

function leafBlockIds(node: LayoutNode, out: string[] = []): string[] {
    if (node == null) {
        return out;
    }
    if (!node.children?.length) {
        if (node.data?.blockId) {
            out.push(node.data.blockId);
        }
        return out;
    }
    for (const child of node.children) {
        leafBlockIds(child, out);
    }
    return out;
}

export function carpetColumnBlocks(rootNode: LayoutNode, layout: CarpetLayout): CarpetColumnBlocks[] {
    if (rootNode == null || layout == null) {
        return [];
    }
    return layout.columns.map((c) => ({ columnId: c.nodeId, blockIds: leafBlockIds(findNode(rootNode, c.nodeId)) }));
}

// The panels of the fixed zone: the first column and the columns pinned to it (FR-SHELL-067), always visible.
export function fixedZoneBlockIds(rootNode: LayoutNode, layout: CarpetLayout): string[] {
    if (rootNode == null || layout == null) {
        return [];
    }
    const fixedIds = [layout.fixedNodeId, ...(layout.fixedColumns ?? []).map((c) => c.nodeId)];
    return [...new Set(fixedIds)].flatMap((id) => (id ? leafBlockIds(findNode(rootNode, id)) : []));
}

function exemptBlockIds(layoutModel: LayoutModel): string[] {
    const focused = globalStore.get(layoutModel.focusedNode)?.data?.blockId;
    const magnifiedId = globalStore.get(layoutModel.magnifiedNodeIdAtom);
    const rootNode = layoutModel.treeState?.rootNode;
    const magnified = magnifiedId && rootNode ? findNode(rootNode, magnifiedId)?.data?.blockId : null;
    return [focused, magnified, ...Object.keys(globalStore.get(keepLiveAtom))].filter((id) => !!id);
}

export const CarpetSensors = memo(({ layoutModel, layout }: { layoutModel: LayoutModel; layout: CarpetLayout }) => {
    const hostRef = useRef<HTMLDivElement>(null);
    const tracker = useMemo(() => new OffCarpetTracker(), []);
    const columnIds = layout.columns.map((c) => c.nodeId).join(",");

    useEffect(() => {
        const update = () => tracker.setExempt(exemptBlockIds(layoutModel));
        update();
        const unsubFocus = globalStore.sub(layoutModel.focusedNode, update);
        const unsubMagnified = globalStore.sub(layoutModel.magnifiedNodeIdAtom, update);
        const unsubKeepLive = globalStore.sub(keepLiveAtom, update);
        return () => {
            unsubFocus();
            unsubMagnified();
            unsubKeepLive();
        };
    }, [layoutModel, tracker]);

    useEffect(() => () => tracker.clear(), [tracker]);

    // Which blocks each column holds changes with the tree (a split inside a column), which also lays the carpet out
    // again: every layout pass gives a new layout object.
    useEffect(() => {
        const rootNode = layoutModel.treeState?.rootNode;
        tracker.setColumns(carpetColumnBlocks(rootNode, layout), fixedZoneBlockIds(rootNode, layout));
    }, [tracker, layoutModel, layout]);

    useEffect(() => {
        const root = hostRef.current?.parentElement;
        if (root == null || typeof IntersectionObserver === "undefined") {
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    const columnId = (entry.target as HTMLElement).dataset.column;
                    if (columnId) {
                        tracker.noteInView(columnId, entry.isIntersecting);
                    }
                }
            },
            { root, rootMargin: `0px ${DefaultCarpetColumnPx}px`, threshold: 0 }
        );
        for (const sensor of hostRef.current.querySelectorAll<HTMLElement>("[data-column]")) {
            observer.observe(sensor);
        }
        return () => observer.disconnect();
    }, [tracker, columnIds]);

    const offsetX = layout.viewport.left - layout.surface.left;
    const top = layout.viewport.top - layout.surface.top;
    return (
        <div ref={hostRef} className="mt-carpet-sensors" aria-hidden="true">
            {layout.columns.map((c) => (
                <div
                    key={c.nodeId}
                    data-column={c.nodeId}
                    className="mt-carpet-sensor"
                    style={{
                        width: c.width,
                        transform: `translate3d(calc(${offsetX + c.x}px - var(${CarpetScrollVar}, 0px)), ${top}px, 0)`,
                    }}
                />
            ))}
        </div>
    );
});
CarpetSensors.displayName = "CarpetSensors";
