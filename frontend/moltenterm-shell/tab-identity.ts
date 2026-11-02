// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What a top tab shows before and as its name (FR-SHELL-056, DS-SHELL-098): a 14 px icon for the view of its first
// panel, or the agent's glyph when a coding agent runs in the tab; and, while the tab keeps Wave's generic name
// (T1, T2…), the title of its first panel instead. A name the user typed always wins.

import { MoltentermOnboardingView } from "../moltenterm-onboarding/onboarding-state";
import { AiIcon, terminalIcon } from "./ai-icon";
import { MoltentermBrowserView } from "./browser/browser-model";
import { MoltentermCompanionView } from "./companion/companion-model";
import { t } from "./i18n/i18n";
import { MoltentermLineMapView } from "./mission/line-map-model";
import { MoltentermPipelineView, PipelineTabIcon } from "./mission/pipeline-tab-model";
import { LegacyTimelineView, MoltentermProjectView } from "./project/project-model";
import { readReviewDoneMeta, ReviewDoneMeta, ReviewDoneMetaKey } from "./review/review-done";
import { MoltentermReviewAiView } from "./review/review-model";
import { MoltentermSessionsView } from "./sessions/sessions-model";
import { pathBaseName } from "./workspace-project";

export const DefaultTabIcon = "square";
export const DefaultAgentGlyph = "robot";
export { AiIcon };
// The CI/CD, Reviews, Review and Tips views' types, repeated here so this file stays free of the views' React code.
const CicdView = "molten-cicd";
const ReviewsView = "molten-reviews";
const ReviewView = "molten-review";
const TipsView = "tips";

// title is a dictionary key.
type ViewFacts = { icon: string; title: string };

// Every view the block registry knows (blockregistry.ts and views.ts) has an entry: a panel's title is never its raw
// view type (#642).
const Views: Record<string, ViewFacts> = {
    term: { icon: "terminal", title: "tabs.views.terminal" },
    preview: { icon: "folder-open", title: "tabs.views.files" },
    web: { icon: "globe", title: "tabs.views.web" },
    [MoltentermBrowserView]: { icon: "globe", title: "tabs.views.browser" },
    [MoltentermProjectView]: { icon: "gauge", title: "tabs.views.project" },
    [MoltentermSessionsView]: { icon: "layer-group", title: "tabs.views.sessions" },
    [MoltentermLineMapView]: { icon: "train-subway", title: "tabs.views.lineMap" },
    [CicdView]: { icon: "list-check", title: "tabs.views.cicd" },
    [ReviewsView]: { icon: "code-pull-request", title: "tabs.views.reviews" },
    [ReviewView]: { icon: "code-compare", title: "tabs.views.review" },
    [MoltentermPipelineView]: { icon: PipelineTabIcon, title: "tabs.views.pipeline" },
    [MoltentermCompanionView]: { icon: "book-open", title: "tabs.views.companion" },
    sysinfo: { icon: "chart-line", title: "tabs.views.system" },
    launcher: { icon: "shapes", title: "tabs.views.launcher" },
    waveconfig: { icon: "gear", title: "tabs.views.settings" },
    help: { icon: "circle-question", title: "tabs.views.help" },
    processviewer: { icon: "microchip", title: "tabs.views.processes" },
    codeeditor: { icon: "file-lines", title: "tabs.views.editor" },
    [MoltentermReviewAiView]: { icon: "sparkles", title: "tabs.views.reviewAi" },
    [TipsView]: { icon: "lightbulb", title: "tabs.views.tips" },
    [MoltentermOnboardingView]: { icon: "compass", title: "tabs.views.onboarding" },
    [LegacyTimelineView]: { icon: "gauge", title: "tabs.views.project" },
    waveai: { icon: "sparkles", title: "tabs.views.waveAi" },
    cpuplot: { icon: "chart-line", title: "tabs.views.system" },
    vdom: { icon: "shapes", title: "tabs.views.app" },
    tsunami: { icon: "shapes", title: "tabs.views.app" },
    aifilediff: { icon: "code-compare", title: "tabs.views.fileDiff" },
};

