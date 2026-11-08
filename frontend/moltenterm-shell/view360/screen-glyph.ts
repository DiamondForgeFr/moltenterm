// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What a view's icon says of a 360 view (FR-SHELL-081, FR-SHELL-065, #1823, #1861): one mark per screen region, not per
// panel. The fixed zone keeps its panels' icons; the carpet, whatever it holds, is one cube whose front face is the
// carpet panel in front, or a prism of the icons of the panels on screen when there are several (#1861). Only the
// window that draws a tab knows its carpet (a tab is a renderer of its own), so that window publishes this small
// description in the tab's meta and every sidebar reads it. Read-only on the carpet: nothing here moves it. Kept apart
// from the components so the rules are tested without the app.

import { findNode } from "@/layout/lib/layoutNode";
import type { LayoutNode } from "@/layout/lib/types";
import { MaxGlyphIcons, type GlyphCube, type GlyphFavicon, type GlyphIcon } from "../sidebar/view-menu-model";
import type { CarpetLayout } from "./carpet-model";

export const ScreenMetaKey = "molten:view360screen";

export type ScreenDescription = {
    // The panels of the fixed zone (the first column and the columns pinned beside it), by block, in layout order.
    fixed: string[];
    // The carpet's columns, each by its first panel (the one its tab in the strip names), in carpet order.
    carpet: string[];
    // The first carpet column in view, by its first panel: the face the view's icon shows (360 × N: the first of the N).
    front: string;
    // How many carpet columns are in view, from the front one on: the icons the prism shows. At least one.
    shown: number;
};

function leafBlockIds(node: LayoutNode): string[] {
    if (node == null) {
        return [];
    }
    if (!node.children?.length) {
        return node.data?.blockId ? [node.data.blockId] : [];
    }
    return node.children.flatMap(leafBlockIds);
}

// The screen of a tab drawn in 360 view, or null when it is not (layout null) or its carpet holds no panel.
export function describeScreen(root: LayoutNode, layout: CarpetLayout, visibleColumnIds: string[]): ScreenDescription {
    if (root == null || layout == null) {
        return null;
    }
    const leads = (layout.columns ?? [])
        .map((column) => ({ columnId: column.nodeId, lead: leafBlockIds(findNode(root, column.nodeId))[0] }))
        .filter((column) => column.lead != null);
    if (leads.length === 0) {
        return null;
    }
    const visible = new Set(visibleColumnIds ?? []);
    const inView = leads.filter((column) => visible.has(column.columnId));
    const front = inView[0] ?? leads[0];
    return {
        fixed: (layout.fixedColumns ?? []).flatMap((column) => leafBlockIds(findNode(root, column.nodeId))),
        carpet: leads.map((column) => column.lead),
        front: front.lead,
        shown: Math.max(1, inView.length),
    };
}

// What the publisher has to say about the carpet as it is, undefined while it has nothing to say yet: the tab is not
// measured (a tab not drawn yet is not a tab without a carpet), or a swipe or a drag still moves the carpet (#1924).
// restIds are the columns in view where the carpet rests, not the ones it passes through.
export function screenToPublish(
    root: LayoutNode,
    layout: CarpetLayout,
    restIds: string[],
    moving: boolean,
    columnCount: number
): ScreenDescription | undefined {
    if (!(columnCount > 0) || moving) {
        return undefined;
    }
    return describeScreen(root, layout, restIds);
}

export function sameScreen(a: ScreenDescription, b: ScreenDescription): boolean {
    if (a == null || b == null) {
        return a == b;
    }
    const same = (x: string[], y: string[]) => x.length === y.length && x.every((id, i) => id === y[i]);
    return a.front === b.front && a.shown === b.shown && same(a.fixed, b.fixed) && same(a.carpet, b.carpet);
}

function readIds(value: unknown): string[] {
    return Array.isArray(value) && value.every((id) => typeof id === "string" && id !== "")
        ? (value as string[])
        : null;
}

// What the tab's meta holds, null when it holds none or something else. A description written before the prism (#1861)
// has no count of panels on screen: it shows one.
export function readScreen(raw: unknown): ScreenDescription {
    const value = raw as Record<string, unknown>;
    const fixed = readIds(value?.fixed);
    const carpet = readIds(value?.carpet);
    if (fixed == null || carpet == null || carpet.length === 0 || typeof value.front !== "string") {
        return null;
    }
    const shown = Number.isInteger(value.shown) && (value.shown as number) >= 1 ? (value.shown as number) : 1;
    return { fixed, carpet, front: value.front, shown };
}

// The marks of a tab drawn in 360 view: the fixed zone's panels (all but one place for the cube, at most
// MaxGlyphIcons marks in all), then the carpet's cube. Panels that closed since the description was written leave it;
// null when no carpet panel is left, and the view's icon goes back to its panels. iconOf gives a panel's icon; siteOf,
// when given, the site's icon a web page panel shows instead (the icon menu's preview, #1962).
export function screenGlyphIcons(
    screen: ScreenDescription,
    liveBlockIds: readonly string[],
    iconOf: (blockId: string) => string,
    siteOf?: (blockId: string) => GlyphFavicon
): GlyphIcon[] {
    if (screen == null) {
        return null;
    }
    const live = new Set(liveBlockIds ?? []);
    const carpet = screen.carpet.filter((id) => live.has(id));
    if (carpet.length === 0) {
        return null;
    }
    const frontId = carpet.includes(screen.front) ? screen.front : carpet[0];
    const index = carpet.indexOf(frontId);
    const cube: GlyphCube = {
        cube: true,
        id: frontId,
        icon: iconOf(frontId),
        index,
        count: carpet.length,
        shown: Math.min(Math.max(1, screen.shown ?? 1), carpet.length - index),
        panels: carpet.map((id) => {
            const site = siteOf?.(id);
            return site != null ? { id, icon: iconOf(id), site } : { id, icon: iconOf(id) };
        }),
    };
    const fixed = screen.fixed.filter((id) => live.has(id)).map((id): GlyphIcon => siteOf?.(id) ?? iconOf(id));
    return [...fixed.filter((icon) => !!icon).slice(0, MaxGlyphIcons - 1), cube];
}
