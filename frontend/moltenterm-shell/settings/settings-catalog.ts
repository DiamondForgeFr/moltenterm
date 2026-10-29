// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the settings screen shows (FR-SHELL-050, DS-SHELL-091), read from schema/settings.json: the add-config path
// generates the schema from wconfig.SettingsType, and cmd/generateschema adds each key's "x-moltenterm" metadata
// (pkg/molten/settingsmeta). A key the metadata does not know shows under Advanced with its key as label, so a new
// setting appears without UI code. The settings that live in the current workspace's meta (not in settings.json) are
// declared here, as WorkspaceSettings. Kept apart from the components so the rules are tested without the app.

import builtinDefaults from "../../../pkg/wconfig/defaultconfig/settings.json";
import settingsSchema from "../../../schema/settings.json";
import { t, TFunction } from "../i18n/i18n";
import { hasKey } from "../i18n/i18n-core";
import { ProjectMetaKey, WorkspaceFolderMetaKey } from "../workspace-project";

export type SettingsSectionId =
    | "general"
    | "spaces"
    | "appearance"
    | "terminal"
    | "agents"
    | "browser"
    | "mission"
    | "notifications"
    | "keyboard"
    | "mods"
    | "secrets"
    | "tips"
    | "advanced";

export type SettingsControl = "toggle" | "select" | "number" | "slider" | "text" | "path" | "multi" | "json";

// description: the line under the section's title (#534).
export type SettingsSection = { id: SettingsSectionId; title: string; icon: string; description: string };

// The fixed order of the left list (DS-SHELL-091). The Library's Settings page lists the same sections, Tips included,
// so the two lists never drift apart (FR-SHELL-106).
export const SettingsSections: SettingsSection[] = [
    {
        id: "general",
        title: "General",
        icon: "sliders",
        description: "Quitting and closing, startup, panels and files.",
    },
    {
        id: "spaces",
        title: "Workspaces and views",
        icon: "layer-group",
        description: "The sidebar, the views pinned everywhere, new views and what a new workspace starts with.",
    },
    {
        id: "appearance",
        title: "Appearance",
        icon: "palette",
        description: "The window, the 360 view, its text and the magnified panel.",
    },
    {
        id: "terminal",
        title: "Terminal",
        icon: "terminal",
        description: "How terminals look and behave, their shell and connections.",
    },
    {
        id: "agents",
        title: "Agents",
        icon: "robot",
        description: "The agent companion, and what MoltenTerm adds when an agent starts in its terminals.",
    },
    {
        id: "browser",
        title: "Browser",
        icon: "globe",
        description: "The Web page panel, how pages open, and the browser agents use.",
    },
    {
        id: "mission",
        title: "Project",
        icon: "diagram-project",
        description: "The Project, CI/CD and Line map panels.",
    },
    // The levels set per subject live in the client's meta, not in settings.json (notification-settings.tsx).
    {
        id: "notifications",
        title: "Notifications",
        icon: "bell",
        description: "What each subject tells you, and when the notification panel opens by itself.",
    },
    { id: "keyboard", title: "Keyboard", icon: "keyboard", description: "Keys and every shortcut." },
    // The mods this tab view runs and what each costs (FR-PERF-014); no settings.json key maps here.
    { id: "mods", title: "Mods", icon: "puzzle-piece", description: "The mods this window runs and what each costs." },
    // Secrets live in the system's secret store, not in settings.json (#534).
    {
        id: "secrets",
        title: "Secrets",
        icon: "lock",
        description:
            "Values stored in your system's secret store, for connections and commands. Never shown unless you ask.",
    },
    { id: "tips", title: "Tips", icon: "lightbulb", description: "Reshape MoltenTerm, work faster, every shortcut." },
    {
        id: "advanced",
        title: "Advanced",
        icon: "code",
        description: "Window and app internals, debugging, and the JSON files behind every setting.",
    },
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
    // A multi whose list holds the options turned off: an option shows ticked when it is absent (#947).
    inverted?: boolean;
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
    inverted?: boolean;
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
            inverted: meta.inverted || undefined,
            scope: "global",
            order: meta.order ?? idx,
        });
    });
    return entries;
}

// The settings of the current workspace (FR-SHELL-050-AC4): they live in the workspace's meta, not in settings.json,
// so the schema cannot carry them. They are edited in the workspace sheet, not in General, a section for the whole
// app (FR-SHELL-101): the search still finds them and opens the sheet.
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
        description: "The project this workspace is linked to, for the Project panel.",
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

// The interface language's text of a key, or the English text the metadata carries when the dictionaries do not know
// the key yet (a setting added in Go shows before it is translated).
function translatedOr(tr: TFunction, key: string, fallback: string): string {
    return hasKey(key) ? tr(key) : fallback;
}

