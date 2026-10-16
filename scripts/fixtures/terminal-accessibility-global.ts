// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { atom } from "jotai";
import { globalStore } from "../../frontend/app/store/jotaiStore";
import type { AccessibilitySnapshot } from "../../frontend/moltenterm-shell/terminal-accessibility/screen-reader";
export { globalStore };
export const preferenceAtom = atom("auto");
let native: AccessibilitySnapshot = { available: true, enabled: true, revision: 0 };
const listeners = new Set<(value: AccessibilitySnapshot) => void>();
export let subscriptions = 0;
export const getSettingsKeyAtom = () => preferenceAtom;
export const getApi = () => ({
    getAccessibilitySupport: () => native,
    onAccessibilitySupportChange: (listener: (value: AccessibilitySnapshot) => void) => {
        subscriptions++;
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
});
export function setNative(enabled: boolean) {
    native = { available: true, enabled, revision: native.revision + 1 };
    for (const listener of listeners) listener(native);
}
