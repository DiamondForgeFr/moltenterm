// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The views a new workspace starts with (FR-SHELL-092, DS-SHELL-132): wavesrv makes them from the app:newworkspaceviews
// template when a workspace is created (pkg/wcore/moltenterm_workspaceviews.go), pinned in that workspace and without
// panels; a window opens their panels the first time it shows them. Their names are dictionary keys until the
// developer renames them. The template's editing rules for Preferences, as pure functions tested without the app.

export const NewWorkspaceViewsKey = "app:newworkspaceviews";
// must match pkg/wcore/moltenterm_workspaceviews.go
export const ViewPendingMetaKey = "molten:viewpending";
export const ViewNameKeyMetaKey = "molten:viewnamekey";
export const DefaultViewNameKey = "workspaceViews.names.view";
// must match ViewNameKeyPrefix in pkg/wconfig/moltenterm_workspaceviews.go
export const ViewNameKeyPrefix = "workspaceViews.names.";
// must match MaxGlyphIcons in sidebar/view-menu-model.ts
const MaxTemplateGlyphIcons = 3;

// The panels a template view may hold, in the order Preferences offers them. must match the kinds of
// pkg/wcore/moltenterm_workspaceviews.go
export const WorkspaceViewPanels: { kind: string; labelKey: string; icon: string }[] = [
    { kind: "agent", labelKey: "workspaceViews.panels.agent", icon: "robot" },
    { kind: "terminal", labelKey: "workspaceViews.panels.terminal", icon: "terminal" },
    { kind: "browser", labelKey: "workspaceViews.panels.browser", icon: "globe" },
    { kind: "files", labelKey: "workspaceViews.panels.files", icon: "folder-open" },
    { kind: "project", labelKey: "workspaceViews.panels.project", icon: "gauge" },
    { kind: "integration", labelKey: "workspaceViews.panels.integration", icon: "code-pull-request" },
    { kind: "cicd", labelKey: "workspaceViews.panels.cicd", icon: "list-check" },
    { kind: "linemap", labelKey: "workspaceViews.panels.lineMap", icon: "train-subway" },
];

const KnownKinds = new Set(WorkspaceViewPanels.map((p) => p.kind));

export type TemplateView = { name?: string; namekey?: string; panels: string[] };

type Translate = (key: string, vars?: Record<string, string | number>) => string;

// wavesrv names a Review view "Review #N" in English when it makes it (pkg/molten/review/tab.go TabName), and the name
// stays stored that way, in views made before and after: it is worded through review.view.viewNamePr, so French reads
// "Revue #17" (#1322). A name the developer typed that happens to match reads the same, which is harmless.
const ReviewViewNameRe = /^Review #(\d+)$/;

function reviewViewName(name: string, tr: Translate): string {
    const number = ReviewViewNameRe.exec(name ?? "")?.[1];
    return number == null ? null : tr("review.view.viewNamePr", { number });
}

// The name a view shows: the interface language's for a name wavesrv stored as a key, the developer's otherwise. A
// rename replaces the key with the typed text, which then shows as typed.
export function viewShownName(name: string, meta: Record<string, any>, tr: Translate): string {
    const key = meta?.[ViewNameKeyMetaKey];
    if (typeof key === "string" && key !== "" && name === key) {
        return tr(key);
    }
    return reviewViewName(name, tr) ?? name ?? "";
}

// A view's name that comes without its tab's meta (a wavesrv message, a list of terminals, a closed view): a name
// still stored as its key is worded like the sidebar words it, a key this version lacks as "View" (#1311).
export function viewNameText(name: string, tr: Translate): string {
    if (typeof name !== "string" || !name.startsWith(ViewNameKeyPrefix)) {
        return reviewViewName(name, tr) ?? name ?? "";
    }
    const worded = tr(name);
    if (worded && worded !== name) {
        return worded;
    }
    return tr(DefaultViewNameKey);
}

// The template as stored, cleaned: views without a known panel and unknown panels left out. A missing value reads as
// no view (wavesrv's defaults always carry one; an empty list is dropped from the settings it sends).
export function readTemplate(value: unknown): TemplateView[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const rtn: TemplateView[] = [];
    for (const v of value) {
        if (v == null || typeof v !== "object") {
            continue;
        }
        const panels = (Array.isArray(v.panels) ? v.panels : []).filter(
            (p: unknown) => typeof p === "string" && KnownKinds.has(p)
        );
        if (panels.length === 0) {
            continue;
        }
        const view: TemplateView = { panels };
        if (typeof v.name === "string" && v.name.trim() !== "") {
            view.name = v.name.trim();
        } else if (typeof v.namekey === "string" && v.namekey !== "") {
            view.namekey = v.namekey;
        }
        rtn.push(view);
    }
    return rtn;
}

