// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Contexts group workspaces by activity (FR-SHELL-158, DS-SHELL-157, #2476). The list is the client's meta
// "molten:contexts"; a workspace is in the context its own meta "molten:context" names, and a workspace with no id, or
// one whose context is gone, is in the first context. A window has no context of its own: it is the context of the
// workspace it shows. These are the rules the windows and Electron main share, apart from any component. Their Go twin
// is pkg/molten/contexts.

import type { TFunction } from "../i18n/i18n";

// must match pkg/molten/contexts/contexts.go
export const ContextsMetaKey = "molten:contexts";
export const WorkspaceContextMetaKey = "molten:context";
export const ContextsRoute = "molten:contexts";
export const ContextCreateCommand = "contextcreate";
export const ContextUpdateCommand = "contextupdate";
export const ContextDeleteCommand = "contextdelete";
export const ContextAssignCommand = "contextassign";
export const ContextTouchCommand = "contexttouch";
export const ContextLandingCommand = "contextlanding";
export const DefaultContextId = "workshop";
export const DefaultContextEmblem = "hammer";
export const FallbackContextEmblem = "folder";
export const ContextNameMaxChars = 60;
export const ContextDescriptionMaxChars = 280;

export type ContextInfo = {
    id: string;
    // Empty on the default context until it is renamed: the interface shows its own language's name.
    name?: string;
    description?: string;
    // A Lucide icon's name in kebab case.
    emblem?: string;
    // The workspace this context last showed: where choosing it lands.
    last?: string;
    // The outer bound of its workspaces' folders (#2516): context ⊃ workspace ⊃ project (workspace-project.ts).
    folder?: string;
};

export function defaultContext(): ContextInfo {
    return { id: DefaultContextId, emblem: DefaultContextEmblem };
}

// The stored list; a missing or unreadable one, or one with no usable entry, is the default context alone.
export function readContexts(clientMeta: Record<string, any>): ContextInfo[] {
    const raw = clientMeta?.[ContextsMetaKey];
    if (!Array.isArray(raw)) {
        return [defaultContext()];
    }
    const rtn: ContextInfo[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
        const id = typeof item?.id === "string" ? item.id : "";
        if (!id || seen.has(id)) {
            continue;
        }
        seen.add(id);
        rtn.push({
            id,
            name: typeof item.name === "string" ? item.name : "",
            description: typeof item.description === "string" ? item.description : "",
            emblem: typeof item.emblem === "string" ? item.emblem : "",
            last: typeof item.last === "string" ? item.last : "",
            folder: typeof item.folder === "string" ? item.folder : "",
        });
    }
    return rtn.length > 0 ? rtn : [defaultContext()];
}

// The id of the context a workspace is in.
export function contextIdOf(contexts: readonly ContextInfo[], workspaceMeta: Record<string, any>): string {
    const id = workspaceMeta?.[WorkspaceContextMetaKey];
    if (typeof id === "string" && contexts.some((c) => c.id === id)) {
        return id;
    }
    return contexts[0]?.id ?? DefaultContextId;
}

// The folder of the context a workspace is in; "" when it has none (#2516).
export function contextFolderOf(contexts: readonly ContextInfo[], workspaceMeta: Record<string, any>): string {
    const id = contextIdOf(contexts, workspaceMeta);
    return contexts.find((c) => c.id === id)?.folder ?? "";
}

export function isDefaultContext(context: ContextInfo): boolean {
    return context?.id === DefaultContextId && !context.name;
}

// The name on screen: the context's own, or "My workshop" in the interface language for the default one.
export function contextShownName(context: ContextInfo, t: TFunction): string {
    if (context == null) {
        return "";
    }
    return context.name || (context.id === DefaultContextId ? t("contexts.defaultName") : "");
}

export function contextShownEmblem(context: ContextInfo): string {
    return context?.emblem || (context?.id === DefaultContextId ? DefaultContextEmblem : FallbackContextEmblem);
}

// What the choice of a context knows of a workspace.
export type ContextWorkspace = {
    id: string;
    contextId?: string;
    name: string;
    color: string;
    saved: boolean;
    // The one this window shows.
    active: boolean;
    // Shown by a window, this one included.
    open: boolean;
};

export function workspacesOfContext<T extends { contextId?: string }>(entries: readonly T[], contextId: string): T[] {
    return entries.filter((e) => e.contextId === contextId);
}

