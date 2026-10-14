// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Closing and resetting a workspace (#222): a workspace is closed only when the user lands on another one; the last one
// is reset instead (one new tab). wavesrv enforces the same rule (pkg/wcore/moltenterm_workspace.go); this side decides
// what the rail and the editor offer.

import { t } from "./i18n/i18n";

// English, for Wave's workspace editor until it routes the text through a key; MoltenTerm code calls
// lastWorkspaceReason().
export const LastWorkspaceReason = "The only workspace: reset it instead";

export function lastWorkspaceReason(): string {
    return t("workspace.reset.lastReason");
}

// entries are every workspace the rail shows, the unsaved one of this window included. A window that shows an unsaved
// workspace is not in that list, so the rule may refuse a close wavesrv would accept, never the reverse.
export function canCloseWorkspace(entries: { id: string }[], workspaceId: string): boolean {
    return (entries ?? []).some((e) => e?.id && e.id !== workspaceId);
}

// What the reset confirmation says is lost.
export function resetLossText(tabCount: number, paneCount: number): string {
    const tabs = t(tabCount === 1 ? "workspace.reset.tabs.one" : "workspace.reset.tabs.other", { count: tabCount });
    if (paneCount === 0) {
        return t("workspace.reset.lossTabs", { tabs });
    }
    const panes = t(paneCount === 1 ? "workspace.reset.panes.one" : "workspace.reset.panes.other", {
        count: paneCount,
    });
    return t("workspace.reset.lossTabsPanes", { tabs, panes });
}
