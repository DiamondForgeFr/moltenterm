// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Which panel's command panel is open and where it is anchored (FR-SHELL-047): under the header trigger, at the
// pointer for a right-click, or under the trigger of the focused panel for Cmd+. One panel at a time.

import { getFocusedBlockId, globalStore, refocusNode } from "@/app/store/global";
import { atom, PrimitiveAtom } from "jotai";

export type PanelAnchor =
    | { kind: "rect"; left: number; top: number; right: number; bottom: number }
    | { kind: "point"; x: number; y: number };

export type CommandPanelSource = "trigger" | "key" | "header" | "menu" | "palette";

export type OpenCommandPanel = {
    blockId: string;
    anchor: PanelAnchor;
    source: CommandPanelSource;
    token: number;
    // A search to start with (the palette opens the panel on one of its options).
    query?: string;
};

// The performance marks of NFR-SHELL-028 (the panel painted under 50 ms after its trigger).
export const OpenMark = "mt-command-panel-open";
export const PaintedMeasure = "mt-command-panel-painted";
export const TriggerSelector = '[data-role="command-panel-trigger"]';

function rectAnchor(el: Element): PanelAnchor {
    const r = el.getBoundingClientRect();
    return { kind: "rect", left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

// The anchor of a panel opened from the keyboard or the palette: its header trigger, else its header, else the
// panel's top right corner.
export function defaultAnchor(blockId: string): PanelAnchor {
    const block = document.querySelector(`[data-blockid="${CSS.escape(blockId)}"]`);
    const trigger = block?.querySelector(TriggerSelector);
    if (trigger != null) {
        return rectAnchor(trigger);
    }
    const header = block?.querySelector('[data-role="block-header"]');
    if (header != null) {
        const r = header.getBoundingClientRect();
        return { kind: "rect", left: r.right - 8, top: r.top, right: r.right - 8, bottom: r.bottom };
    }
    if (block != null) {
        const r = block.getBoundingClientRect();
        return { kind: "rect", left: r.right - 8, top: r.top, right: r.right - 8, bottom: r.top + 8 };
    }
    return { kind: "point", x: window.innerWidth / 2 - 180, y: 80 };
}

export class CommandPanelModel {
    private static instance: CommandPanelModel = null;

    openAtom = atom(null) as PrimitiveAtom<OpenCommandPanel>;
    token = 0;

    private constructor() {}

    static getInstance(): CommandPanelModel {
        if (!CommandPanelModel.instance) {
            CommandPanelModel.instance = new CommandPanelModel();
        }
        return CommandPanelModel.instance;
    }

    current(): OpenCommandPanel {
        return globalStore.get(this.openAtom);
    }

    open(blockId: string, anchor: PanelAnchor, source: CommandPanelSource, query?: string) {
        if (!blockId) {
            return;
        }
        try {
            performance.clearMarks(OpenMark);
            performance.mark(OpenMark);
        } catch {
            /* marks are diagnostics only */
        }
        this.token++;
        globalStore.set(this.openAtom, {
            blockId,
            anchor: anchor ?? defaultAnchor(blockId),
            source,
            token: this.token,
            query,
        });
    }

    // refocus: give the focus back to the panel it was opened from (Escape, a click outside, an action that runs in
    // that panel); false when what runs next moves the focus itself (a split, a new panel).
    close(refocus = true) {
        const current = this.current();
        if (current == null) {
            return;
        }
        globalStore.set(this.openAtom, null);
        if (refocus) {
            refocusNode(current.blockId);
        }
    }

    toggle(blockId: string, anchor: PanelAnchor, source: CommandPanelSource) {
        if (this.current()?.blockId === blockId) {
            this.close();
            return;
        }
        this.open(blockId, anchor, source);
    }
}

export function openCommandPanelFromTrigger(blockId: string, trigger: Element) {
    CommandPanelModel.getInstance().toggle(blockId, trigger ? rectAnchor(trigger) : null, "trigger");
}

export function openCommandPanelAtPoint(blockId: string, x: number, y: number, source: CommandPanelSource = "header") {
    CommandPanelModel.getInstance().open(blockId, { kind: "point", x, y }, source);
}

export function openCommandPanel(blockId: string, source: CommandPanelSource = "menu", query?: string) {
    CommandPanelModel.getInstance().open(blockId, defaultAnchor(blockId), source, query);
}

// Cmd+. on the focused panel; pressed again, it closes the panel.
export function toggleFocusedCommandPanel(): boolean {
    const model = CommandPanelModel.getInstance();
    if (model.current() != null) {
        model.close();
        return true;
    }
    const blockId = getFocusedBlockId();
    if (!blockId) {
        return false;
    }
    model.open(blockId, defaultAnchor(blockId), "key");
    return true;
}
