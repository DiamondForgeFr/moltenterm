// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The web page panel's inspector (FR-BRW-022, DS-BRW-027): which pages have their developer tools docked below them,
// how much of the panel the tools take, and where emain places them. The tools themselves are a view emain keeps in
// the tab view (emain/moltenterm-browser-inspector.ts); the panel draws the pane they cover and says where it is and
// whether it shows.

import { getApi, getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, Atom, PrimitiveAtom } from "jotai";

export const InspectorSizeKey = "moltenterm:browserinspectorsize";
export const InspectorSizeMin = 0.15;
export const InspectorSizeMax = 0.85;
export const InspectorSizeDefault = 0.4;
// One press of an arrow key on the divider.
export const InspectorSizeStep = 0.05;
// Below this, in CSS pixels, the visible part of the pane is too small to show the tools.
export const InspectorMinShownPx = 40;

// The element Inspect selects: a point in the window's CSS pixels, where the page's right-click menu opened.
export type InspectorPoint = { x: number; y: number };
// The pane's body in CSS pixels of the window, and whether the tools show there.
export type InspectorPlace = { x: number; y: number; width: number; height: number; visible: boolean };
export type InspectorEntry = { nonce: number; point?: InspectorPoint };
export type ClearDataResult = { ok: boolean; reason?: "gone" | "moved" | "failed"; error?: string };

export type InspectorApi = {
    moltentermInspectorOpen?: (pageId: number, place: InspectorPlace, point: InspectorPoint) => Promise<boolean>;
    moltentermInspectorPlace?: (pageId: number, place: InspectorPlace) => void;
    moltentermInspectorClose?: (pageId: number) => Promise<boolean>;
    moltentermInspectorWindow?: (pageId: number) => Promise<boolean>;
    onMoltentermInspectorGone?: (callback: (pageId: number) => void) => () => void;
    moltentermBrowserClearData?: (pageId: number, kind: string, origin?: string) => Promise<ClearDataResult>;
};

export function inspectorApi(): InspectorApi {
    return getApi() as unknown as InspectorApi;
}

export function clampInspectorSize(size: number): number {
    return Math.min(InspectorSizeMax, Math.max(InspectorSizeMin, size));
}

// The stored share, or the default for anything that is not one.
export function inspectorSize(raw: unknown): number {
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < InspectorSizeMin || raw > InspectorSizeMax) {
        return InspectorSizeDefault;
    }
    return raw;
}

// The divider dragged from startY to y over an area of areaHeight pixels: up makes the tools taller.
export function draggedInspectorSize(startSize: number, startY: number, y: number, areaHeight: number): number {
    if (!(areaHeight > 0)) {
        return clampInspectorSize(startSize);
    }
    return clampInspectorSize(startSize + (startY - y) / areaHeight);
}

// The divider's keys: up and down by a step, Home and End to the bounds. null for any other key.
export function keyedInspectorSize(size: number, key: string): number {
    switch (key) {
        case "ArrowUp":
            return clampInspectorSize(size + InspectorSizeStep);
        case "ArrowDown":
            return clampInspectorSize(size - InspectorSizeStep);
        case "Home":
            return InspectorSizeMax;
        case "End":
            return InspectorSizeMin;
    }
    return null;
}

type Rect = { left: number; top: number; right: number; bottom: number };

function intersect(a: Rect, b: Rect): Rect {
    return {
        left: Math.max(a.left, b.left),
        top: Math.max(a.top, b.top),
        right: Math.min(a.right, b.right),
        bottom: Math.min(a.bottom, b.bottom),
    };
}

function clips(style: CSSStyleDeclaration): boolean {
    return [style.overflow, style.overflowX, style.overflowY].some((v) => v != null && v !== "" && v !== "visible");
}

// The part of the element the window shows: its box cut by every scrolling or clipping ancestor (the 360 carpet, a
// panel moved half out of view) and by the window itself. A native view cannot be clipped, only placed.
export function shownRect(el: Element, win: Window = window): Rect {
    const box = el.getBoundingClientRect();
    let rect: Rect = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
    for (let p = el.parentElement; p != null; p = p.parentElement) {
        if (!clips(win.getComputedStyle(p))) {
            continue;
        }
        const pr = p.getBoundingClientRect();
        rect = intersect(rect, { left: pr.left, top: pr.top, right: pr.right, bottom: pr.bottom });
    }
    return intersect(rect, { left: 0, top: 0, right: win.innerWidth, bottom: win.innerHeight });
}

