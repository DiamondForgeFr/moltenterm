// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The palette's entries (FR-SHELL-013), from configuration and the workspace: agent presets (presets "agent@<id>"),
// panels (widgets.json), recent folders (FR-SHELL-009) and workspace actions. Pure, so the rules are tested without
// the app.

import { CompanionTargetMetaKey, MoltentermCompanionView } from "../companion/companion-model";
import { MoltentermProjectView } from "../project/project-model";
import { MoltentermSessionsView } from "../sessions/sessions-model";
import { panelKindRank, terminalBlockDefFrom } from "../split/split-model";
import { AgentCopyProfiles } from "../term-copy/agent-copy-profiles";
import { updateAllDetail } from "../termupdate/termupdate-model";
import { PaletteEntry, PaletteGroupId, PickerGroupOrder, shortestSelectingPrefix } from "./palette-model";

// Agent presets live with Wave's presets, under their own prefix: defaults in pkg/wconfig/defaultconfig/presets/
// agents.json, the user's in presets.json or presets/*.json of the config folder (a mod can ship one later).
export const AgentPresetPrefix = "agent@";
export const AgentCommandKey = "agent:command";
export const DefaultAgentIcon = "robot";

export const MaxRecentFolders = 8;

// Wave's widget labels are lowercase words made for small tiles; the palette names the built-in panels in full.
const PanelNames: Record<string, string> = {
    "defwidget@terminal": "Terminal",
    "defwidget@files": "Files",
    "defwidget@web": "Browser",
    "defwidget@cicd": "CI/CD",
    "defwidget@sysinfo": "System info",
    "defwidget@processviewer": "Processes",
};

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

// Quotes an argument for a POSIX shell only when it needs it.
export function shellQuote(arg: string): string {
    if (arg !== "" && /^[A-Za-z0-9_./~:@%+=,-]+$/.test(arg)) {
        return arg;
    }
    return `'${arg.replace(/'/g, `'\\''`)}'`;
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

// A path as a shell argument, with ~ for the home folder left outside the quotes so the shell still expands it.
export function shellPath(path: string, home: string): string {
    const short = tildePath(path, home);
    if (short === "~") {
        return short;
    }
    if (short.startsWith("~/")) {
        return "~/" + shellQuote(short.slice(2));
    }
    return shellQuote(short);
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
            icon: str(meta["display:icon"]) || DefaultAgentIcon,
            color: str(meta["display:color"]),
            order: num(meta["display:order"], 0),
        });
    }
    rtn.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
    return rtn;
}

export function agentEntries(presets: { [key: string]: MetaType }): PaletteEntry[] {
    return readAgentPresets(presets).map((p) => ({
        id: `agent:${p.id}`,
        group: "agents",
        label: p.name,
        icon: p.icon,
        color: p.color || undefined,
        cli: p.command,
        keywords: ["agent", p.id],
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
            label: PanelNames[key] ?? (w.label || key),
            detail: w.description || undefined,
            icon: w.icon || "browser",
            color: w.color || undefined,
            cli: `wsh launch ${shellQuote(key)}`,
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
        cli: `wsh term ${shellPath(path, home)}`,
        run: { kind: "folder", path },
    }));
}

export function actionEntries(workspaces: PaletteWorkspace[], projectLinked = false): PaletteEntry[] {
    const rtn: PaletteEntry[] = [];
    if (projectLinked) {
        rtn.push({
            id: "action:projecttab",
            group: "actions",
            label: "Project tab",
            detail: "where the project stands: agents, branches, CI, releases, actions",
            icon: "gauge",
            keywords: ["mission control", "dashboard", "project", "home"],
            run: { kind: "projecttab" },
        });
    }
    rtn.push(
        {
            id: "action:newtab",
            group: "actions",
            label: "New tab",
            icon: "plus",
            hint: "⌘T",
            run: { kind: "newtab" },
        },
        {
            id: "action:newworkspace",
            group: "actions",
            label: "New workspace",
            icon: "layer-group",
            run: { kind: "newworkspace" },
        },
        {
            id: "action:editworkspace",
            group: "actions",
            label: "Edit workspace…",
            detail: "name, icon, colour, project, folder",
            icon: "pencil",
            keywords: ["workspace", "rename", "icon", "colour", "color", "settings", "delete", "reset"],
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
            label: `Switch to ${ws.name}`,
            icon: ws.icon || "circle",
            color: ws.color || undefined,
            badge: { icon: ws.icon || "circle", color: ws.color ?? "", image: ws.image ?? "", logo: ws.logo ?? "" },
            keywords: ["workspace", ws.name],
            run: { kind: "switchworkspace", workspaceId: ws.id },
        });
    }
    rtn.push({
        id: "action:gettingstarted",
        group: "actions",
        label: "Getting started",
        detail: "your agent, a first morph, your project",
        icon: "compass",
        keywords: ["onboarding", "setup", "welcome", "tour", "first run"],
        run: { kind: "gettingstarted" },
    });
    rtn.push({
        id: "action:sessions",
        group: "actions",
        label: "Sessions",
        detail: "terminals and agents still running, local and SSH",
        icon: "layer-group",
        keywords: ["sessions", "durable", "running", "agents", "ssh", "detached", "jobs", "processes"],
        run: { kind: "sessions" },
    });
    rtn.push({
        id: "action:settings",
        group: "actions",
        label: "Settings",
        icon: "gear",
        cli: "wsh editconfig",
        keywords: ["config", "preferences"],
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
        label: "Keyboard shortcuts",
        icon: "keyboard",
        hint: hint || undefined,
        keywords: ["keys", "keybindings", "hotkeys", "help", "cheat sheet"],
        run: { kind: "shortcuts" },
    };
}

// The panel kinds a split's picker offers first (DS-SHELL-066), in a fixed order: the configured panels, with the
// terminal and the file browser opened where the source panel is, then Mission Control's overview when the workspace
// is linked to a project, the source terminal's companion, and Sessions.
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
    if (projectLinked) {
        panels.push({
            id: "panel:missioncontrol",
            group: "panels",
            label: "Mission Control",
            detail: "the project overview",
            icon: "gauge",
            keywords: ["project", "overview", "dashboard"],
            run: { kind: "widget", blockdef: { meta: { view: MoltentermProjectView } } },
        });
    }
    if (sourceMeta.view === "term" && source?.blockId) {
        panels.push({
            id: "panel:companion",
            group: "panels",
            label: "Companion",
            detail: "the agent of this terminal",
            icon: "book-open",
            shortcut: source.companionKeys || undefined,
            keywords: ["agent", "companion"],
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
        label: "Sessions",
        detail: "terminals and agents still running",
        icon: "layer-group",
        keywords: ["durable", "running", "ssh"],
        run: { kind: "widget", blockdef: { meta: { view: MoltentermSessionsView } } },
    });
    const viewOf = (e: PaletteEntry) => (e.run.kind === "widget" ? e.run.blockdef?.meta?.view : "");
    return panels
        .map((entry, order) => ({ entry, order, rank: panelKindRank(viewOf(entry)) }))
        .sort((a, b) => a.rank - b.rank || a.order - b.order)
        .map((r) => r.entry);
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
        label: `Copy ${p.name}'s last answer`,
        detail: `type ${p.copyCommand} in ${p.name}, it reaches the clipboard through OSC 52`,
        icon: "copy",
        hint: p.copyCommand,
        keywords: ["clipboard", "copy", "osc 52", p.id],
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
            label: `Open in ${browser.name}`,
            detail: "the browser panel's page, with your sessions and extensions",
            icon: "arrow-up-right-from-square",
            cli: `molten open <url> --browser ${browser.id === "custom" ? "installed" : browser.id}`,
            keywords: ["browser", "web", "hand off", "external", browser.id],
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
            label: "Update outdated terminals",
            detail: updateAllDetail(count),
            icon: "arrows-rotate",
            keywords: ["update", "refresh", "restart", "outdated", "shell", "terminal", "path", "launcher"],
            run: { kind: "updateterminals" },
        },
    ];
}

