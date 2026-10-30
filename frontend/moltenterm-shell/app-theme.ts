// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The interface's theme (theme "Coulée" step 8, FR-SHELL-121, #1341): Preferences › Appearance › Theme is Dark (the
// default, also when unset or unknown), Light, or Same as the system. Light puts .mt-light on the root, which holds
// the light token values (tokens.css), and the suite kit's .df-light. Electron main sets nativeTheme.themeSource from
// the same setting (emain/moltenterm-theme.ts), so native menus and the pages of the browser panel follow it too.

import { globalStore } from "@/app/store/jotaiStore";
import { Atom, atom, PrimitiveAtom } from "jotai";

export const ThemeSettingKey = "moltenterm:theme";

export type ThemeSetting = "dark" | "light" | "system";
export type AppTheme = "dark" | "light";

export const LightThemeClass = "mt-light";
export const SuiteLightClass = "df-light";

const SystemDarkQuery = "(prefers-color-scheme: dark)";

export function themeSetting(value: unknown): ThemeSetting {
    if (value === "light" || value === "system") {
        return value;
    }
    return "dark";
}

export function resolveAppTheme(value: unknown, systemDark: boolean): AppTheme {
    const setting = themeSetting(value);
    if (setting === "system") {
        return systemDark ? "dark" : "light";
    }
    return setting;
}

export function applyAppTheme(root: HTMLElement, theme: AppTheme): void {
    const light = theme === "light";
    root.classList.toggle(LightThemeClass, light);
    root.classList.toggle(SuiteLightClass, light);
    root.dataset.mtTheme = theme;
}

// The theme in force, for code that cannot read CSS, such as the code editor's theme.
export const appThemeAtom = atom<AppTheme>("dark") as PrimitiveAtom<AppTheme>;

let started = false;

// Before the first render, so a light window never paints dark first; then live, with no restart (AC-1). With Same
// as the system, the media query follows nativeTheme.themeSource = "system", which tracks the system's setting.
export function startAppTheme(settingsAtom: Atom<SettingsType>): void {
    if (started) {
        return;
    }
    started = true;
    const media = typeof window.matchMedia === "function" ? window.matchMedia(SystemDarkQuery) : null;
    const apply = () => {
        const theme = resolveAppTheme(globalStore.get(settingsAtom)?.[ThemeSettingKey], media?.matches ?? true);
        applyAppTheme(document.documentElement, theme);
        if (globalStore.get(appThemeAtom) !== theme) {
            globalStore.set(appThemeAtom, theme);
        }
    };
    apply();
    globalStore.sub(settingsAtom, apply);
    media?.addEventListener("change", apply);
}
