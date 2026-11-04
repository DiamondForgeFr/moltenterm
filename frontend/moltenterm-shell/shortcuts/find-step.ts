// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Find next and previous from the keyboard (#1759, FR-SHELL-139 AC10). Each panel's find bar (a terminal's, a web page's)
// knows how to step its own matches; the bar registers them under its isOpen atom, which is also the panel's
// viewModel.searchAtoms.isOpen, so the window's ⌘G reaches the bar of the focused panel without knowing the view.

export type FindSteps = { next: () => void; prev: () => void };

// A ref, so that the bar can keep the latest callbacks in it while it renders.
type FindStepsRef = { current: FindSteps };

const Registered = new WeakMap<object, FindStepsRef>();

// Returns the cleanup that forgets the bar when it unmounts.
export function registerFindSteps(key: object, steps: FindStepsRef): () => void {
    Registered.set(key, steps);
    return () => {
        if (Registered.get(key) === steps) {
            Registered.delete(key);
        }
    };
}

// false when the bar is closed or unknown, so that ⌘G keeps its other meaning.
export function stepFind(key: object, isOpen: boolean, direction: 1 | -1): boolean {
    if (key == null || !isOpen) {
        return false;
    }
    const steps = Registered.get(key)?.current;
    if (steps == null) {
        return false;
    }
    if (direction > 0) {
        steps.next();
    } else {
        steps.prev();
    }
    return true;
}