export function templateViewName(view: TemplateView, tr: Translate): string {
    if (view?.name) {
        return view.name;
    }
    return tr(view?.namekey || DefaultViewNameKey);
}

function moved<T>(list: T[], i: number, delta: number): T[] {
    const j = i + delta;
    if (i < 0 || i >= list.length || j < 0 || j >= list.length) {
        return list;
    }
    const rtn = [...list];
    [rtn[i], rtn[j]] = [rtn[j], rtn[i]];
    return rtn;
}

// The item at `from` put at index `to` of the result, the others keeping their order (a drag's drop).
function placed<T>(list: T[], from: number, to: number): T[] {
    if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) {
        return list;
    }
    const rtn = [...list];
    const [item] = rtn.splice(from, 1);
    rtn.splice(to, 0, item);
    return rtn;
}

function withView(views: TemplateView[], i: number, change: (v: TemplateView) => TemplateView): TemplateView[] {
    if (i < 0 || i >= views.length) {
        return views;
    }
    return views.map((v, at) => (at === i ? change(v) : v));
}

// A new view: one terminal, named by the typed name.
export function addView(views: TemplateView[], name: string): TemplateView[] {
    const typed = (name ?? "").trim();
    const view: TemplateView = typed ? { name: typed, panels: ["terminal"] } : { panels: ["terminal"] };
    return [...views, view];
}

export function removeView(views: TemplateView[], i: number): TemplateView[] {
    return views.filter((_, at) => at !== i);
}

export function moveView(views: TemplateView[], i: number, delta: number): TemplateView[] {
    return moved(views, i, delta);
}

// A tile dropped at another tile's place (FR-SHELL-106).
export function placeView(views: TemplateView[], from: number, to: number): TemplateView[] {
    return placed(views, from, to);
}

export function placePanel(views: TemplateView[], i: number, from: number, to: number): TemplateView[] {
    return withView(views, i, (v) => ({ ...v, panels: placed(v.panels, from, to) }));
}

// The panel icons a template view's tile shows, as the sidebar draws the view once created: up to three, separated.
export function templateViewIcons(view: TemplateView): string[] {
    const icons = (view?.panels ?? []).map((k) => WorkspaceViewPanels.find((p) => p.kind === k)?.icon).filter(Boolean);
    return icons.slice(0, MaxTemplateGlyphIcons);
}

export function addPanelKind(views: TemplateView[], i: number, kind: string): TemplateView[] {
    if (!KnownKinds.has(kind)) {
        return views;
    }
    return withView(views, i, (v) => ({ ...v, panels: [...v.panels, kind] }));
}

// A rename stores the typed text; an empty one changes nothing, so a view never loses its name.
export function renameView(views: TemplateView[], i: number, name: string): TemplateView[] {
    const typed = (name ?? "").trim();
    if (!typed) {
        return views;
    }
    return withView(views, i, (v) => ({ name: typed, panels: v.panels }));
}

// The panel added to a view: the first kind it does not hold yet, else a terminal.
export function nextPanelKind(view: TemplateView): string {
    return WorkspaceViewPanels.find((p) => !view.panels.includes(p.kind))?.kind ?? "terminal";
}

export function addPanel(views: TemplateView[], i: number): TemplateView[] {
    return withView(views, i, (v) => ({ ...v, panels: [...v.panels, nextPanelKind(v)] }));
}

// A view keeps at least one panel: removing its last one removes nothing (Remove the view is there for that).
export function removePanel(views: TemplateView[], i: number, p: number): TemplateView[] {
    return withView(views, i, (v) =>
        v.panels.length <= 1 ? v : { ...v, panels: v.panels.filter((_, at) => at !== p) }
    );
}

export function movePanel(views: TemplateView[], i: number, p: number, delta: number): TemplateView[] {
    return withView(views, i, (v) => ({ ...v, panels: moved(v.panels, p, delta) }));
}

export function replacePanel(views: TemplateView[], i: number, p: number, kind: string): TemplateView[] {
    if (!KnownKinds.has(kind)) {
        return views;
    }
    return withView(views, i, (v) => ({ ...v, panels: v.panels.map((k, at) => (at === p ? kind : k)) }));
}
