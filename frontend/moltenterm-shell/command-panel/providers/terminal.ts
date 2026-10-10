// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Terminal section (DS-SHELL-086, DS-SHELL-090): term-model's settings menu rewritten as native options. Theme,
// Font size, Cursor and Transparency carry This panel and All terminals scopes with a reset; the actions (Save session
// as…, file browser, force restart) run Wave's own items, found by label, so their behaviour stays Wave's; Bracketed
// paste, Debug connection and Force restart go to Developer. Session durability is in the MoltenTerm section
// (molten.ts, DS-SHELL-089).

import { atoms, globalStore } from "@/app/store/global";
import { DefaultTermTheme } from "@/app/view/term/termutil";
import { menuLabel } from "../../menu/menu-model";
import { compositeBinding, metaBinding, settingsBinding } from "../bindings";
import { CommandProvider, PanelChoiceOption, PanelContext, PanelItem, PanelSection } from "../panel-types";
import { adaptMenuItems } from "../wave-adapter";

export const TerminalFontSizeDefault = 12;
export const TerminalTransparencyDefault = 0.5;

const CursorOptions: { value: string; label: string }[] = [
    { value: "block:false", label: "Block" },
    { value: "block:true", label: "Block, blinking" },
    { value: "bar:false", label: "Bar" },
    { value: "bar:true", label: "Bar, blinking" },
    { value: "underline:false", label: "Underline" },
    { value: "underline:true", label: "Underline, blinking" },
];

export function cursorValue(style: unknown, blink: unknown): string {
    const s = style === "bar" || style === "underline" ? style : "block";
    return `${s}:${blink === true}`;
}

function cursorParts(value: string): Record<string, unknown> {
    const [style, blink] = (value ?? "block:false").split(":");
    return { "term:cursor": style, "term:cursorblink": blink === "true" };
}

// The Wave items the terminal's own items run, by label (term-model.ts getSettingsMenuItems).
function findWaveItem(items: ContextMenuItem[], label: string): ContextMenuItem {
    for (const item of items ?? []) {
        if (menuLabel(item) === label) {
            return item;
        }
        const inner = findWaveItem(item.submenu, label);
        if (inner != null) {
            return inner;
        }
    }
    return null;
}

function waveAction(
    items: ContextMenuItem[],
    waveLabel: string,
    item: { id: string; label: string; icon?: string; keywords?: string[]; destructive?: boolean }
): PanelItem {
    const found = findWaveItem(items, waveLabel);
    if (found?.click == null || found.visible === false) {
        return null;
    }
    return { ...item, type: "action", run: () => found.click() };
}

export function themeOptions(themes: Record<string, TermThemeType>): PanelChoiceOption[] {
    return Object.keys(themes ?? {})
        .sort((a, b) => (themes[a]["display:order"] ?? 0) - (themes[b]["display:order"] ?? 0))
        .map((name) => ({
            id: `theme:${name}`,
            label: themes[name]["display:name"] ?? name,
            value: name,
            swatch: [themes[name].background, themes[name].foreground, themes[name].cursor].filter((c) => !!c),
        }));
}