// The group's key: the English group in camelCase ("Quitting and closing" is quittingAndClosing).
export function groupSlug(group: string): string {
    const words = (group ?? "")
        .replace(/[^A-Za-z0-9]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter((w) => w !== "");
    return words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join("");
}

// A row in the interface language: settings.items.<key>.* and settings.groups.<slug>, with the metadata's English for
// a key the dictionaries lack (FR-I18N-001).
export function localizeSettingEntry(entry: SettingEntry, tr: TFunction): SettingEntry {
    const base = `settings.items.${entry.key}`;
    return {
        ...entry,
        group: translatedOr(tr, `settings.groups.${groupSlug(entry.group)}`, entry.group),
        label: translatedOr(tr, `${base}.label`, entry.label),
        description: translatedOr(tr, `${base}.description`, entry.description),
        unsetLabel: entry.unsetLabel != null ? translatedOr(tr, `${base}.unset`, entry.unsetLabel) : undefined,
        unit: entry.unit ? translatedOr(tr, `settings.units.${entry.unit}`, entry.unit) : entry.unit,
        options: entry.options?.map((o) => ({
            value: o.value,
            label: translatedOr(tr, `${base}.options.${o.value}`, o.label),
        })),
    };
}

export function localizeCatalog(entries: SettingEntry[], tr: TFunction): SettingEntry[] {
    return entries.map((e) => localizeSettingEntry(e, tr));
}

export function localizeSection(section: SettingsSection, tr: TFunction): SettingsSection {
    return {
        ...section,
        title: translatedOr(tr, `settings.sections.${section.id}.title`, section.title),
        description: translatedOr(tr, `settings.sections.${section.id}.description`, section.description),
    };
}

// The rows a section shows: the app's settings only, the workspace's live in its sheet (FR-SHELL-101).
export function sectionEntries(entries: SettingEntry[], section: SettingsSectionId): SettingEntry[] {
    return entries.filter((e) => e.section === section && e.scope !== "workspace").sort((a, b) => a.order - b.order);
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

export function sectionTitle(id: SettingsSectionId, tr: TFunction = t): string {
    const section = SettingsSections.find((s) => s.id === id);
    return section != null ? localizeSection(section, tr).title : id;
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
export function jsonSummary(value: unknown, tr: TFunction = t): string {
    if (value == null) {
        return tr("settings.notSet");
    }
    if (Array.isArray(value)) {
        if (value.length === 0) return tr("settings.notSet");
        return value.length === 1
            ? tr("settings.count.items.one")
            : tr("settings.count.items.other", { count: value.length });
    }
    if (typeof value === "object") {
        const n = Object.keys(value).length;
        if (n === 0) return tr("settings.notSet");
        return n === 1 ? tr("settings.count.entries.one") : tr("settings.count.entries.other", { count: n });
    }
    return String(value);
}

// A short exclusive choice reads as option rows, like Notulia's (#658): every choice in sight, the current one marked
// "Selected". A longer list (terminal themes, the installed browsers) stays a menu.
export const MaxChoiceRows = 4;

export type SettingChoice = { value: string; label: string };

// The choices a setting shows as option rows, or null for a menu. The empty value is the unset choice (the system's
// language, a setting's own "unset" label).
export function settingChoices(
    entry: SettingEntry,
    languages: { code: string; name: string }[],
    systemLanguageLabel: string
): SettingChoice[] {
    if (entry.control !== "select") {
        return null;
    }
    if (entry.optionsFrom === "languages") {
        if (languages.length > MaxChoiceRows - 1) {
            return null;
        }
        return [{ value: "", label: systemLanguageLabel }, ...languages.map((l) => ({ value: l.code, label: l.name }))];
    }
    if (entry.optionsFrom != null || entry.options == null) {
        return null;
    }
    const list = entry.options.map((o) => ({ value: o.value, label: o.label }));
    if (entry.unsetLabel != null) {
        list.unshift({ value: "", label: entry.unsetLabel });
    }
    return list.length <= MaxChoiceRows ? list : null;
}

// A multi's option is ticked when its value is in the list, or, inverted, when it is absent (#947: "Agents with the
// integration" stores the agents turned off in agent:integrateoff).
export function multiOptionOn(entry: SettingEntry, value: unknown, option: string): boolean {
    const chosen = Array.isArray(value) ? (value as string[]) : [];
    return entry.inverted ? !chosen.includes(option) : chosen.includes(option);
}

// The list to write once the option is clicked; null clears an empty list.
export function multiToggled(entry: SettingEntry, value: unknown, option: string): string[] {
    const chosen = Array.isArray(value) ? (value as string[]) : [];
    const next = chosen.includes(option) ? chosen.filter((v) => v !== option) : [...chosen, option];
    return next.length ? next : null;
}
