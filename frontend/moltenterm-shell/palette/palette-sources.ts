// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The palette's entries (FR-SHELL-013), from configuration and the workspace: agent presets (presets "agent@<id>"),
// panels (widgets.json), recent folders (FR-SHELL-009) and workspace actions. Pure, so the rules are tested without
// the app.

import { AiIcon } from "../ai-icon";
import { addressUrl, browserBlockDef, looksLikeAddress } from "../browser/browser-model";
import { CompanionTargetMetaKey, MoltentermCompanionView } from "../companion/companion-model";
import { t } from "../i18n/i18n";
import { FallbackLanguage, languageText } from "../i18n/i18n-core";
import { MoltentermLineMapView } from "../mission/line-map-model";
import { MoltentermProjectView } from "../project/project-model";
import { MoltentermSessionsView } from "../sessions/sessions-model";
import { formatShortcutById } from "../shortcuts/format";
import type { PinMove } from "../sidebar/view-menu-model";
import { panelKindRank, terminalBlockDefFrom } from "../split/split-model";
import { AgentCopyProfiles } from "../term-copy/agent-copy-profiles";
import { updateAllDetail } from "../termupdate/termupdate-model";
import { workspaceShownName } from "../workspace-default-name";
import {
    AddressEntryId,
    PaletteEntry,
    PaletteGroupId,
    PickerGroupOrder,
    shortestSelectingPrefix,
} from "./palette-model";

// Agent presets live with Wave's presets, under their own prefix: defaults in pkg/wconfig/defaultconfig/presets/
// agents.json, the user's in presets.json or presets/*.json of the config folder (a mod can ship one later).
export const AgentPresetPrefix = "agent@";
export const AgentCommandKey = "agent:command";

export const MaxRecentFolders = 8;

export const PaletteKeywordsPrefix = "palette.keywords.";

function keywordList(text: string): string[] {
    return (text ?? "")
        .split(",")
        .map((w) => w.trim())
        .filter((w) => w !== "");
}

// The words an entry is found by beyond its label (#1670), translated like the label: palette.keywords.<name> is a
// comma-separated list in each language. The current language's words come first, then English's, since people type
// the English word in any language ("pin" in French). ids are identifiers that stay as they are (an agent id, a
// browser id, a workspace's name).
export function paletteKeywords(name: string, ...ids: string[]): string[] {
    const key = PaletteKeywordsPrefix + name;
    const shown = t(key);
    const words = [
        ...(shown === key ? [] : keywordList(shown)),
        ...keywordList(languageText(FallbackLanguage, key)),
        ...ids.filter((s) => s),
    ];
    return [...new Set(words)];
}

// Wave's widget labels are lowercase words made for small tiles; the palette names the built-in panels in full.
const PanelNameKeys: Record<string, string> = {
    "defwidget@terminal": "palette.panelNames.terminal",
    "defwidget@files": "palette.panelNames.files",
    "defwidget@web": "palette.panelNames.browser",
    "defwidget@cicd": "palette.panelNames.cicd",
    "defwidget@reviews": "palette.panelNames.reviews",
    "defwidget@sysinfo": "palette.panelNames.sysinfo",
    "defwidget@processviewer": "palette.panelNames.processes",
};

// "Open <address>" when the typed text is an address (#1229): a web page panel on it, read as the top field reads it.
export function addressEntry(query: string): PaletteEntry {
    const text = (query ?? "").trim();
    if (!looksLikeAddress(text)) {
        return null;
    }
    const url = addressUrl(text);
    if (url == null) {
        return null;
    }
    return {
        id: AddressEntryId,
        group: "panels",
        label: t("palette.openAddress", { address: text }),
        icon: "globe",
        run: { kind: "widget", blockdef: browserBlockDef(url) },
    };
}

export type PaletteWorkspace = {
    id: string;
    name: string;
    icon: string;
    color: string;
    // The imported icon's stored name and the project logo: the entry shows the rail's resolved badge (FR-SHELL-031).
    image?: string;
    logo?: string;
    active: boolean;
};

