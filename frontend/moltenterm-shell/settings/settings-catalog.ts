// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the settings screen shows (FR-SHELL-050, DS-SHELL-091), read from schema/settings.json: the add-config path
// generates the schema from wconfig.SettingsType, and cmd/generateschema adds each key's "x-moltenterm" metadata
// (pkg/molten/settingsmeta). A key the metadata does not know shows under Advanced with its key as label, so a new
// setting appears without UI code. The settings that live in the current workspace's meta (not in settings.json) are
// declared here, as WorkspaceSettings. Kept apart from the components so the rules are tested without the app.

import builtinDefaults from "../../../pkg/wconfig/defaultconfig/settings.json";
import settingsSchema from "../../../schema/settings.json";
import { ProjectMetaKey, WorkspaceFolderMetaKey } from "../workspace-project";

export type SettingsSectionId =
    | "general"
    | "appearance"
    | "terminal"
    | "agents"
    | "browser"
    | "mission"
    | "keyboard"
    | "advanced";

export type SettingsControl = "toggle" | "select" | "number" | "slider" | "text" | "path" | "multi" | "json";

export type SettingsSection = { id: SettingsSectionId; title: string; icon: string };

// The fixed order of the left list (DS-SHELL-091).
export const SettingsSections: SettingsSection[] = [
    { id: "general", title: "General", icon: "sliders" },
    { id: "appearance", title: "Appearance", icon: "palette" },
    { id: "terminal", title: "Terminal", icon: "terminal" },
    { id: "agents", title: "Agents", icon: "robot" },
    { id: "browser", title: "Browser", icon: "globe" },
    { id: "mission", title: "Mission Control", icon: "diagram-project" },
    { id: "keyboard", title: "Keyboard", icon: "keyboard" },
    { id: "advanced", title: "Advanced", icon: "code" },
];

export type SettingOption = { value: string; label: string };

// "global": settings.json. "workspace": the current workspace's meta, the setting applies to that workspace only.
export type SettingScope = "global" | "workspace";

export type SettingEntry = {
    key: string;
    section: SettingsSectionId;
    group: string;
    label: string;
    description: string;
    control: SettingsControl;
    options?: SettingOption[];
    optionsFrom?: string;
    unsetLabel?: string;
    range?: { min: number; max: number; step: number };
    unit?: string;
    // What the app uses when the key is unset.
    defaultValue?: unknown;
    platform?: string;
    scope: SettingScope;
    order: number;
};

type SchemaMeta = {
    section?: string;
    group?: string;
    label?: string;
    description?: string;
    control?: string;
    options?: SettingOption[];
    optionsfrom?: string;
    unsetlabel?: string;
    range?: { min: number; max: number; step: number };
    unit?: string;
    default?: unknown;
    platform?: string;
    hidden?: boolean;
    order?: number;
};

type SchemaProperty = {
    type?: string;
    enum?: unknown[];
    description?: string;
    "x-moltenterm"?: SchemaMeta;
};

export type SettingsSchema = { $defs?: { SettingsType?: { properties?: Record<string, SchemaProperty> } } };

export const UnknownGroup = "Other settings";

// The control of a key without metadata, from its JSON type.
function controlForType(prop: SchemaProperty): SettingsControl {
    if (prop.enum?.length) {
        return "select";
    }
    switch (prop.type) {
        case "boolean":
            return "toggle";
        case "number":
        case "integer":
            return "number";
        case "string":
            return "text";
        default:
            return "json";
    }
}

const SectionIds = new Set<string>(SettingsSections.map((s) => s.id));

// Unknown keys come after every described one, in the schema's order (the struct's).
const UnknownOrderBase = 10000;

export function buildCatalog(
    schema: SettingsSchema,
    defaults: Record<string, unknown>,
    platform: string
): SettingEntry[] {
    const props = schema?.$defs?.SettingsType?.properties ?? {};
    const entries: SettingEntry[] = [];
    Object.entries(props).forEach(([key, prop], idx) => {
        const meta = prop["x-moltenterm"];
        if (meta?.hidden) {
            return;
        }
        if (meta?.platform && !meta.platform.split(",").includes(platform)) {
            return;
        }
        if (meta == null || !SectionIds.has(meta.section)) {
            entries.push({
                key,
                section: "advanced",
                group: UnknownGroup,
                label: key,
                description: prop.description ?? "",
                control: controlForType(prop),
                options: prop.enum?.map((v) => ({ value: String(v), label: String(v) })),
                defaultValue: defaults?.[key],
                scope: "global",
                order: UnknownOrderBase + idx,
            });
            return;
        }
        entries.push({
            key,
            section: meta.section as SettingsSectionId,
            group: meta.group ?? UnknownGroup,
            label: meta.label ?? key,
            description: meta.description ?? prop.description ?? "",
            control: (meta.control as SettingsControl) ?? controlForType(prop),
            options: meta.options,
            optionsFrom: meta.optionsfrom,
            unsetLabel: meta.unsetlabel,
            range: meta.range,
            unit: meta.unit,
            defaultValue: defaults?.[key] ?? meta.default,
            platform: meta.platform,
            scope: "global",
            order: meta.order ?? idx,
        });
    });
    return entries;
}

