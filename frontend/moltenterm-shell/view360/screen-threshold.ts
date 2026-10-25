// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The 360 view's column threshold per screen (FR-SHELL-066, #1083): "360 view beyond N columns", remembered for each
// screen the window has been on (keyed by the display's size and scale factor, emain/moltenterm-screen.ts). A screen
// nobody chose for takes a default from its width, without asking. Pure, so the rules are tested alone.

export const ScreenThresholdsMetaKey = "molten:view360screens";

// The defaults (tunable): a laptop-sized screen fits 2 comfortable columns, a large or wide one 3.
export const LaptopColumns = 2;
export const WideColumns = 3;
// Width in screen points from which a screen counts as large or wide (a 27" at 2560, a 34" at 3440; a laptop is
// 1280 to 1800, a 4K screen scaled to 1920 counts as a laptop's room).
export const WideScreenMinPx = 2200;
// What the 360 button's menu and Settings offer.
export const ThresholdChoices = [2, 3, 4];
const MinThreshold = 1;
const MaxThreshold = 8;

// must match ScreenInfo in emain/moltenterm-screen.ts
export type ScreenInfo = { key: string; widthpx: number; heightpx: number; scalefactor: number };

export type StoredScreen = { columns: number; widthpx?: number; heightpx?: number; scalefactor?: number };

export type ScreenThresholds = Record<string, StoredScreen>;

export function defaultColumnThreshold(widthPx: number): number {
    return widthPx >= WideScreenMinPx ? WideColumns : LaptopColumns;
}

function validColumns(raw: unknown): number {
    if (typeof raw !== "number" || !Number.isInteger(raw)) {
        return null;
    }
    return raw >= MinThreshold && raw <= MaxThreshold ? raw : null;
}

function validPx(raw: unknown): number {
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

// The stored thresholds, keeping only well-formed entries: the meta is written by older and newer versions alike.
export function readScreenThresholds(raw: unknown): ScreenThresholds {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
        return {};
    }
    const rtn: ScreenThresholds = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!key || value == null || typeof value !== "object") {
            continue;
        }
        const entry = value as StoredScreen;
        const columns = validColumns(entry.columns);
        if (columns == null) {
            continue;
        }
        const stored: StoredScreen = { columns };
        const width = validPx(entry.widthpx);
        const height = validPx(entry.heightpx);
        const scale = validPx(entry.scalefactor);
        if (width != null) stored.widthpx = width;
        if (height != null) stored.heightpx = height;
        if (scale != null) stored.scalefactor = scale;
        rtn[key] = stored;
    }
    return rtn;
}

// The key's own size and scale ("1512x982@2"), for an entry stored without them.
export function parseScreenKey(key: string): { widthpx: number; heightpx: number; scalefactor: number } {
    const match = /^(\d+)x(\d+)@([\d.]+)$/.exec(key ?? "");
    if (match == null) {
        return null;
    }
    return { widthpx: Number(match[1]), heightpx: Number(match[2]), scalefactor: Number(match[3]) };
}

// This screen's threshold: the remembered one, else the default for its width. Without a screen (an old main
// process, a preview), the laptop default.
export function thresholdFor(stored: ScreenThresholds, screen: ScreenInfo): number {
    if (screen == null) {
        return LaptopColumns;
    }
    return stored?.[screen.key]?.columns ?? defaultColumnThreshold(screen.widthpx);
}

export function withThreshold(stored: ScreenThresholds, screen: ScreenInfo, columns: number): ScreenThresholds {
    const valid = validColumns(columns);
    if (screen?.key == null || valid == null) {
        return stored ?? {};
    }
    return {
        ...(stored ?? {}),
        [screen.key]: {
            columns: valid,
            widthpx: screen.widthpx,
            heightpx: screen.heightpx,
            scalefactor: screen.scalefactor,
        },
    };
}

export function withoutScreen(stored: ScreenThresholds, key: string): ScreenThresholds {
    if (stored?.[key] == null) {
        return stored ?? {};
    }
    const rtn = { ...stored };
    delete rtn[key];
    return rtn;
}

export type ScreenRow = {
    key: string;
    widthpx: number;
    heightpx: number;
    scalefactor: number;
    columns: number;
    current: boolean;
    // No choice remembered: the default for its width.
    isDefault: boolean;
};

// What Settings lists: the remembered screens, and the current one even when nothing was chosen for it, the current
// screen first, then the widest.
export function screenRows(stored: ScreenThresholds, current: ScreenInfo): ScreenRow[] {
    const rows: ScreenRow[] = Object.entries(stored ?? {}).map(([key, entry]) => {
        const parsed = parseScreenKey(key);
        return {
            key,
            widthpx: entry.widthpx ?? parsed?.widthpx ?? 0,
            heightpx: entry.heightpx ?? parsed?.heightpx ?? 0,
            scalefactor: entry.scalefactor ?? parsed?.scalefactor ?? 1,
            columns: entry.columns,
            current: current?.key === key,
            isDefault: false,
        };
    });
    if (current?.key != null && stored?.[current.key] == null) {
        rows.push({
            key: current.key,
            widthpx: current.widthpx,
            heightpx: current.heightpx,
            scalefactor: current.scalefactor,
            columns: defaultColumnThreshold(current.widthpx),
            current: true,
            isDefault: true,
        });
    }
    return rows.sort((a, b) => Number(b.current) - Number(a.current) || b.widthpx - a.widthpx);
}