export function terminalSections(ctx: PanelContext): PanelSection[] {
    const blockId = ctx.blockId;
    const waveItems: ContextMenuItem[] = (ctx.viewModel as any)?.getSettingsMenuItems?.() ?? [];
    const fullConfig = globalStore.get(atoms.fullConfigAtom);
    const meta = ctx.meta ?? {};
    const items = (
        [
            {
                id: "term:theme",
                type: "choice",
                label: "Theme",
                icon: "palette",
                keywords: ["colors", "colours", "scheme"],
                options: themeOptions(fullConfig?.termthemes),
                defaultValue: DefaultTermTheme,
                scopes: [
                    metaBinding<string>(blockId, "term:theme"),
                    settingsBinding<string>("term:theme", DefaultTermTheme),
                ],
            },
            {
                id: "term:fontsize",
                type: "number",
                label: "Font size",
                icon: "text-height",
                keywords: ["text size", "zoom"],
                min: 6,
                max: 32,
                step: 1,
                control: "stepper",
                format: (v) => `${v} px`,
                defaultValue: TerminalFontSizeDefault,
                scopes: [
                    metaBinding<number>(blockId, "term:fontsize"),
                    settingsBinding<number>("term:fontsize", TerminalFontSizeDefault),
                ],
            },
            {
                id: "term:cursor",
                type: "choice",
                label: "Cursor",
                icon: "i-cursor",
                keywords: ["caret", "blink"],
                options: CursorOptions.map((o) => ({ id: `cursor:${o.value}`, label: o.label, value: o.value })),
                defaultValue: "block:false",
                scopes: [
                    compositeBinding<string>(
                        "panel",
                        ["term:cursor", "term:cursorblink"],
                        ([style, blink]) => (style == null && blink == null ? undefined : cursorValue(style, blink)),
                        cursorParts,
                        { blockId }
                    ),
                    compositeBinding<string>(
                        "kind",
                        ["term:cursor", "term:cursorblink"],
                        ([style, blink]) => {
                            const v = cursorValue(style, blink);
                            return v === "block:false" ? undefined : v;
                        },
                        cursorParts,
                        {}
                    ),
                ],
            },
            {
                id: "term:transparency",
                type: "number",
                label: "Transparency",
                icon: "circle-half-stroke",
                keywords: ["opacity", "background"],
                min: 0,
                max: 1,
                step: 0.05,
                control: "slider",
                format: (v) => `${Math.round(v * 100)} %`,
                defaultValue: TerminalTransparencyDefault,
                scopes: [
                    metaBinding<number>(blockId, "term:transparency"),
                    settingsBinding<number>("term:transparency", TerminalTransparencyDefault),
                ],
            },
            waveAction(waveItems, "Save session as…", {
                id: "term:savesession",
                label: "Save session as…",
                icon: "floppy-disk",
                keywords: ["scrollback", "output", "log"],
            }),
            waveAction(waveItems, "File Browser", {
                id: "term:filebrowser",
                label: "Open a file browser here",
                icon: "folder-tree",
                keywords: ["files", "preview"],
            }),
            {
                id: "term:clearonstart",
                type: "toggle",
                label: "Clear output on restart",
                icon: "eraser",
                defaultValue: false,
                scopes: [metaBinding<boolean>(blockId, "cmd:clearonstart")],
            },
            {
                id: "term:runonstart",
                type: "toggle",
                label: "Run on startup",
                icon: "play",
                defaultValue: false,
                scopes: [metaBinding<boolean>(blockId, "cmd:runonstart")],
            },
            waveAction(waveItems, "Close Toolbar", {
                id: "term:closetoolbar",
                label: "Close the toolbar",
                icon: "xmark",
            }),
        ] as PanelItem[]
    ).filter((i) => i != null);

    // Only once the panel runs a shell command controller does Run on startup mean something.
    const shown = items.filter((i) => i.id !== "term:runonstart" || meta.controller === "cmd");

    const debug = adaptMenuItems(
        [findWaveItem(waveItems, "Debug Connection")].filter((i) => i != null),
        "term:dev:"
    );
    const developer = (
        [
            {
                id: "term:bracketedpaste",
                type: "toggle",
                label: "Bracketed paste",
                icon: "paste",
                keywords: ["paste mode"],
                defaultValue: true,
                scopes: [
                    metaBinding<boolean>(blockId, "term:allowbracketedpaste"),
                    settingsBinding<boolean>("term:allowbracketedpaste", true),
                ],
            },
            waveAction(waveItems, "Force Restart Controller", {
                id: "term:forcerestart",
                label: "Force restart",
                icon: "rotate-right",
                destructive: true,
                keywords: ["controller", "restart shell"],
            }),
            // The adapter files Debug Connection under its own developer items.
            ...[...debug.items, ...debug.developer].map((i) => ({ ...i, label: "Debug connection", icon: "bug" })),
        ] as PanelItem[]
    ).filter((i) => i != null);

    return [
        { id: "widget:terminal", kind: "widget", title: "Terminal", items: shown },
        { id: "developer", kind: "developer", title: "Developer", items: developer },
    ];
}

export const TerminalProvider: CommandProvider = {
    id: "terminal",
    kind: "widget",
    needs: ["terminal"],
    sections: terminalSections,
};
