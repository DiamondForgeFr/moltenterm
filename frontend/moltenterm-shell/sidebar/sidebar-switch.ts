// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Switching workspaces from the sidebar (FR-SHELL-082): a dot, a swipe and ⌥1…⌥9 go through switchFromSidebar, so they
// land the same way. Each workspace's tab is its own renderer: the one left records which way the switch goes, its
// frame's colour and, for a swipe, where its settle started (#1248); the one that shows the new workspace takes the
// same spring up where it stands, so the view swap never interrupts the motion, and its colour fades from the old tint.

import { atoms, getApi, globalStore } from "@/app/store/global";
import { WorkspaceService } from "@/app/store/services";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { prefersReducedMotion } from "../molten-motion";
import { settleFrames, SettleMs, settleOffset, SwipeAbsorb, SwipeSettle, workspaceAtNumber } from "./sidebar-swipe";

export const SwitchIntentKey = "moltenterm:sidebar-switch";
// The new workspace's tab view may take a moment to load; an older record belongs to a switch that went elsewhere.
export const SwitchIntentMaxAgeMs = 2500;

export type SwitchIntent = {
    workspaceId: string;
    direction: -1 | 1;
    from: string;
    // Date.now() when the switch was asked, which is when the settle started.
    at: number;
    // Where the swipe's settle started, as a share of the width (0 for a dot or a key), and its velocity in px/ms.
    offset?: number;
    v0?: number;
    // The gesture's momentum, on the Date.now() clock: the new view absorbs its rest.
    absorb?: SwipeAbsorb;
};

// What a swipe hands to the switch.
export type SwitchSwipe = { offset: number; v0: number; absorb: SwipeAbsorb };

function readStorage(key: string): string {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeStorage(key: string, value: string) {
    try {
        if (value == null) {
            window.localStorage.removeItem(key);
        } else {
            window.localStorage.setItem(key, value);
        }
    } catch {
        // Without storage the switch happens without its slide.
    }
}

function finite(v: unknown): number {
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function parseSwitchIntent(raw: string): SwitchIntent {
    if (!raw) {
        return null;
    }
    try {
        const v = JSON.parse(raw);
        if (typeof v?.workspaceId !== "string" || typeof v?.at !== "number") {
            return null;
        }
        const intent: SwitchIntent = {
            workspaceId: v.workspaceId,
            direction: v.direction === -1 ? -1 : 1,
            from: typeof v.from === "string" ? v.from : "",
            at: v.at,
        };
        const offset = finite(v.offset);
        if (offset != null) {
            intent.offset = Math.max(0, Math.min(1, offset));
        }
        const v0 = finite(v.v0);
        if (v0 != null) {
            intent.v0 = v0;
        }
        const a = v.absorb;
        if (finite(a?.sign) != null && finite(a?.lastAbs) != null && finite(a?.lastAt) != null) {
            intent.absorb = { sign: Math.sign(a.sign), lastAbs: a.lastAbs, lastAt: a.lastAt };
        }
        return intent;
    } catch {
        return null;
    }
}

export function isArrival(intent: SwitchIntent, workspaceId: string, now: number): boolean {
    return (
        intent != null &&
        intent.workspaceId === workspaceId &&
        now - intent.at >= 0 &&
        now - intent.at < SwitchIntentMaxAgeMs
    );
}

// The settle the switch started, along the sidebar's axis (positive toward the next workspace).
function intentSettle(intent: SwitchIntent, width: number): SwipeSettle {
    const side = intent.direction;
    return {
        from: side * (intent.offset ?? 0) * width,
        to: side * width,
        v0: intent.v0 ?? 0,
        at: intent.at,
        commit: side,
        kind: "page",
    };
}

// Where the new workspace's page stands at a time: it came in from its side and reaches 0 when the settle ends.
export function arrivalOffset(intent: SwitchIntent, width: number, now: number): number {
    const settle = intentSettle(intent, width);
    return settle.to - settleOffset(settle, now);
}

// The sidebar's frame: the window around the sidebar and the panels, tinted by the workspace (workspace.tsx).
export function frameElement(): HTMLElement {
    return document.querySelector<HTMLElement>(".mt-sb-frame");
}

export function switchFromSidebar(workspaceId: string, direction: -1 | 1, swipe?: SwitchSwipe) {
    if (!workspaceId || workspaceId === globalStore.get(atoms.workspace)?.oid) {
        return;
    }
    const frame = frameElement();
    const from = frame ? getComputedStyle(frame).backgroundColor : "";
    const intent: SwitchIntent = { workspaceId, direction, from, at: Date.now() };
    if (swipe != null) {
        intent.offset = swipe.offset;
        intent.v0 = swipe.v0;
        if (swipe.absorb != null) {
            intent.absorb = swipe.absorb;
        }
    }
    writeStorage(SwitchIntentKey, JSON.stringify(intent));
    getApi().switchWorkspace(workspaceId);
}

// The direction a switch from one workspace to another goes along the bottom bar's order.
export function switchDirection(ids: readonly string[], fromId: string, toId: string): -1 | 1 {
    return ids.indexOf(toId) < ids.indexOf(fromId) ? -1 : 1;
}

function takeArrival(workspaceId: string): SwitchIntent {
    const intent = parseSwitchIntent(readStorage(SwitchIntentKey));
    if (!isArrival(intent, workspaceId, Date.now())) {
        return null;
    }
    writeStorage(SwitchIntentKey, null);
    return intent;
}

const Easing = "cubic-bezier(0.2, 0, 0, 1)";

export function playArrival(intent: SwitchIntent, page: HTMLElement, frame: HTMLElement) {
    const now = Date.now();
    const left = intent.at + SettleMs - now;
    const duration = Math.max(1, left);
    if (page?.animate) {
        if (prefersReducedMotion()) {
            page.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "linear" });
        } else if (left > 16) {
            const width = page.getBoundingClientRect().width || 1;
            const settle = intentSettle(intent, width);
            const frames = settleFrames(settle, now).map((v) => ({ transform: `translateX(${settle.to - v}px)` }));
            page.animate(frames, { duration, easing: "linear" });
        }
    }
    if (frame?.animate && intent.from) {
        const to = getComputedStyle(frame).backgroundColor;
        if (to && to !== intent.from) {
            frame.animate([{ backgroundColor: intent.from }, { backgroundColor: to }], {
                duration: Math.max(120, duration),
                easing: Easing,
            });
        }
    }
}

