// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Wave's getSettingsMenuItems() as command panel items (DS-SHELL-086, FR-SHELL-047-AC7), so a Wave widget nobody
// rewrote still gets the panel, with its checked states: a checkbox becomes a toggle, a submenu of checked or radio
// items a choice sub-page, any other submenu a sub-page of items (never a cascade), a plain item an action. Split
// items are dropped (the footer has them) and the developer items move to the Developer section from any depth.

import { menuLabel, shortcutLabel } from "../menu/menu-model";
import { PanelChoiceOption, PanelItem } from "./panel-types";

// split-menu.ts's labels, repeated so the adapter stays free of the stores split.ts loads.
const SplitLabels = new Set(["Split right", "Split down"]);

// Labels Wave uses for items only a developer needs (the audit's "shown to everyone" list).
export const DeveloperLabelPatterns: RegExp[] = [
    /^copy block ?id$/i,
    /^force restart controller$/i,
    /^debug connection$/i,
    /bracketed paste/i,
    /devtools/i,
];

export function isDeveloperLabel(label: string): boolean {
    return DeveloperLabelPatterns.some((re) => re.test((label ?? "").trim()));
}

export type AdaptedMenu = { items: PanelItem[]; developer: PanelItem[] };

function slug(text: string): string {
    return (
        (text ?? "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || "item"
    );
}

function visible(items: ContextMenuItem[]): ContextMenuItem[] {
    return (items ?? []).filter((it) => it != null && it.visible !== false);
}

function leafEntries(items: ContextMenuItem[]): ContextMenuItem[] {
    return visible(items).filter((it) => it.type !== "separator" && it.type !== "header");
}

function isChoiceMenu(children: ContextMenuItem[]): boolean {
    const leaves = leafEntries(children);
    return (
        leaves.length > 0 &&
        leaves.some((c) => c.type === "checkbox" || c.type === "radio") &&
        leaves.every((c) => !visible(c.submenu).length)
    );
}

type Ids = { used: Set<string> };

function uniqueId(ids: Ids, base: string): string {
    let id = base;
    for (let n = 2; ids.used.has(id); n++) {
        id = `${base}-${n}`;
    }
    ids.used.add(id);
    return id;
}

function convert(item: ContextMenuItem, prefix: string, ids: Ids, developer: PanelItem[]): PanelItem {
    if (item == null || item.visible === false || item.type === "separator") {
        return null;
    }
    const label = menuLabel(item);
    if (SplitLabels.has(label)) {
        return null;
    }
    const id = uniqueId(ids, `${prefix}${slug(label)}`);
    const base = {
        id,
        label,
        icon: item.icon,
        detail: item.sublabel,
        shortcut: shortcutLabel(item.accelerator) || undefined,
        disabled: item.enabled === false,
        destructive: item.destructive,
    };
    const children = visible(item.submenu);
    if (children.length > 0) {
        if (isChoiceMenu(children)) {
            const options: PanelChoiceOption[] = leafEntries(children).map((child) => ({
                id: uniqueId(ids, `${id}/${slug(menuLabel(child))}`),
                label: menuLabel(child),
                checked: !!child.checked,
                disabled: child.enabled === false,
                run: child.click,
            }));
            // Wave's On / Off submenus are a switch.
            const on = options.find((o) => o.label === "On");
            const off = options.find((o) => o.label === "Off");
            if (options.length === 2 && on != null && off != null && on.run != null && off.run != null) {
                return {
                    ...base,
                    type: "toggle",
                    value: !!on.checked,
                    set: (value: boolean) => {
                        if (value === !!on.checked) {
                            return;
                        }
                        return (value ? on.run() : off.run()) as void | Promise<void>;
                    },
                };
            }
            return { ...base, type: "choice", options };
        }
        const inner: PanelItem[] = [];
        for (const child of children) {
            const converted = convert(child, `${id}/`, ids, developer);
            if (converted == null) {
                continue;
            }
            if (isDeveloperLabel(converted.label)) {
                developer.push(converted);
            } else {
                inner.push(converted);
            }
        }
        if (inner.length === 0) {
            return null;
        }
        return { ...base, type: "page", items: inner };
    }
    if (item.type === "header" || (item.click == null && item.role == null)) {
        // Wave's disabled labels ("Default Settings") read as a note above the items they introduce.
        return { ...base, type: "info", disabled: true };
    }
    if (item.click == null) {
        // A role-only item (Copy, Paste) needs the native menu's target; the panel has none.
        return null;
    }
    if (item.type === "checkbox" || item.type === "radio") {
        return {
            ...base,
            type: "toggle",
            value: !!item.checked,
            // Wave's click flips the state: asking for the state it already has does nothing (a double activation
            // before the panel reads the new state must not flip it back).
            set: (value: boolean) => {
                if (value === !!item.checked) {
                    return;
                }
                item.click();
            },
        };
    }
    return { ...base, type: "action", run: () => item.click() };
}

export function adaptMenuItems(items: ContextMenuItem[], prefix = "wave:"): AdaptedMenu {
    const ids: Ids = { used: new Set() };
    const developer: PanelItem[] = [];
    const out: PanelItem[] = [];
    for (const item of visible(items)) {
        const converted = convert(item, prefix, ids, developer);
        if (converted == null) {
            continue;
        }
        if (isDeveloperLabel(converted.label)) {
            developer.push(converted);
        } else {
            out.push(converted);
        }
    }
    // A trailing note introduces nothing.
    while (out.length > 0 && out[out.length - 1].type === "info") {
        out.pop();
    }
    // Destructive items sit last (FR-SHELL-047 security rationale).
    const kept = [...out.filter((i) => !i.destructive), ...out.filter((i) => i.destructive)];
    return { items: kept, developer };
}