// Whether something of the window (a menu, a popover, the command panel, a toast) lies over the pane: the native view
// would hide it. Nine points of the rectangle are asked who is on top.
export function coveredRect(rect: Rect, owner: Element, doc: Document = document): boolean {
    const inset = 2;
    const xs = [rect.left + inset, (rect.left + rect.right) / 2, rect.right - inset];
    const ys = [rect.top + inset, (rect.top + rect.bottom) / 2, rect.bottom - inset];
    for (const x of xs) {
        for (const y of ys) {
            const top = doc.elementFromPoint(x, y);
            if (top != null && top !== owner && !owner.contains(top)) {
                return true;
            }
        }
    }
    return false;
}

export function inspectorPlace(rect: Rect, visible: boolean): InspectorPlace {
    const width = Math.max(0, rect.right - rect.left);
    const height = Math.max(0, rect.bottom - rect.top);
    return {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(width),
        height: Math.round(height),
        visible: visible && width >= InspectorMinShownPx && height >= InspectorMinShownPx,
    };
}

export const HiddenPlace: InspectorPlace = { x: 0, y: 0, width: 0, height: 0, visible: false };

// An async function: a write that throws (no backend yet) fails as a promise, whose failure is only logged.
async function writeSize(value: number): Promise<void> {
    await RpcApi.SetConfigCommand(TabRpcClient, { [InspectorSizeKey]: value } as SettingsType);
}

// One subscription for the window: emain says a page's docked tools went away by themselves (the page closed or
// crashed), and the panel holding that page closes its pane.
const goneHandlers = new Set<(pageId: number) => void>();
let goneOff: () => void = null;

export function onInspectorGone(handler: (pageId: number) => void): () => void {
    goneHandlers.add(handler);
    if (goneOff == null) {
        goneOff = inspectorApi()?.onMoltentermInspectorGone?.((pageId) => {
            for (const h of goneHandlers) {
                h(pageId);
            }
        });
    }
    return () => {
        goneHandlers.delete(handler);
    };
}

// A panel's inspectors, one per tab whose tools are docked.
export class BrowserInspectorModel {
    entriesAtom = atom({}) as PrimitiveAtom<Record<string, InspectorEntry>>;
    // The share this panel's divider set, held until the setting comes back with it (the pane clears it then): the
    // tools do not jump back to the old size while the setting is written.
    dragSizeAtom = atom(null) as PrimitiveAtom<number>;
    sizeAtom: Atom<number>;
    // The page each open tab's tools inspect, once emain has them.
    pageIds = new Map<string, number>();
    nonce = 0;

    constructor() {
        this.sizeAtom = atom(
            (get) => get(this.dragSizeAtom) ?? inspectorSize(get(getSettingsKeyAtom(InspectorSizeKey)))
        );
    }

    entries(): Record<string, InspectorEntry> {
        return globalStore.get(this.entriesAtom);
    }

    isOpen(tabId: string): boolean {
        return this.entries()[tabId] != null;
    }

    // Opens the tab's tools, or selects another element in them: each call is a new request to emain.
    open(tabId: string, point?: InspectorPoint): void {
        this.nonce++;
        globalStore.set(this.entriesAtom, { ...this.entries(), [tabId]: { nonce: this.nonce, point } });
    }

    close(tabId: string): void {
        const entries = this.entries();
        if (entries[tabId] == null) {
            return;
        }
        const next = { ...entries };
        delete next[tabId];
        this.pageIds.delete(tabId);
        globalStore.set(this.entriesAtom, next);
    }

    toggle(tabId: string): void {
        if (this.isOpen(tabId)) {
            this.close(tabId);
            return;
        }
        this.open(tabId);
    }

    tabOfPage(pageId: number): string {
        for (const [tabId, id] of this.pageIds) {
            if (id === pageId) {
                return tabId;
            }
        }
        return null;
    }

    setDragSize(size: number): void {
        globalStore.set(this.dragSizeAtom, size == null ? null : clampInspectorSize(size));
    }

    // The size every panel's tools take from now on, and after a restart.
    saveSize(size: number): void {
        const value = clampInspectorSize(size);
        globalStore.set(this.dragSizeAtom, value);
        writeSize(value).catch((e) => console.log("browser inspector: the size could not be saved", e));
    }
}
