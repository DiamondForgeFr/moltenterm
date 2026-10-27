// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Switching workspaces from the sidebar (FR-SHELL-082): a dot, a swipe and ⌥1…⌥9 go through switchFromSidebar, so they
// land the same way. Each workspace's tab is its own renderer: the one left records which way the switch goes and its
// frame's colour, and the one that shows the new workspace slides its sidebar page in from that side while the colour
// fades from the old tint.

import { atoms, getApi, globalStore } from "@/app/store/global";
import { WorkspaceService } from "@/app/store/services";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { motionMs, prefersReducedMotion } from "../molten-motion";
import { workspaceAtNumber } from "./sidebar-swipe";

export const SwitchIntentKey = "moltenterm:sidebar-switch";
// The new workspace's tab view may take a moment to load; an older record belongs to a switch that went elsewhere.
export const SwitchIntentMaxAgeMs = 2500;

export type SwitchIntent = { workspaceId: string; direction: -1 | 1; from: string; at: number };

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

export function parseSwitchIntent(raw: string): SwitchIntent {
    if (!raw) {
        return null;
    }
    try {
        const v = JSON.parse(raw);
        if (typeof v?.workspaceId !== "string" || typeof v?.at !== "number") {
            return null;
        }
        return {
            workspaceId: v.workspaceId,
            direction: v.direction === -1 ? -1 : 1,
            from: typeof v.from === "string" ? v.from : "",
            at: v.at,
        };
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

// When the last switch from the sidebar was asked, for the swipe's momentum lock (0 if none).
export function lastSwitchAt(): number {
    return parseSwitchIntent(readStorage(SwitchIntentKey))?.at ?? 0;
}

// The sidebar's frame: the window around the sidebar and the panels, tinted by the workspace (workspace.tsx).
function frameElement(): HTMLElement {
    return document.querySelector<HTMLElement>(".mt-sb-frame");
}

export function switchFromSidebar(workspaceId: string, direction: -1 | 1) {
    if (!workspaceId || workspaceId === globalStore.get(atoms.workspace)?.oid) {
        return;
    }
    const frame = frameElement();
    const from = frame ? getComputedStyle(frame).backgroundColor : "";
    writeStorage(SwitchIntentKey, JSON.stringify({ workspaceId, direction, from, at: Date.now() }));
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
    // The swipe lock still reads the time: keep it, mark the slide played.
    writeStorage(SwitchIntentKey, JSON.stringify({ ...intent, workspaceId: "" }));
    return intent;
}

export function playArrival(intent: SwitchIntent, page: HTMLElement, frame: HTMLElement) {
    const reduced = prefersReducedMotion();
    const duration = motionMs();
    const easing = "cubic-bezier(0.2, 0, 0, 1)";
    if (page?.animate) {
        const frames = reduced
            ? [{ opacity: 0 }, { opacity: 1 }]
            : [
                  { transform: `translateX(${intent.direction * 100}%)`, opacity: 0.2 },
                  { transform: "translateX(0)", opacity: 1 },
              ];
        page.animate(frames, { duration, easing });
    }
    if (frame?.animate && intent.from) {
        const to = getComputedStyle(frame).backgroundColor;
        if (to && to !== intent.from) {
            frame.animate([{ backgroundColor: intent.from }, { backgroundColor: to }], { duration, easing });
        }
    }
}

// Plays the slide in the tab view that shows the workspace a sidebar switch went to, once it is on screen.
export function useSwitchArrival(pageRef: React.RefObject<HTMLElement>) {
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
        };
        check();
        document.addEventListener("visibilitychange", check);
        return () => document.removeEventListener("visibilitychange", check);
    }, [wsId, pageRef]);
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