export function buildPaletteEntries(input: PaletteSourceInput): PaletteEntry[] {
    const folders = recentFolderList(input.folder, input.recentFolders, input.otherFolders);
    const panels =
        input.picker != null
            ? pickerPanelEntries(input.widgets, input.workspaceId, input.picker, input.projectLinked)
            : panelEntries(input.widgets, input.workspaceId);
    const actions = actionEntries(input.workspaces, input.projectLinked)
        // The picker lists Sessions with the panels already.
        .filter((e) => input.picker == null || e.id !== "action:sessions")
        .map((e) => (e.id === "action:shortcuts" && input.shortcutsHint ? { ...e, hint: input.shortcutsHint } : e));
    const entries = [
        ...agentEntries(input.presets),
        ...panels,
        ...folderEntries(folders, input.home),
        ...actions,
        ...browserEntries(input.installedBrowser, input.hasBrowserPanel),
        ...termUpdateEntries(input.outdatedTerminals),
        ...agentCopyEntries(),
    ];
    return input.picker != null ? withKeyPaths(entries, input.picker.splitKeys) : entries;
}

export function paletteGroupTitles(folder: string, home: string): Partial<Record<PaletteGroupId, string>> {
    return folder ? { agents: `Agents in ${tildePath(folder, home)}` } : {};
}

// The workspace's folder history, newest first, as stored in its meta (FR-SHELL-009).
export function pushRecentFolder(recent: string[], folder: string, max = MaxRecentFolders): string[] {
    const list = (recent ?? []).filter((f) => typeof f === "string" && f !== "" && f !== folder);
    if (!folder) {
        return list.slice(0, max);
    }
    return [folder, ...list].slice(0, max);
}
