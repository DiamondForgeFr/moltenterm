// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The interface theme in Electron main (FR-SHELL-121, #1341): nativeTheme.themeSource follows moltenterm:theme, so
// native menus and dialogs, the system's form controls and the pages of the browser panel (prefers-color-scheme)
// match the interface. Dark when unset, as before the light theme; the renderer reads the same setting
// (frontend/moltenterm-shell/app-theme.ts).

import { waveEventSubscribeSingle } from "@/app/store/wps";
import * as electron from "electron";

export type ThemeSource = "dark" | "light" | "system";

// What a window or a tab view paints before its page does: the page's window colour, so opening a view never
// flashes the other theme (surface 0 of tokens.css for light, Wave's dark background otherwise).
const DarkBackground = "#222222";
const LightBackground = "#efeae3";

let themeSource: ThemeSource = "dark";

export function themeSourceOf(settings: Record<string, unknown>): ThemeSource {
    const value = settings?.["moltenterm:theme"];
    if (value === "light" || value === "system") {
        return value;
    }
    return "dark";
}

export function opaqueBackgroundFor(source: ThemeSource, systemDark: boolean): string {
    if (source === "light" || (source === "system" && !systemDark)) {
        return LightBackground;
    }
    return DarkBackground;
}

// Read from nativeTheme when it changes, so painting a window never reaches into electron itself.
let systemDark = true;

export function opaqueBackground(): string {
    return opaqueBackgroundFor(themeSource, systemDark);
}

// The window buttons drawn over the title bar (Linux and Windows): the dark theme's own colour, the main text in light.
export function titleBarSymbolColorFor(background: string, darkSymbol: string): string {
    return background === LightBackground ? "#1f1a15" : darkSymbol;
}

export function titleBarSymbolColor(darkSymbol: string): string {
    return titleBarSymbolColorFor(opaqueBackground(), darkSymbol);
}

// An open window's title bar buttons follow a theme change; macOS draws its own.
function refreshTitleBars() {
    if (process.platform === "darwin") {
        return;
    }
    for (const win of electron.BrowserWindow.getAllWindows()) {
        try {
            if (process.platform === "win32") {
                win.setTitleBarOverlay({ color: opaqueBackground(), symbolColor: titleBarSymbolColor("#c3c8c2") });
            } else {
                win.setTitleBarOverlay({ symbolColor: titleBarSymbolColor("white") });
            }
        } catch (e) {
            console.log("title bar overlay not updated", e);
        }
    }
}

export function noteThemeSetting(settings: Record<string, unknown>) {
    if (settings == null) {
        return;
    }
    const next = themeSourceOf(settings);
    if (next === themeSource && electron.nativeTheme.themeSource === next) {
        return;
    }
    themeSource = next;
    electron.nativeTheme.themeSource = next;
    systemDark = electron.nativeTheme.shouldUseDarkColors;
    refreshTitleBars();
}

// Before any window: dark, until the settings are read. With Same as the system, a change of the system's setting
// reaches the title bars too.
export function initMoltentermThemeDefault() {
    electron.nativeTheme.themeSource = themeSource;
    systemDark = electron.nativeTheme.shouldUseDarkColors;
    electron.nativeTheme.on("updated", () => {
        systemDark = electron.nativeTheme.shouldUseDarkColors;
        refreshTitleBars();
    });
}

// After wshrpc is up: the first settings, then every config event.
export function initMoltentermTheme(fullConfig: FullConfigType) {
    noteThemeSetting(fullConfig?.settings as Record<string, unknown>);
    waveEventSubscribeSingle({
        eventType: "config",
        handler: (event) => {
            const settings = (event?.data as { fullconfig?: FullConfigType })?.fullconfig?.settings;
            noteThemeSetting(settings as Record<string, unknown>);
        },
    });
}
