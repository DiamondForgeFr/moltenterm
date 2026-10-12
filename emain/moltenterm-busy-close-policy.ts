// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What a window close, a quit, a workspace delete or a switch away from an unsaved workspace stops (FR-SHELL-062,
// DS-SHELL-109), decided without Electron so it can be tested. The renderer names what runs in those terminals
// (FR-SHELL-061's reader); main only says which terminals the action ends.

export const BusyAskAckTimeoutMs = 1500;

export const BusyAskKindWindow = "window";
export const BusyAskKindQuit = "quit";
export const BusyAskKindDelete = "delete";
export const BusyAskKindSwitch = "switch";

// stopworkspaceids: every terminal of these workspaces ends (their blocks are deleted, durable ones included).
// quit: every other non-durable terminal ends too; durable sessions keep running (FR-SHELL-020).
export type BusyAskRequest = {
    requestid: string;
    kind: string;
    stopworkspaceids: string[];
    quit: boolean;
    // The app's name (a gold names itself, #191) or the workspace's, for the dialog's title.
    name?: string;
};

export type BusyStops = { stopworkspaceids: string[]; quit: boolean };

export const BusyOutcomeOff = "off";
export const BusyOutcomeNone = "none";
export const BusyOutcomeClose = "close";
export const BusyOutcomeCancel = "cancel";
export const BusyOutcomeNoAnswer = "noanswer";

export const BusyPhaseAck = "ack";
export const BusyPhaseAsking = "asking";
export const BusyPhaseResult = "result";

export type BusyAskReply = { requestid: string; phase: string; outcome?: string };

type WorkspaceLike = { oid?: string; name?: string; icon?: string; tabids?: string[] };

// wcore.DeleteWorkspace(force=false) keeps a workspace only when it has a name and an icon.
export function isDeletedWhenLeft(ws: WorkspaceLike): boolean {
    if (ws == null) {
        return false;
    }
    return !(ws.name && ws.icon);
}

// emain-window's isNonEmptyUnsavedWorkspace: a switch away from it opens the target in a new window instead.
function opensNewWindowOnSwitch(ws: WorkspaceLike): boolean {
    return !ws.name && !ws.icon && ws.tabids?.length > 1;
}

export type WindowCloseFacts = {
    numWindows: number;
    saveLastWindow: boolean;
    platform: string;
    // Builder windows keep the app running on Linux and Windows when the last terminal window closes.
    numBuilders: number;
    workspace: WorkspaceLike;
};

// The close handler deletes the window (and so its unsaved workspace) when another window remains or
// window:savelastwindow is off. On Linux and Windows the last window's close quits the app (window-all-closed), with
// no quit confirmation: that close stops every non-durable terminal.
export function windowCloseStops(facts: WindowCloseFacts): BusyStops {
    const deleteAllowed = facts.numWindows > 1 || !facts.saveLastWindow;
    const deletes = deleteAllowed && isDeletedWhenLeft(facts.workspace) && !!facts.workspace?.oid;
    const quits = facts.numWindows <= 1 && facts.platform !== "darwin" && facts.numBuilders === 0;
    if (!deletes && !quits) {
        return null;
    }
    return { stopworkspaceids: deletes ? [facts.workspace.oid] : [], quit: quits };
}

// WindowService.SwitchWorkspace deletes the workspace left when no window shows the target (otherwise it focuses
// that window) and the workspace left is not saved; an unsaved one with several tabs never gets there.
export function switchStops(current: WorkspaceLike, targetHasWindow: boolean): BusyStops {
    if (targetHasWindow || current?.oid == null) {
        return null;
    }
    if (!isDeletedWhenLeft(current) || opensNewWindowOnSwitch(current)) {
        return null;
    }
    return { stopworkspaceids: [current.oid], quit: false };
}

// Off, nothing running and a renderer that did not answer leave the decision to Electron's own confirmation, exactly
// as before (FR-SHELL-062 AC5, validation rule).
export function fallsBackToElectron(outcome: string): boolean {
    return outcome === BusyOutcomeOff || outcome === BusyOutcomeNone || outcome === BusyOutcomeNoAnswer;
}