export type PaletteSourceInput = {
    presets: { [key: string]: MetaType };
    // The catalog's agents with whether each is on this computer (#1680).
    installedAgents?: InstalledAgent[];
    widgets: { [key: string]: WidgetConfigType };
    workspaceId: string;
    // Where new blocks of the workspace start (effectiveWorkspaceFolder), "" when it has none.
    folder: string;
    recentFolders: string[];
    otherFolders: string[];
    workspaces: PaletteWorkspace[];
    home: string;
    // The workspace is linked to a project (FR-MC-001): its Project tab can be opened.
    projectLinked?: boolean;
    // The installed browser pages are handed off to (FR-BRW-002), and whether the tab has a browser panel.
    installedBrowser?: { id: string; name: string };
    hasBrowserPanel?: boolean;
    // How many terminals still run with an older MoltenTerm shell environment (FR-SHELL-041).
    outdatedTerminals?: number;
    // The palette is a split's picker (FR-SHELL-042): the panel the split came from, and the keys that make a split.
    picker?: PickerSource;
    // The shortcuts sheet's keys, shown on its entry.
    shortcutsHint?: string;
    // The pin moves of the view on screen, as its menu offers them, and the move the keep shortcut makes (#1652).
    viewPin?: { moves: PinMove[]; keepMove: PinMove; keepHint: string };
};

export type PickerSource = {
    blockId: string;
    meta: MetaType;
    // The split's own keys ("⌘D"), the start of every key path.
    splitKeys: string;
    // The companion's global shortcut ("⇧⌘J").
    companionKeys?: string;
};