// Plays the slide in the tab view that shows the workspace a sidebar switch went to, once it is on screen; onArrive
// hands the record to the swipe, which absorbs the gesture's momentum.
export function useSwitchArrival(pageRef: React.RefObject<HTMLElement>, onArrive?: (intent: SwitchIntent) => void) {
    const ws = useAtomValue(atoms.workspace);
    const wsId = ws?.oid;
    useEffect(() => {
        if (!wsId) {
            return;
        }
        const check = () => {
            if (document.visibilityState !== "visible") {
                return;
            }
            const current = globalStore.get(atoms.workspace);
            if (current?.activetabid && current.activetabid !== globalStore.get(atoms.staticTabId)) {
                return;
            }
            const intent = takeArrival(wsId);
            if (intent == null) {
                return;
            }
            playArrival(intent, pageRef.current, frameElement());
            onArrive?.(intent);
        };
        check();
        document.addEventListener("visibilitychange", check);
        return () => document.removeEventListener("visibilitychange", check);
    }, [wsId, pageRef, onArrive]);
}

// The bottom bar's order, read outside the sidebar (the keys): wavesrv's list, an unsaved workspace on screen first, as
// makeWorkspaceRailEntries orders the dots.
export async function sidebarWorkspaceIds(): Promise<string[]> {
    const list = await WorkspaceService.ListWorkspaces();
    const ids = (list ?? []).map((e) => e.workspaceid).filter((id) => !!id);
    const activeId = globalStore.get(atoms.workspace)?.oid;
    if (activeId && !ids.includes(activeId)) {
        ids.unshift(activeId);
    }
    return ids;
}

export async function switchToNumber(n: number) {
    const ids = await sidebarWorkspaceIds();
    const target = workspaceAtNumber(ids, n);
    if (target == null) {
        return;
    }
    switchFromSidebar(target, switchDirection(ids, globalStore.get(atoms.workspace)?.oid, target));
}
