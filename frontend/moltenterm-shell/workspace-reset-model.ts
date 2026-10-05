// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Closing and resetting a workspace (#222): a workspace is closed only when the user lands on another one; the last one
// is reset instead (one new tab). wavesrv enforces the same rule (pkg/wcore/moltenterm_workspace.go); this side decides
// what the rail and the editor offer.

export const LastWorkspaceReason = "The only workspace: reset it instead";

// entries are every workspace the rail shows, the unsaved one of this window included. A window that shows an unsaved
// workspace is not in that list, so the rule may refuse a close wavesrv would accept, never the reverse.
export function canCloseWorkspace(entries: { id: string }[], workspaceId: string): boolean {
    return (entries ?? []).some((e) => e?.id && e.id !== workspaceId);
}

function plural(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
}

// What the reset confirmation says is lost.
export function resetLossText(tabCount: number, paneCount: number): string {
    const tabs = plural(tabCount, "tab", "tabs");
    if (paneCount === 0) {
        return `Its ${tabs} will be closed.`;
    }
    return `Its ${tabs} and the ${plural(paneCount, "pane", "panes")} they hold will be closed: their terminals and agents stop and the layout is lost.`;
}