function str(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function tildePath(path: string, home: string): string {
    if (!path || !home) {
        return path ?? "";
    }
    const h = home.replace(/[/\\]+$/, "");
    if (path === h) {
        return "~";
    }
    if (path.startsWith(h + "/") || path.startsWith(h + "\\")) {
        return "~" + path.slice(h.length);
    }
    return path;
}

function baseName(path: string): string {
    const parts = (path ?? "").split(/[/\\]/).filter((p) => p !== "");
    return parts[parts.length - 1] ?? path;
}

export type AgentPreset = { id: string; name: string; command: string; icon: string; color: string; order: number };

// Presets "agent@<id>" with a command; display:hidden turns a default off. Ordered by display:order, then name.
export function readAgentPresets(presets: { [key: string]: MetaType }): AgentPreset[] {
    const rtn: AgentPreset[] = [];
    for (const [key, preset] of Object.entries(presets ?? {})) {
        if (!key.startsWith(AgentPresetPrefix) || preset == null || typeof preset !== "object") {
            continue;
        }
        const meta = preset as Record<string, unknown>;
        const command = str(meta[AgentCommandKey]);
        if (command === "" || meta["display:hidden"] === true) {
            continue;
        }
        const id = key.slice(AgentPresetPrefix.length);
        rtn.push({
            id,
            name: str(meta["display:name"]) || id,
            command,
            icon: AiIcon,
            color: str(meta["display:color"]),
            order: num(meta["display:order"], 0),
        });
    }
    rtn.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    return rtn;
}

// An agent of MoltenTerm's catalog found on this computer (wavesrv's agent choice, pkg/molten/agentchoice): the
// agents without a preset of their own are offered too (#1680), after the presets, under their own name and program.
// A preset of the same id, hidden or not, or with the same program, wins: the developer's configuration decides.
export type InstalledAgent = { id: string; name: string; command?: string; installed?: boolean };

export function installedAgentPresets(
    presets: { [key: string]: MetaType },
    installed: InstalledAgent[]
): AgentPreset[] {
    const taken = new Set<string>();
    for (const key of Object.keys(presets ?? {})) {
        if (key.startsWith(AgentPresetPrefix)) {
            taken.add(key.slice(AgentPresetPrefix.length));
        }
    }
    for (const p of readAgentPresets(presets)) {
        taken.add(p.command.split(/\s+/)[0]);
    }
    const rtn: AgentPreset[] = [];
    for (const agent of installed ?? []) {
        const command = agent?.command || agent?.id;
        if (!agent?.installed || !command || taken.has(agent.id) || taken.has(command)) {
            continue;
        }
        taken.add(agent.id);
        taken.add(command);
        rtn.push({ id: agent.id, name: agent.name || agent.id, command, icon: AiIcon, color: "", order: 0 });
    }
    return rtn;
}

export function agentEntries(presets: { [key: string]: MetaType }, installed?: InstalledAgent[]): PaletteEntry[] {
    return [...readAgentPresets(presets), ...installedAgentPresets(presets, installed)].map((p) => ({
        id: `agent:${p.id}`,
        group: "agents",
        label: p.name,
        icon: p.icon,
        color: p.color || undefined,
        cli: p.command,
        keywords: paletteKeywords("agent", p.id),
        run: { kind: "agent", command: p.command },
    }));
}

function isWidgetForWorkspace(widget: WidgetConfigType, workspaceId: string): boolean {
    const only = widget.workspaces ?? [];
    return only.length === 0 || only.includes(workspaceId);
}

// Every visible widget except the launcher itself (a palette entry that opens a palette would be a loop).
export function panelEntries(widgets: { [key: string]: WidgetConfigType }, workspaceId: string): PaletteEntry[] {
    return Object.entries(widgets ?? {})
        .filter(([, w]) => w != null && !w["display:hidden"] && isWidgetForWorkspace(w, workspaceId))
        .filter(([, w]) => w.blockdef?.meta?.view !== "launcher")
        .sort(([ka, a], [kb, b]) => (a["display:order"] ?? 0) - (b["display:order"] ?? 0) || ka.localeCompare(kb))
        .map(([key, w]) => ({
            id: `panel:${key}`,
            group: "panels" as PaletteGroupId,
            label: PanelNameKeys[key] != null ? t(PanelNameKeys[key]) : w.label || key,
            detail: w.description || undefined,
            icon: w.icon || "browser",
            color: w.color || undefined,
            keywords: [w.label, w.blockdef?.meta?.view].filter((s) => s),
            run: { kind: "widget", blockdef: w.blockdef },
        }));
}

// The workspace's own history first, then the folders of the other workspaces; never the folder agents and new
// terminals already start in.
export function recentFolderList(
    folder: string,
    recent: string[],
    otherFolders: string[],
    max = MaxRecentFolders
): string[] {
    const rtn: string[] = [];
    for (const f of [...(recent ?? []), ...(otherFolders ?? [])]) {
        if (!f || f === folder || rtn.includes(f)) {
            continue;
        }
        rtn.push(f);
        if (rtn.length >= max) {
            break;
        }
    }
    return rtn;
}

export function folderEntries(folders: string[], home: string): PaletteEntry[] {
    return folders.map((path) => ({
        id: `folder:${path}`,
        group: "folders",
        label: baseName(path),
        detail: tildePath(path, home),
        icon: "folder",
        run: { kind: "folder", path },
    }));
}

export function actionEntries(workspaces: PaletteWorkspace[], projectLinked = false): PaletteEntry[] {
    const rtn: PaletteEntry[] = [];
    if (projectLinked) {
        rtn.push({
            id: "action:projecttab",
            group: "actions",
            label: t("palette.actions.projectTab"),
            detail: t("palette.actions.projectTabDetail"),
            icon: "gauge",
            keywords: paletteKeywords("projectTab"),
            run: { kind: "projecttab" },
        });
    }
    rtn.push(
        {
            id: "action:newtab",
            group: "actions",
            label: t("palette.actions.newTab"),
            icon: "plus",
            hint: formatShortcutById("new-tab") || undefined,
            run: { kind: "newtab" },
        },
        {
            id: "action:reopenclosed",
            group: "actions",
            label: t("palette.actions.reopenClosed"),
            icon: "rotate-left",
            hint: formatShortcutById("reopen-closed") || undefined,
            keywords: paletteKeywords("reopenClosed"),
            run: { kind: "reopenclosed" },
        },
        {
            id: "action:splitplace",
            group: "actions",
            label: t("palette.actions.splitPlace"),
            detail: t("palette.actions.splitPlaceDetail"),
            icon: "table-cells-large",
            hint: formatShortcutById("split-place") || undefined,
            keywords: paletteKeywords("splitPlace"),
            run: { kind: "splitplace" },
        },
        {
            id: "action:equalize",
            group: "actions",
            label: t("equalize.command"),
            detail: t("equalize.commandDetail"),
            icon: "table-columns",
            hint: formatShortcutById("equalize-panels") || undefined,
            keywords: paletteKeywords("equalize"),
            run: { kind: "equalize" },
        },
        {
            id: "action:newworkspace",
            group: "actions",
            label: t("palette.actions.newWorkspace"),
            icon: "layer-group",
            run: { kind: "newworkspace" },
        },
        {
            id: "action:editworkspace",
            group: "actions",
            label: t("palette.actions.editWorkspace"),
            detail: t("palette.actions.editWorkspaceDetail"),
            icon: "pencil",
            keywords: paletteKeywords("editWorkspace"),
            run: { kind: "editworkspace" },
        }
    );
    for (const ws of workspaces ?? []) {
        if (ws.active || !ws.id) {
            continue;
        }
        rtn.push({
            id: `action:switch:${ws.id}`,
            group: "actions",
            label: t("palette.actions.switchTo", { name: workspaceShownName(ws.name, t) }),
            icon: ws.icon || "circle",
            color: ws.color || undefined,
            badge: { icon: ws.icon || "circle", color: ws.color ?? "", image: ws.image ?? "", logo: ws.logo ?? "" },
            keywords: paletteKeywords("switchWorkspace", ws.name, workspaceShownName(ws.name, t)),
            run: { kind: "switchworkspace", workspaceId: ws.id },
        });
    }
    rtn.push({
        id: "action:gettingstarted",
        group: "actions",
        label: t("palette.actions.gettingStarted"),
        detail: t("palette.actions.gettingStartedDetail"),
        icon: "compass",
        keywords: paletteKeywords("gettingStarted"),
        run: { kind: "gettingstarted" },
    });
    rtn.push({
        id: "action:sessions",
        group: "actions",
        label: t("palette.actions.sessions"),
        detail: t("palette.actions.sessionsDetail"),
        icon: "layer-group",
        keywords: paletteKeywords("sessions"),
        run: { kind: "sessions" },
    });
    rtn.push({
        id: "action:settings",
        group: "actions",
        label: t("palette.actions.settings"),
        icon: "gear",
        keywords: paletteKeywords("settings"),
        run: { kind: "settings" },
    });
    rtn.push(shortcutsEntry());
    return rtn;
}

// The shortcuts sheet (FR-SHELL-042-AC8): the palette names it, with its keys.
export function shortcutsEntry(hint?: string): PaletteEntry {
    return {
        id: "action:shortcuts",
        group: "actions",
        label: t("palette.actions.shortcuts"),
        icon: "keyboard",
        hint: hint || undefined,
        keywords: paletteKeywords("shortcuts"),
        run: { kind: "shortcuts" },
    };
}

// The words people type for a panel kind that are not in its name (DS-SHELL-084): "git" or "branches" finds Mission
// Control, "url" the browser. The built-in panels below carry theirs; these are for the configured panels' kinds.
const PickerKeywords: Record<string, string> = {
    "molten-browser": "browserPanel",
    "molten-reviews": "reviewsPanel",
};

// The panel kinds a split's picker offers first, and with no source panel the launcher's and the new view
// chooser's panels (#1273) (DS-SHELL-066, DS-SHELL-084), in a fixed order: the configured
// panels, with the terminal and the file browser opened where the source panel is, then Mission Control's overview
// and its line map, the source terminal's companion, and Sessions.
export function pickerPanelEntries(
    widgets: { [key: string]: WidgetConfigType },
    workspaceId: string,
    source: PickerSource,
    projectLinked = false
): PaletteEntry[] {
    const sourceMeta = source?.meta ?? {};
    const cwd = sourceMeta.view === "term" ? sourceMeta["cmd:cwd"] : null;
    const panels = panelEntries(widgets, workspaceId).map((entry): PaletteEntry => {
        const view = entry.run.kind === "widget" ? entry.run.blockdef?.meta?.view : null;
        if (view === "term") {
            return {
                ...entry,
                detail: cwd || entry.detail,
                run: { kind: "widget", blockdef: terminalBlockDefFrom(sourceMeta) },
            };
        }
        if (view === "preview" && cwd) {
            const meta: MetaType = { view: "preview", file: cwd };
            if (sourceMeta.connection != null) {
                meta.connection = sourceMeta.connection;
            }
            return { ...entry, detail: cwd, run: { kind: "widget", blockdef: { meta } } };
        }
        return entry;
    });
    // Listed with or without a project: their frame offers to link one (mission-frame.tsx).
    panels.push(
        {
            id: "panel:missioncontrol",
            group: "panels",
            label: t("palette.panels.missionControl"),
            detail: t(projectLinked ? "palette.panels.missionControlDetail" : "palette.panels.noProject"),
            icon: "gauge",
            keywords: paletteKeywords("missionControl"),
            run: { kind: "widget", blockdef: { meta: { view: MoltentermProjectView } } },
        },
        {
            id: "panel:linemap",
            group: "panels",
            label: t("palette.panels.lineMap"),
            detail: t(projectLinked ? "palette.panels.lineMapDetail" : "palette.panels.noProject"),
            icon: "train-subway",
            keywords: paletteKeywords("lineMap"),
            run: { kind: "widget", blockdef: { meta: { view: MoltentermLineMapView } } },
        }
    );
    if (sourceMeta.view === "term" && source?.blockId) {
        panels.push({
            id: "panel:companion",
            group: "panels",
            label: t("palette.panels.companion"),
            detail: t("palette.panels.companionDetail"),
            icon: "book-open",
            shortcut: source.companionKeys || undefined,
            keywords: paletteKeywords("companion"),
            run: {
                kind: "widget",
                blockdef: {
                    meta: { view: MoltentermCompanionView, [CompanionTargetMetaKey]: source.blockId } as MetaType,
                },
            },
        });
    }
    panels.push({
        id: "panel:sessions",
        group: "panels",
        label: t("palette.panels.sessions"),
        detail: t("palette.panels.sessionsDetail"),
        icon: "layer-group",
        keywords: paletteKeywords("panelSessions"),
        run: { kind: "widget", blockdef: { meta: { view: MoltentermSessionsView } } },
    });
    const viewOf = (e: PaletteEntry) => (e.run.kind === "widget" ? e.run.blockdef?.meta?.view : "");
    return panels
        .map((entry, order) => ({ entry, order, rank: panelKindRank(viewOf(entry)) }))
        .sort((a, b) => a.rank - b.rank || a.order - b.order)
        .map((r) => {
            const extra = PickerKeywords[viewOf(r.entry)];
            return extra == null
                ? r.entry
                : { ...r.entry, keywords: [...(r.entry.keywords ?? []), ...paletteKeywords(extra)] };
        });
}

// Each panel row of the picker shows how to reach it: the split's keys, the start of its name that selects it, Enter.
export function withKeyPaths(entries: PaletteEntry[], splitKeys: string): PaletteEntry[] {
    return entries.map((entry) => {
        if (entry.group !== "panels") {
            return entry;
        }
        const prefix = shortestSelectingPrefix(entries, entry, PickerGroupOrder);
        if (prefix == null) {
            return entry;
        }
        return { ...entry, keyPath: [splitKeys, prefix, "↵"].filter((p) => p).join("  ") };
    });
}

// The agents' own copy commands (FR-SHELL-017): Claude Code's /copy puts its last answer on the clipboard through
// OSC 52, which terminals keep accepting next to clean copy.
export function agentCopyEntries(): PaletteEntry[] {
    return AgentCopyProfiles.filter((p) => !!p.copyCommand).map((p) => ({
        id: `action:agentcopy:${p.id}`,
        group: "actions",
        label: t("palette.actions.agentCopy", { agent: p.name }),
        detail: t("palette.actions.agentCopyDetail", { command: p.copyCommand, agent: p.name }),
        icon: "copy",
        hint: p.copyCommand,
        keywords: paletteKeywords("agentCopy", "osc 52", p.id),
        run: { kind: "focusorigin" },
    }));
}

// "Open in <browser>" (FR-BRW-002), when a Chromium browser is installed and the tab has a browser panel.
export function browserEntries(browser: { id: string; name: string }, hasBrowserPanel: boolean): PaletteEntry[] {
    if (browser == null || !hasBrowserPanel) {
        return [];
    }
    return [
        {
            id: "action:openinbrowser",
            group: "actions",
            label: t("palette.actions.openInBrowser", { browser: browser.name }),
            detail: t("palette.actions.openInBrowserDetail"),
            icon: "arrow-up-right-from-square",
            cli: `molten open <url> --browser ${browser.id === "custom" ? "installed" : browser.id}`,
            keywords: paletteKeywords("openInBrowser", browser.id),
            run: { kind: "openinbrowser" },
        },
    ];
}

// "Update outdated terminals" (FR-SHELL-041), while some terminals started before MoltenTerm's update.
export function termUpdateEntries(count: number): PaletteEntry[] {
    if (!(count > 0)) {
        return [];
    }
    return [
        {
            id: "action:updateterminals",
            group: "actions",
            label: t("palette.actions.updateTerminals"),
            detail: updateAllDetail(count),
            icon: "arrows-rotate",
            keywords: paletteKeywords("updateTerminals"),
            run: { kind: "updateterminals" },
        },
    ];
}

const ViewPinEntries: Record<PinMove, { labelKey: string; icon: string }> = {
    here: { labelKey: "palette.actions.keepViewHere", icon: "thumbtack" },
    everywhere: { labelKey: "palette.actions.keepViewEverywhere", icon: "layer-group" },
    temporary: { labelKey: "palette.actions.makeViewTemporary", icon: "thumbtack-slash" },
};

// Keep or unpin the view on screen (#1652): the moves its menu offers, the keep shortcut on the one it makes.
export function viewPinEntries(viewPin: PaletteSourceInput["viewPin"]): PaletteEntry[] {
    return (viewPin?.moves ?? []).map((move) => ({
        id: `action:pinview:${move}`,
        group: "actions",
        label: t(ViewPinEntries[move].labelKey),
        icon: ViewPinEntries[move].icon,
        hint: move === viewPin.keepMove && viewPin.keepHint ? viewPin.keepHint : undefined,
        keywords: paletteKeywords("viewPin"),
        run: { kind: "pinview", move },
    }));
}

export function buildPaletteEntries(input: PaletteSourceInput): PaletteEntry[] {
    const folders = recentFolderList(input.folder, input.recentFolders, input.otherFolders);
    const panels =
        input.picker != null
            ? pickerPanelEntries(input.widgets, input.workspaceId, input.picker, input.projectLinked)
            : pickerPanelEntries(input.widgets, input.workspaceId, null, input.projectLinked);
    const actions = actionEntries(input.workspaces, input.projectLinked)
        // The panels list Sessions already (#1273).
        .filter((e) => e.id !== "action:sessions")
        .map((e) => (e.id === "action:shortcuts" && input.shortcutsHint ? { ...e, hint: input.shortcutsHint } : e));
    const entries = [
        ...agentEntries(input.presets, input.installedAgents),
        ...panels,
        ...folderEntries(folders, input.home),
        ...actions,
        ...(input.picker == null ? viewPinEntries(input.viewPin) : []),
        ...browserEntries(input.installedBrowser, input.hasBrowserPanel),
        ...termUpdateEntries(input.outdatedTerminals),
        ...agentCopyEntries(),
    ];
    return input.picker != null ? withKeyPaths(entries, input.picker.splitKeys) : entries;
}

export function paletteGroupTitles(folder: string, home: string): Partial<Record<PaletteGroupId, string>> {
    return folder ? { agents: t("palette.groups.agentsIn", { folder: tildePath(folder, home) }) } : {};
}

// The workspace's folder history, newest first, as stored in its meta (FR-SHELL-009).
export function pushRecentFolder(recent: string[], folder: string, max = MaxRecentFolders): string[] {
    const list = (recent ?? []).filter((f) => typeof f === "string" && f !== "" && f !== folder);
    if (!folder) {
        return list.slice(0, max);
    }
    return [folder, ...list].slice(0, max);
}