export type PanelMeta = {
    view?: string;
    file?: string;
    url?: string;
    connection?: string;
    "cmd:cwd"?: string;
    "display:icon"?: string;
    [ReviewDoneMetaKey]?: unknown;
};

// A Review tab whose PR is merged or closed shows a done mark (#686); null for any other tab.
export function panelReviewDone(meta: PanelMeta): ReviewDoneMeta {
    if (meta?.view !== ReviewView) {
        return null;
    }
    return readReviewDoneMeta(meta[ReviewDoneMetaKey]);
}

export function isGenericTabName(name: string): boolean {
    return /^T\d+$/.test((name ?? "").trim());
}

// agentRunning: an agent runs in this panel (any agent CLI). Only a terminal can hold one, so the flag changes no
// other view's icon.
export function panelIcon(meta: PanelMeta, agentRunning = false): string {
    if (meta == null) {
        return DefaultTabIcon;
    }
    if (meta.view === "term") {
        return terminalIcon(agentRunning);
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

// A terminal is named after its folder (the home folder reads ~), a file view after its file, a web page after its
// host; MoltenTerm views and the other Wave views after the view. A view without an entry gives no title, never its raw
// view type: the caller shows its own generic name (the radar's "Panel", Wave's tab name).
export function panelTitle(meta: PanelMeta, homeDir = ""): string {
    if (meta == null) {
        return "";
    }
    const view = meta.view ?? "";
    const facts = Views[view];
    const viewTitle = facts ? t(facts.title) : "";
    if (view === "term") {
        const remote = meta.connection && meta.connection !== "local" ? meta.connection : "";
        const cwd = (meta["cmd:cwd"] ?? "").replace(/[/\\]+$/, "");
        const home = (homeDir ?? "").replace(/[/\\]+$/, "");
        const folder = !remote && home && cwd === home ? "~" : pathBaseName(cwd);
        return folder || remote || viewTitle;
    }
    if (view === "preview") {
        return pathBaseName(meta.file ?? "") || viewTitle;
    }
    if (view === "web" || view === MoltentermBrowserView) {
        return hostOf(meta.url ?? "") || viewTitle;
    }
    return viewTitle;
}

// A view still under Wave's generic name is named after its main panel's kind and place (#1669): "Files · roman" and
// "Terminal · roman" tell apart two views of the same folder, which the place alone did not.
export function panelViewName(meta: PanelMeta, homeDir = ""): string {
    if (meta == null) {
        return "";
    }
    const facts = Views[meta.view ?? ""];
    const kind = facts ? t(facts.title) : "";
    const place = panelTitle(meta, homeDir);
    if (!kind || !place || place === kind) {
        return place || kind;
    }
    return t("tabs.viewName", { kind, place });
}

// The name the tab shows: the user's, else its first panel's kind and place, else Wave's own.
export function tabDisplayName(name: string, firstPanel: PanelMeta, homeDir = ""): string {
    if (!isGenericTabName(name)) {
        return name ?? "";
    }
    return panelViewName(firstPanel, homeDir) || name;
}

export type ViewNameEntry = { id: string; name: string; derived: boolean };

// Views of one workspace, in its order: a derived name another view already shows takes a number ("Terminal · roman
// 2"), so a lone view never carries one; a name the user typed (derived false) is never numbered.
export function numberDuplicateViewNames(entries: ViewNameEntry[]): Map<string, string> {
    const out = new Map<string, string>();
    const seen = new Map<string, number>();
    for (const e of entries) {
        if (!e.derived) {
            seen.set(e.name, Math.max(seen.get(e.name) ?? 0, 1));
        }
    }
    for (const e of entries) {
        if (!e.derived || !e.name) {
            out.set(e.id, e.name);
            continue;
        }
        const count = (seen.get(e.name) ?? 0) + 1;
        seen.set(e.name, count);
        out.set(e.id, count === 1 ? e.name : t("tabs.viewNameNumbered", { name: e.name, number: count }));
    }
    return out;
}
