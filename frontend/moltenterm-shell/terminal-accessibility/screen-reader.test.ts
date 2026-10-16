// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { AccessibilitySnapshot, AccessibilitySource, bindScreenReader, screenReaderEnabled } from "./screen-reader";

describe("terminal screen reader preference", () => {
    it("follows detection only in automatic mode, with explicit overrides even when unavailable", () => {
        for (const available of [false, true])
            for (const enabled of [false, true]) {
                const snapshot = { available, enabled, revision: 1 };
                expect(screenReaderEnabled("on", snapshot)).toBe(true);
                expect(screenReaderEnabled("off", snapshot)).toBe(false);
                for (const preference of ["auto", undefined, null, "invalid"]) {
                    expect(screenReaderEnabled(preference, snapshot)).toBe(available && enabled);
                }
            }
    });

    it("subscribes before the snapshot and rejects stale events, including a late initial read", () => {
        let deliver: (snapshot: AccessibilitySnapshot) => void;
        const stop = vi.fn();
        const source = new AccessibilitySource({
            onAccessibilitySupportChange: (listener) => {
                deliver = listener;
                listener({ available: true, enabled: true, revision: 2 });
                return stop;
            },
            getAccessibilitySupport: () => ({ available: true, enabled: false, revision: 1 }),
        });
        expect(source.get().enabled).toBe(true);
        const observer = vi.fn();
        const unsubscribe = source.subscribe(observer);
        deliver({ available: true, enabled: false, revision: 1 });
        deliver({ available: true, enabled: false, revision: 2 });
        expect(observer).not.toHaveBeenCalled();
        deliver({ available: true, enabled: false, revision: 3 });
        expect(observer).toHaveBeenCalledOnce();
        unsubscribe();
        deliver({ available: true, enabled: true, revision: 4 });
        expect(source.get().enabled).toBe(true); // Cache remains fresh between terminal mounts.
        source.dispose();
        deliver({ available: true, enabled: false, revision: 5 });
        expect(source.get().enabled).toBe(true);
        expect(stop).toHaveBeenCalledOnce();
    });

    it("keeps explicit On usable when the bridge throws", () => {
        const source = new AccessibilitySource({
            onAccessibilitySupportChange: () => {
                throw new Error("unavailable");
            },
            getAccessibilitySupport: () => {
                throw new Error("unavailable");
            },
        });
        expect(screenReaderEnabled("auto", source.get())).toBe(false);
        expect(screenReaderEnabled("on", source.get())).toBe(true);
        source.dispose();
    });

    it("updates the existing option, avoids duplicate writes and ignores queued work after disposal", () => {
        let value = false;
        let option = false;
        const setOption = vi.fn((next: boolean) => {
            option = next;
        });
        const terminal = {
            options: {
                get screenReaderMode() {
                    return option;
                },
                set screenReaderMode(next) {
                    setOption(next);
                },
            },
        };
        let update: () => void;
        const unsubscribe = vi.fn();
        const dispose = bindScreenReader(
            terminal,
            () => value,
            (listener) => {
                update = listener;
                return unsubscribe;
            }
        );
        expect(setOption).not.toHaveBeenCalled();
        value = true;
        update();
        update();
        expect(setOption).toHaveBeenCalledExactlyOnceWith(true);
        dispose();
        value = false;
        update();
        expect(option).toBe(true);
        expect(unsubscribe).toHaveBeenCalledOnce();
    });
});
