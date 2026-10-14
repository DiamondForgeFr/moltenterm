// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { makeMoltenApi, MoltenApiBackend } from "./molten-api";

function fakeBackend(locale: { value: string }) {
    const handlers = new Set<(l: string) => void>();
    let stopped = false;
    const backend: MoltenApiBackend & { emit(l: string): void; stop(): void } = {
        isStopped: () => stopped,
        track: (dispose) => dispose,
        fail: vi.fn(),
        registerCommand: () => () => {},
        showNotification: () => () => {},
        showBox: () => () => {},
        writeClipboard: async () => {},
        getLocale: () => locale.value,
        onLocaleChange: (handler) => {
            handlers.add(handler);
            return () => handlers.delete(handler);
        },
        emit: (l) => {
            locale.value = l;
            handlers.forEach((h) => h(l));
        },
        stop: () => {
            stopped = true;
        },
    };
    return backend;
}

const manifest = { id: "m", name: "M", version: "1.0.0", main: "main.js", apiVersion: 1 } as any;

describe("MoltenApi locale (FR-I18N-001, DS-I18N-005)", () => {
    it("reads the interface language live and calls the change handler until disposed", () => {
        const locale = { value: "fr" };
        const backend = fakeBackend(locale);
        const api = makeMoltenApi(manifest, backend);
        expect(api.locale).toBe("fr");
        const seen: string[] = [];
        const dispose = api.onLocaleChange((l) => seen.push(l));
        backend.emit("en");
        expect(api.locale).toBe("en");
        dispose();
        backend.emit("fr");
        expect(seen).toEqual(["en"]);
    });

    it("stops the mod when its handler throws, and calls no handler once stopped", () => {
        const backend = fakeBackend({ value: "en" });
        const api = makeMoltenApi(manifest, backend);
        const handler = vi.fn(() => {
            throw new Error("boom");
        });
        api.onLocaleChange(handler);
        backend.emit("fr");
        expect(backend.fail).toHaveBeenCalledTimes(1);
        backend.stop();
        backend.emit("en");
        expect(handler).toHaveBeenCalledTimes(1);
        expect(() => api.onLocaleChange(() => {})).toThrow(/stopped/);
    });
});
