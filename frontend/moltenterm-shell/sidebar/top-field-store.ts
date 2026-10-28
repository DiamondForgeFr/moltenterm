// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Whether the sidebar's top field is open (FR-SHELL-083, #1187), and its key: ⌘L opens it wherever the focus is while
// the sidebar is on; a hidden sidebar peeks in for it and stays while the field is open. A focused page keeps ⌘L for
// its address bar, and ⌘K stays the terminal's clear (#1219). With the sidebar off ⌘L is the page's address bar only.

import { globalStore } from "@/app/store/jotaiStore";
import * as jotai from "jotai";
import { modalIsOpen } from "../modal-open";
import { findShortcut } from "../shortcuts/registry";
import { SidebarModel } from "./sidebar-store";

export const TopFieldShortcutId = "top-field";

export class TopFieldModel {
    private static instance: TopFieldModel = null;

    openAtom = jotai.atom(false) as jotai.PrimitiveAtom<boolean>;
    // Bumped on each open, so a second ⌘L while open selects the text again.
    openCountAtom = jotai.atom(0) as jotai.PrimitiveAtom<number>;

    private constructor() {}

    static getInstance(): TopFieldModel {
        if (TopFieldModel.instance == null) {
            TopFieldModel.instance = new TopFieldModel();
        }
        return TopFieldModel.instance;
    }

    isOpen(): boolean {
        return globalStore.get(this.openAtom);
    }

    open(): boolean {
        const sidebar = SidebarModel.getInstance();
        if (!sidebar.isEnabled()) {
            return false;
        }
        if (sidebar.isHidden()) {
            sidebar.setPeek(true);
        }
        globalStore.set(this.openCountAtom, globalStore.get(this.openCountAtom) + 1);
        globalStore.set(this.openAtom, true);
        return true;
    }

    close(): void {
        globalStore.set(this.openAtom, false);
    }
}

export function openTopField(): boolean {
    return TopFieldModel.getInstance().open();
}

function openFromKey(): boolean {
    if (modalIsOpen()) {
        return false;
    }
    return openTopField();
}

export function registerTopFieldKeys(keyMap: Map<string, (e: WaveKeyboardEvent) => boolean>) {
    const shortcut = findShortcut(TopFieldShortcutId);
    if (shortcut == null) {
        return;
    }
    for (const keys of [shortcut.keys, ...(shortcut.alt ?? [])]) {
        keyMap.set(keys, () => openFromKey());
    }
}
