// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ windows: [] as any[], updated: null as (() => void) | null }));
const nativeTheme = vi.hoisted(() => ({
    themeSource: "system",
    shouldUseDarkColors: true,
    on: (_: string, cb: () => void) => {
        state.updated = cb;
    },
}));
vi.mock("electron", () => ({ nativeTheme, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock("./emain-window", () => ({ getAllWaveWindows: () => state.windows }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => {} }));

import {
    initMoltentermThemeDefault,
    noteThemeSetting,
    opaqueBackgroundFor,
    themeSourceOf,
    titleBarSymbolColorFor,
} from "./moltenterm-theme";

// FR-SHELL-121: nativeTheme.themeSource follows moltenterm:theme instead of being forced to dark.
describe("theme source (FR-SHELL-121)", () => {
    it("starts dark before the settings are read, as before the light theme", () => {
        initMoltentermThemeDefault();
        expect(nativeTheme.themeSource).toBe("dark");
    });

    it.each([
        [{}, "dark"],
        [{ "moltenterm:theme": "dark" }, "dark"],
        [{ "moltenterm:theme": "light" }, "light"],
        [{ "moltenterm:theme": "system" }, "system"],
        [{ "moltenterm:theme": "sepia" }, "dark"],
    ])("maps %j to %s", (settings, source) => {
        expect(themeSourceOf(settings)).toBe(source);
    });

    it("sets nativeTheme.themeSource live on each settings change", () => {
        noteThemeSetting({ "moltenterm:theme": "light" });
        expect(nativeTheme.themeSource).toBe("light");
        noteThemeSetting({ "moltenterm:theme": "system" });
        expect(nativeTheme.themeSource).toBe("system");
        noteThemeSetting({});
        expect(nativeTheme.themeSource).toBe("dark");
    });

    it("paints a window before its page in the theme's window colour", () => {
        expect(opaqueBackgroundFor("dark", false)).toBe("#222222");
        expect(opaqueBackgroundFor("light", true)).toBe("#efeae3");
        expect(opaqueBackgroundFor("system", true)).toBe("#222222");
        expect(opaqueBackgroundFor("system", false)).toBe("#efeae3");
    });

    it("draws the title bar buttons dark on the light background only", () => {
        expect(titleBarSymbolColorFor("#222222", "white")).toBe("white");
        expect(titleBarSymbolColorFor("#efeae3", "white")).toBe("#1f1a15");
    });

    it.each(["win32", "linux"])("refreshes eligible BaseWindows on %s for settings and system changes", (platform) => {
        vi.stubGlobal("process", { ...process, platform });
        const overlay = vi.fn();
        const native = vi.fn();
        state.windows = [
            { hasTitleBarOverlay: true, isDestroyed: () => false, setTitleBarOverlay: overlay },
            { hasTitleBarOverlay: false, isDestroyed: () => false, setTitleBarOverlay: native },
        ];
        initMoltentermThemeDefault();
        noteThemeSetting({ "moltenterm:theme": "system" });
        overlay.mockClear();
        nativeTheme.shouldUseDarkColors = false;
        state.updated();
        expect(overlay).toHaveBeenCalledWith(
            platform === "win32" ? { color: "#efeae3", symbolColor: "#1f1a15" } : { symbolColor: "#1f1a15" }
        );
        noteThemeSetting({ "moltenterm:theme": "dark" });
        expect(overlay).toHaveBeenCalledTimes(2);
        expect(native).not.toHaveBeenCalled();
        state.windows = [];
        vi.unstubAllGlobals();
    });

    it("leaves macOS titlebars alone", () => {
        vi.stubGlobal("process", { ...process, platform: "darwin" });
        const overlay = vi.fn();
        state.windows = [{ hasTitleBarOverlay: true, isDestroyed: () => false, setTitleBarOverlay: overlay }];
        noteThemeSetting({ "moltenterm:theme": "light" });
        expect(overlay).not.toHaveBeenCalled();
        state.windows = [];
        vi.unstubAllGlobals();
    });
});
