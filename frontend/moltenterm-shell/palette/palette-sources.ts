// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The palette's entries (FR-SHELL-013), from configuration and the workspace: agent presets (presets "agent@<id>"),
// panels (widgets.json), recent folders (FR-SHELL-009) and workspace actions. Pure, so the rules are tested without
// the app.

import { AgentCopyProfiles } from "../term-copy/agent-copy-profiles";
import { PaletteEntry, PaletteGroupId } from "./palette-model";

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
    "defwidget@web": "Web",
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
    return rtn;
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

export function buildPaletteEntries(input: PaletteSourceInput): PaletteEntry[] {
    const folders = recentFolderList(input.folder, input.recentFolders, input.otherFolders);
    return [
        ...agentEntries(input.presets),
        ...panelEntries(input.widgets, input.workspaceId),
        ...folderEntries(folders, input.home),
        ...actionEntries(input.workspaces, input.projectLinked),
        ...browserEntries(input.installedBrowser, input.hasBrowserPanel),
        ...agentCopyEntries(),
    ];
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
