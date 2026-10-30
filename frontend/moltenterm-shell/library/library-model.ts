// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The library behind the sidebar's bottom-left button (FR-SHELL-088): what is not in the sidebar, in one place. Its
// sections, and the rules each one shows its rows by.

import { agentStateUrgency, type AgentStateInfo, type AgentStatesData } from "../agent-state-model";
import type { AgentTab } from "../browser/browser-agent";
import type { BrowserTab } from "../browser/browser-model";
import type { PutAwayView } from "../reopen/reopen-model";
import type { SidebarGlyphName } from "../sidebar/sidebar-icons";
import type { ViewState } from "../sidebar/view-pins-model";

export type LibrarySection = "workspaces" | "panels" | "ai" | "putaway" | "settings";

export type LibrarySectionInfo = { id: LibrarySection; glyph: SidebarGlyphName; key: string; search?: boolean };

// The navigation, top to bottom; key names library.sections.<key>.{label,title,sub}.
export const LibrarySections: LibrarySectionInfo[] = [
    { id: "workspaces", glyph: "spaces", key: "workspaces" },
    { id: "panels", glyph: "panels", key: "panels" },
    { id: "ai", glyph: "ai", key: "ai", search: true },
    { id: "putaway", glyph: "archive", key: "putaway", search: true },
    { id: "settings", glyph: "gear", key: "settings" },
];

export const DefaultLibrarySection: LibrarySection = "workspaces";

// Suggest MoltenTerm copies this and nothing else: the public download page, never anything of the workspaces.
export const PublicDownloadUrl = "https://github.com/DiamondForgeFr/moltenterm/releases/latest";

export function suggestClipboardText(): string {
    return PublicDownloadUrl;
}

export type LibraryEscapeStep = "suggest" | "settingsBlock" | "close";

// What Escape closes, the innermost first: the Suggest popover, then a settings block open in the page (back to the
// blocks, #1406), then the library itself.
export function libraryEscapeStep(suggestOpen: boolean, settingsBlockOpen: boolean): LibraryEscapeStep {
    if (suggestOpen) {
        return "suggest";
    }
    if (settingsBlockOpen) {
        return "settingsBlock";
    }
    return "close";
}

export function librarySectionAt(section: LibrarySection, step: number): LibrarySection {
    const i = LibrarySections.findIndex((s) => s.id === section);
    const n = LibrarySections.length;
    return LibrarySections[((((i < 0 ? 0 : i) + step) % n) + n) % n].id;
}

// Each panel kind in plain words (library.panels.about.<key>); a kind without its own words shows the widget's.
const PanelAbout: Record<string, string> = {
    term: "terminal",
    preview: "files",
    "molten-browser": "browser",
    web: "browser",
    "molten-cicd": "cicd",
    "molten-reviews": "pilotage",
    sysinfo: "sysinfo",
    processviewer: "processes",
    "molten-project": "project",
    "molten-linemap": "linemap",
    "molten-sessions": "sessions",
};

export function panelAboutKey(view: string): string {
    const key = PanelAbout[view ?? ""];
    return key ? `library.panels.about.${key}` : null;
}

function normalize(text: string): string {
    return (text ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Every word of the query appears in one of the texts, accents and case aside.
export function matchesQuery(texts: string[], query: string): boolean {
    const words = normalize(query).split(/\s+/).filter(Boolean);
    if (words.length === 0) {
        return true;
    }
    const hay = normalize(texts.filter(Boolean).join(" "));
    return words.every((w) => hay.includes(w));
}

export function putAwayAgentNames(view: PutAwayView): string[] {
    return (view?.agents ?? []).map((a) => (a.name || a.agent || "").trim()).filter(Boolean);
}

// One browser panel's agent tabs, where it is.
export type SentPanel = {
    panelBlockId: string;
    tabId: string;
    workspaceId: string;
    agentTabs: AgentTab[];
    browserTabs: BrowserTab[];
};

export type SentRow = {
    key: string;
    title: string;
    url: string;
    agentName: string;
    workspaceId: string;
    tabId: string;
    panelBlockId: string;
    browserTabId: string;
    // shared: the developer shared it; else the agent opened it.
    shared: boolean;
    since: number;
};

// The pages agents hold now, from every browser panel: the ones the developer shared first, then the ones the agents
// opened, the most recent first in each. A tab the panel no longer has is left out.
export function sentToAiRows(panels: SentPanel[]): SentRow[] {
    const rows: SentRow[] = [];
    const seen = new Set<string>();
    for (const panel of panels ?? []) {
        for (const held of panel?.agentTabs ?? []) {
            const tab = (panel.browserTabs ?? []).find((b) => b.id === held?.browsertabid);
            const key = `${panel.panelBlockId}:${held?.browsertabid}`;
            if (tab == null || seen.has(key)) {
                continue;
            }
            seen.add(key);
            rows.push({
                key,
                title: (tab.title ?? "").trim() || tab.url,
                url: tab.url,
                agentName: (held.agentname ?? "").trim(),
                workspaceId: panel.workspaceId,
                tabId: panel.tabId,
                panelBlockId: panel.panelBlockId,
                browserTabId: tab.id,
                shared: held.origin === "shared",
                since: held.since ?? 0,
            });
        }
    }
    return rows.sort((a, b) => Number(b.shared) - Number(a.shared) || b.since - a.since || a.key.localeCompare(b.key));
}

// A workspace's agents, the ones that need the developer first (waiting, error, working, done, idle).
export function workspaceAgents(data: AgentStatesData, workspaceId: string): AgentStateInfo[] {
    return Object.values(data?.states ?? {})
        .filter((info) => info != null && info.workspaceid === workspaceId)
        .sort(
            (a, b) =>
                agentStateUrgency(b.state) - agentStateUrgency(a.state) ||
                (a.started ?? 0) - (b.started ?? 0) ||
                a.blockid.localeCompare(b.blockid)
        );
}

// An agent is live while it works, waits or errs; done and idle ones rest.
export function liveAgents(agents: AgentStateInfo[]): number {
    return (agents ?? []).filter((a) => agentStateUrgency(a.state) >= agentStateUrgency("working")).length;
}

// When something happened, as the rows say it: the time today, else the day and the time.
export function whenText(at: number, now: number, locale: string): string {
    if (!at) {
        return "";
    }
    const date = new Date(at);
    const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
    if (new Date(now).toDateString() === date.toDateString()) {
        return time;
    }
    const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(date);
    return `${day} · ${time}`;
}

// Panels › Add to on the active view (FR-SHELL-094): the question a pinned view asks first, or null when the panel is
// added at once (a temporary view). A view pinned everywhere becomes a temporary view here once changed (#1272).
export function libraryAddAsk(state: ViewState, projectTab: boolean): string {
    if (state === "everywhere") {
        return "library.panels.askEverywhere";
    }
    if (state === "workspace" || projectTab) {
        return "library.panels.askPinned";
    }
    return null;
}