// The settings of the current workspace (FR-SHELL-050-AC4): they live in the workspace's meta, not in settings.json,
// so the schema cannot carry them. Each sits at the top of its section.
export const WorkspaceSettings: SettingEntry[] = [
    {
        key: WorkspaceFolderMetaKey,
        section: "general",
        group: "This workspace",
        label: "Working folder",
        description: "Where this workspace's new terminals and file views start.",
        control: "path",
        scope: "workspace",
        order: -2,
    },
    {
        key: ProjectMetaKey,
        section: "general",
        group: "This workspace",
        label: "Project folder",
        description: "The project this workspace is linked to, for Mission Control.",
        control: "path",
        scope: "workspace",
        order: -1,
    },
];

let cached: SettingEntry[] = null;

export function settingsCatalog(platform: string): SettingEntry[] {
    if (cached == null) {
        cached = [
            ...WorkspaceSettings,
            ...buildCatalog(settingsSchema as SettingsSchema, builtinDefaults as Record<string, unknown>, platform),
        ];
    }
    return cached;
}

export function sectionEntries(entries: SettingEntry[], section: SettingsSectionId): SettingEntry[] {
    return entries.filter((e) => e.section === section).sort((a, b) => a.order - b.order);
}

// The rows of a section by group, groups in the order of their first row.
export function groupEntries(entries: SettingEntry[]): { group: string; entries: SettingEntry[] }[] {
    const groups: { group: string; entries: SettingEntry[] }[] = [];
    for (const entry of entries) {
        let g = groups.find((x) => x.group === entry.group);
        if (g == null) {
            g = { group: entry.group, entries: [] };
            groups.push(g);
        }
        g.entries.push(entry);
    }
    return groups;
}

export function sectionTitle(id: SettingsSectionId): string {
    return SettingsSections.find((s) => s.id === id)?.title ?? id;
}

function normalize(text: string): string {
    return (text ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Search by label, key and description (FR-SHELL-050-AC2): every word must appear in one of them; a label match ranks
// first, then a key match, then the description. Ties keep the screen's order.
export function searchSettings(entries: SettingEntry[], query: string): SettingEntry[] {
    const words = normalize(query)
        .split(/\s+/)
        .filter((w) => w !== "");
    if (words.length === 0) {
        return [];
    }
    const sectionRank = (id: SettingsSectionId) => SettingsSections.findIndex((s) => s.id === id);
    const scored: { entry: SettingEntry; score: number }[] = [];
    for (const entry of entries) {
        const label = normalize(entry.label);
        const key = normalize(entry.key);
        const desc = normalize(`${entry.description} ${entry.group}`);
        let score = 0;
        let all = true;
        for (const w of words) {
            if (label.startsWith(w) || label.includes(` ${w}`)) {
                score += 4;
            } else if (label.includes(w)) {
                score += 3;
            } else if (key.includes(w)) {
                score += 2;
            } else if (desc.includes(w)) {
                score += 1;
            } else {
                all = false;
                break;
            }
        }
        if (all) {
            scored.push({ entry, score });
        }
    }
    scored.sort(
        (a, b) =>
            b.score - a.score ||
            sectionRank(a.entry.section) - sectionRank(b.entry.section) ||
            a.entry.order - b.entry.order
    );
    return scored.map((s) => s.entry);
}

function sameValue(a: unknown, b: unknown): boolean {
    if (a === b) {
        return true;
    }
    if (a == null || b == null || typeof a !== "object" || typeof b !== "object") {
        return false;
    }
    return JSON.stringify(a) === JSON.stringify(b);
}

// What a row shows: the value set, else the default.
export function effectiveSetting(entry: SettingEntry, value: unknown): unknown {
    return value ?? entry.defaultValue;
}

// Reset shows when the value differs from what the app uses unset (a toggle without default is off; an empty list or
// text counts as unset).
export function isChanged(entry: SettingEntry, value: unknown): boolean {
    if (value == null || value === "" || (Array.isArray(value) && value.length === 0 && entry.defaultValue == null)) {
        return false;
    }
    const fallback = entry.defaultValue ?? (entry.control === "toggle" ? false : undefined);
    return !sameValue(value, fallback);
}

// A number typed in a field, kept inside the range and on its step; null when it is not a number.
export function clampSetting(entry: SettingEntry, raw: string): number {
    const n = Number(String(raw).trim());
    if (String(raw).trim() === "" || !Number.isFinite(n)) {
        return null;
    }
    if (entry.range == null) {
        return n;
    }
    const { min, max, step } = entry.range;
    const stepped = step > 0 ? Math.round((n - min) / step) * step + min : n;
    const snapped = Number(stepped.toFixed(6));
    return Math.min(max, Math.max(min, snapped));
}

// The short summary of an object or list the screen does not edit ("3 sites").
export function jsonSummary(value: unknown): string {
    if (value == null) {
        return "Not set";
    }
    if (Array.isArray(value)) {
        return value.length === 0 ? "Not set" : value.length === 1 ? "1 item" : `${value.length} items`;
    }
    if (typeof value === "object") {
        const n = Object.keys(value).length;
        return n === 0 ? "Not set" : n === 1 ? "1 entry" : `${n} entries`;
    }
    return String(value);
}
