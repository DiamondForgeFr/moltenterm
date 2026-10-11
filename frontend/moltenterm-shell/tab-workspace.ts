// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { atom, Atom, PrimitiveAtom } from "jotai";

// A tab view renders one tab, and a tab belongs to one workspace for its whole life. Wave derived the view's workspace
// from the window's current one, which was the same thing as long as a window destroyed the views of the workspace it
// left. Since #68 keeps those views alive off-screen, a hidden view following the window read a workspace it had never
// loaded (null for a frame) whenever another workspace was created, and threw during render (FR-PERF-001).
const TabWorkspaceIdAtom = atom<string>(null) as PrimitiveAtom<string>;

let windowWorkspaceIdAtom: Atom<string> = null;

export function makeTabWorkspaceIdAtom(windowWorkspaceId: Atom<string>): Atom<string> {
    windowWorkspaceIdAtom = windowWorkspaceId;
    return atom((get) => get(TabWorkspaceIdAtom) ?? get(windowWorkspaceId));
}

// Called once the view is initialised for its tab: the window is on the tab's workspace at that moment, because the
// window switches the backend before it initialises the view it shows.
export function pinTabWorkspace(workspaceId: string) {
    if (!workspaceId) {
        return;
    }
    globalStore.set(TabWorkspaceIdAtom, workspaceId);
}

// For what must close when the window leaves this view's workspace (menus, the command panel).
export function subscribeWindowWorkspaceChange(onChange: () => void): () => void {
    if (windowWorkspaceIdAtom == null) {
        return () => {};
    }
    return globalStore.sub(windowWorkspaceIdAtom, onChange);
}
