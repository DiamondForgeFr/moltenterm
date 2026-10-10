// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What a top tab shows before and as its name (FR-SHELL-056, DS-SHELL-098): a 14 px icon for the view of its first
// panel, or the agent's glyph when a coding agent runs in the tab; and, while the tab keeps Wave's generic name
// (T1, T2…), the title of its first panel instead. A name the user typed always wins.

import { MoltentermBrowserView } from "./browser/browser-model";
import { MoltentermCompanionView } from "./companion/companion-model";
import { MoltentermLineMapView } from "./mission/line-map-model";
import { MoltentermProjectView } from "./project/project-model";
import { MoltentermSessionsView } from "./sessions/sessions-model";
import { pathBaseName } from "./workspace-project";

export const DefaultTabIcon = "square";
export const DefaultAgentGlyph = "robot";
// The CI/CD view's type, repeated here so this file stays free of the view's React code.
const CicdView = "molten-cicd";

type ViewFacts = { icon: string; title: string };

const Views: Record<string, ViewFacts> = {
    term: { icon: "terminal", title: "Terminal" },
    preview: { icon: "folder-open", title: "Files" },
    web: { icon: "globe", title: "Web" },
    [MoltentermBrowserView]: { icon: "globe", title: "Browser" },
    [MoltentermProjectView]: { icon: "gauge", title: "Project" },
    [MoltentermSessionsView]: { icon: "layer-group", title: "Sessions" },
    [MoltentermLineMapView]: { icon: "train-subway", title: "Line map" },
    [CicdView]: { icon: "list-check", title: "CI/CD" },
    [MoltentermCompanionView]: { icon: "book-open", title: "Companion" },
    sysinfo: { icon: "chart-line", title: "System" },
    launcher: { icon: "shapes", title: "Launcher" },
    waveconfig: { icon: "gear", title: "Settings" },
    help: { icon: "circle-question", title: "Help" },
    processviewer: { icon: "microchip", title: "Processes" },
    codeeditor: { icon: "file-lines", title: "Editor" },
};

export type PanelMeta = {
    view?: string;
    file?: string;
    url?: string;
    connection?: string;
    "cmd:cwd"?: string;
    "display:icon"?: string;
};

export function isGenericTabName(name: string): boolean {
    return /^T\d+$/.test((name ?? "").trim());
}

export function panelIcon(meta: PanelMeta): string {
    if (meta == null) {
        return DefaultTabIcon;
    }
    return Views[meta.view ?? ""]?.icon ?? DefaultTabIcon;
}

function hostOf(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return "";
    }
}

function capitalize(text: string): string {
    return text ? text[0].toUpperCase() + text.slice(1) : "";
}

// A terminal is named after its folder (the home folder reads ~), a file view after its file, a web page after its
// host; MoltenTerm views and the other Wave views after the view.
export function panelTitle(meta: PanelMeta, homeDir = ""): string {
    if (meta == null) {
        return "";
    }
    const view = meta.view ?? "";
    const facts = Views[view];
    if (view === "term") {
        const remote = meta.connection && meta.connection !== "local" ? meta.connection : "";
        const cwd = (meta["cmd:cwd"] ?? "").replace(/[/\\]+$/, "");
        const home = (homeDir ?? "").replace(/[/\\]+$/, "");
        const folder = !remote && home && cwd === home ? "~" : pathBaseName(cwd);
        return folder || remote || facts.title;
    }
    if (view === "preview") {
        return pathBaseName(meta.file ?? "") || facts.title;
    }
    if (view === "web" || view === MoltentermBrowserView) {
        return hostOf(meta.url ?? "") || facts.title;
    }
    return facts?.title ?? capitalize(view);
}

// The name the tab shows: the user's, else its first panel's title, else Wave's own.
export function tabDisplayName(name: string, firstPanel: PanelMeta, homeDir = ""): string {
    if (!isGenericTabName(name)) {
        return name ?? "";
    }
    return panelTitle(firstPanel, homeDir) || name;
}

// The agent's glyph is its preset's icon (agent@claude, agent@codex in presets/agents.json).
export function agentGlyph(agent: string, presets: Record<string, Record<string, unknown>>): string {
    const icon = presets?.[`agent@${agent ?? ""}`]?.["display:icon"];
    return typeof icon === "string" && icon !== "" ? icon : DefaultAgentGlyph;
}
