// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

export const ScreenReaderSetting = "moltenterm:terminalscreenreader";

export type AccessibilitySnapshot = { available: boolean; enabled: boolean; revision: number };
export const UnavailableAccessibility: AccessibilitySnapshot = { available: false, enabled: false, revision: -1 };

export function screenReaderEnabled(preference: unknown, native: AccessibilitySnapshot): boolean {
    if (preference === "on") return true;
    if (preference === "off") return false;
    return native.available && native.enabled;
}

export type AccessibilityApi = {
    getAccessibilitySupport: () => AccessibilitySnapshot;
    onAccessibilitySupportChange: (callback: (snapshot: AccessibilitySnapshot) => void) => () => void;
};

// One source per renderer, including periods with no mounted terminals. Subscribe before the
// synchronous read so a newer event can never be overwritten by an older startup snapshot.
export class AccessibilitySource {
    private snapshot = UnavailableAccessibility;
    private listeners = new Set<() => void>();
    private unsubscribe: () => void;
    private disposed = false;

    constructor(api: AccessibilityApi) {
        try {
            this.unsubscribe = api.onAccessibilitySupportChange((snapshot) => this.accept(snapshot));
            this.accept(api.getAccessibilitySupport());
        } catch {
            // Explicit On/Off remains usable when the native bridge is unavailable.
        }
    }

    private accept(snapshot: AccessibilitySnapshot) {
        if (
            this.disposed ||
            !snapshot ||
            !Number.isSafeInteger(snapshot.revision) ||
            snapshot.revision <= this.snapshot.revision ||
            typeof snapshot.available !== "boolean" ||
            typeof snapshot.enabled !== "boolean"
        )
            return;
        this.snapshot = { ...snapshot };
        for (const listener of this.listeners) listener();
    }

    get = (): AccessibilitySnapshot => this.snapshot;
    subscribe = (listener: () => void): (() => void) => {
        if (this.disposed) return () => {};
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    dispose() {
        this.disposed = true;
        this.unsubscribe?.();
        this.listeners.clear();
    }
}

// Only the public live option changes. Never recreate xterm, its buffer or the PTY binding.
export function bindScreenReader(
    terminal: { options: { screenReaderMode?: boolean } },
    read: () => boolean,
    subscribe: (listener: () => void) => () => void
): () => void {
    let disposed = false;
    const update = () => {
        if (!disposed) {
            const value = read();
            if (terminal.options.screenReaderMode !== value) terminal.options.screenReaderMode = value;
        }
    };
    const unsubscribe = subscribe(update);
    update();
    return () => {
        disposed = true;
        unsubscribe();
    };
}
