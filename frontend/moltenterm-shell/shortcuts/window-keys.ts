// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The window keys that follow the browser's reflexes beyond ⌘ (#1759, FR-SHELL-139 AC8 to AC10): off macOS the browsers'
// Ctrl+T, Ctrl+N, Ctrl+W, Ctrl+Shift+W and Ctrl+L beside the Alt keys, F6, the previous and next panel, and find
// next and previous. The keys come from the shortcut registry, per platform; a registry entry marked
// outsideTerminalOrEditor is bound only while the keyboard focus is not in a terminal or a code editor, where Ctrl
// chords belong to the program or the editor (Ctrl+W deletes a word in a shell, Ctrl+L expands the selection and Ctrl+G
// goes to a line in Monaco).

import { platformShortcuts } from "./registry";

export const TerminalViewType = "term";

// Monaco's root element: the file editor, the configuration editors and the diff editors all hold their focus inside it.
export const EditorSelector = ".monaco-editor";

type KeyHandler = (e: WaveKeyboardEvent) => boolean;

export type WindowKeyActions = {
    newPanel: () => void;
    newView: () => void;
    closePanel: () => void;
    closeView: () => void;
    topField: () => boolean;
    // true when a find bar was open in the focused panel and stepped.
    findStep: (direction: 1 | -1) => boolean;
    // false when there is nowhere to go (one panel), so that the program keeps the key.
    stepPanel: (direction: 1 | -1) => boolean;
    inTerminalOrEditor: () => boolean;
};

// Where the keyboard focus is when a key is pressed.
export type KeyFocusFacts = {
    // The panel a key counts as pressed in: the one holding the page a key was sent back from.
    originBlockId?: string;
    inSidebar: boolean;
    // The DOM focus is inside a code editor (Monaco), whatever panel holds it.
    inEditor?: boolean;
    // The panel holding the DOM focus. The find bar and other floating fields sit outside every panel.
    domBlockId?: string;
};

// The layout's focused panel is not read: with nothing in a panel holding the DOM focus (the sidebar, the find bar's
// field, the page background) the keys go nowhere in a program, so the browser's meaning is safe to give them.
export function focusInTerminalOrEditor(facts: KeyFocusFacts, viewOf: (blockId: string) => string): boolean {
    if (facts.originBlockId) {
        return viewOf(facts.originBlockId) === TerminalViewType;
    }
    if (facts.inSidebar) {
        return false;
    }
    if (facts.inEditor) {
        return true;
    }
    if (!facts.domBlockId) {
        return false;
    }
    return viewOf(facts.domBlockId) === TerminalViewType;
}

// The panel after (direction 1) or before (-1) the current one in the panels' order, wrapping at the ends. A single
// panel has nowhere to go: null, so that the program keeps the key. With no current panel the first (or the last, going
// back) is reached.
export function stepPanelId(nodeIds: string[], currentId: string, direction: 1 | -1): string {
    if (nodeIds == null || nodeIds.length < 2) {
        return null;
    }
    const at = currentId == null ? -1 : nodeIds.indexOf(currentId);
    if (at === -1) {
        return direction > 0 ? nodeIds[0] : nodeIds[nodeIds.length - 1];
    }
    return nodeIds[(at + direction + nodeIds.length) % nodeIds.length];
}

function ran(run: () => void): () => boolean {
    return () => {
        run();
        return true;
    };
}

// What each registry entry does; an id missing here is bound elsewhere (⌘G is keymodel.ts's, with the connection).
function runnerOf(id: string, a: WindowKeyActions): () => boolean {
    switch (id) {
        case "new-panel-ctrl":
            return ran(a.newPanel);
        case "new-tab-ctrl":
            return ran(a.newView);
        case "close-panel-ctrl":
            return ran(a.closePanel);
        case "close-tab-ctrl":
            return ran(a.closeView);
        case "top-field-ctrl":
        case "top-field-f6":
            return a.topField;
        case "find-next-ctrl":
            return () => a.findStep(1);
        case "find-previous":
        case "find-previous-ctrl":
            return () => a.findStep(-1);
        case "previous-panel":
        case "previous-panel-other":
            return () => a.stepPanel(-1);
        case "next-panel":
        case "next-panel-other":
            return () => a.stepPanel(1);
        default:
            return null;
    }
}

// The key map of one platform: each key of the registry entries that apply there, to what it does. A handler that
// returns false lets the key reach the program (the guard, a find bar that is closed, a single panel).
export function windowKeyBindings(mac: boolean, actions: WindowKeyActions): Map<string, KeyHandler> {
    const rtn = new Map<string, KeyHandler>();
    for (const s of platformShortcuts(mac)) {
        const run = runnerOf(s.id, actions);
        if (run == null) {
            continue;
        }
        const handler: KeyHandler = s.outsideTerminalOrEditor
            ? () => (actions.inTerminalOrEditor() ? false : run())
            : () => run();
        for (const keys of [s.keys, ...(s.alt ?? [])]) {
            rtn.set(keys, handler);
        }
    }
    return rtn;
}

export function registerWindowKeys(keyMap: Map<string, KeyHandler>, mac: boolean, actions: WindowKeyActions): void {
    for (const [keys, handler] of windowKeyBindings(mac, actions)) {
        keyMap.set(keys, handler);
    }
}