// The rail entries the window's switcher lists: its context's, and the workspace on screen even when it is not saved
// yet or its context is not known yet. With no context given, every entry.
export function entriesOfContext<T extends { contextId?: string; active?: boolean }>(
    entries: readonly T[],
    contextId: string
): T[] {
    if (!contextId) {
        return [...entries];
    }
    return entries.filter((e) => e.active || e.contextId === contextId);
}

// Where choosing a context lands: the workspace it last showed, else its first one, a workspace no other window shows
// coming first; one that is only shown elsewhere is the last resort (choosing it brings that window forward). null
// when the context holds no workspace.
export function landingWorkspace(
    contextId: string,
    entries: readonly ContextWorkspace[],
    last: string
): ContextWorkspace {
    const own = entries.filter((e) => e.contextId === contextId && (e.saved || e.active));
    if (own.length === 0) {
        return null;
    }
    const free = (e: ContextWorkspace) => !e.open || e.active;
    const remembered = own.find((e) => e.id === last);
    if (remembered != null && free(remembered)) {
        return remembered;
    }
    return own.find(free) ?? remembered ?? own[0];
}

// The workspace "Open a context in a new window" opens on: one no window shows; null when every workspace of the
// context is shown, and the caller makes one.
export function freeWorkspaceOfContext(
    contextId: string,
    entries: readonly ContextWorkspace[],
    last: string
): ContextWorkspace {
    const own = entries.filter((e) => e.contextId === contextId && e.saved && !e.open);
    return own.find((e) => e.id === last) ?? own[0] ?? null;
}

// The right-hand hint of a ribbon of the menu: where the window is, the agents that wait in the context, or how many
// workspaces it holds.
export type ContextHint = { kind: "here" } | { kind: "waiting"; count: number } | { kind: "workspaces"; count: number };

export function contextHint(here: boolean, waiting: number, workspaces: number): ContextHint {
    if (here) {
        return { kind: "here" };
    }
    if (waiting > 0) {
        return { kind: "waiting", count: waiting };
    }
    return { kind: "workspaces", count: workspaces };
}

export type ContextRibbon = {
    context: ContextInfo;
    name: string;
    emblem: string;
    here: boolean;
    waiting: number;
    workspaces: number;
    // The workspace choosing the ribbon lands on; its colour paints the ribbon. null: the context holds none yet.
    landing: ContextWorkspace;
    hint: ContextHint;
};

// One ribbon per context, in the list's order, for the menu. waitingIn counts the agents that wait in a workspace.
export function makeRibbons(
    contexts: readonly ContextInfo[],
    entries: readonly ContextWorkspace[],
    currentId: string,
    waitingIn: (workspaceId: string) => number,
    t: TFunction
): ContextRibbon[] {
    return contexts.map((context) => {
        const members = entries.filter((e) => e.contextId === context.id && (e.saved || e.active));
        const here = context.id === currentId;
        const waiting = here ? 0 : members.reduce((sum, e) => sum + waitingIn(e.id), 0);
        return {
            context,
            name: contextShownName(context, t),
            emblem: contextShownEmblem(context),
            here,
            waiting,
            workspaces: members.length,
            landing: landingWorkspace(context.id, entries, context.last ?? ""),
            hint: contextHint(here, waiting, members.length),
        };
    });
}

// The agents that wait in a context other than the window's: the dot on the ribbon.
export function waitingElsewhere(ribbons: readonly ContextRibbon[]): number {
    return ribbons.reduce((sum, r) => sum + (r.here ? 0 : r.waiting), 0);
}

// The title of the window: the application, the context, then the tab (FR-SHELL-158).
export function windowTitleWithContext(app: string, contextName: string, tabName: string): string {
    const head = contextName ? `${app} — ${contextName}` : app;
    return tabName ? `${head} - ${tabName}` : head;
}

// The checklist of the Manage dialog: every saved workspace, and where it is.
export type ChecklistRow = {
    id: string;
    name: string;
    color: string;
    checked: boolean;
    // The name of the context the workspace is in when it is not this one.
    elsewhere: string;
};

export function makeChecklist(
    contextId: string,
    contexts: readonly ContextInfo[],
    entries: readonly ContextWorkspace[],
    t: TFunction
): ChecklistRow[] {
    return entries
        .filter((e) => e.saved || e.active)
        .map((e) => {
            const own = contexts.find((c) => c.id === e.contextId);
            return {
                id: e.id,
                name: e.name,
                color: e.color,
                checked: e.contextId === contextId,
                elsewhere: e.contextId === contextId ? "" : contextShownName(own, t),
            };
        });
}
