// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The site permission bar (FR-BRW-009, DS-BRW-013): the first action of an agent on a site asks here, in the control
// bar's slot and style. Allow once lasts for the agent's session, Always for this site and Block are remembered for
// every agent; Escape refuses this time only. The bar never takes the keyboard focus: the user is typing in the
// terminal, where an Enter must not answer for them.

import { Button } from "@/app/element/button";
import { useAtomValue } from "jotai";
import { BrowserAgentModel, permissionBarView } from "./browser-agent";

export function AgentPermissionBar({ agents, tabId }: { agents: BrowserAgentModel; tabId: string }) {
    const tabs = useAtomValue(agents.tabsAtom);
    const view = permissionBarView(tabs[tabId]);
    if (view == null) {
        return null;
    }
    return (
        <div
            role="region"
            aria-label="Site permission"
            onKeyDown={(e) => {
                if (e.key !== "Escape") {
                    return;
                }
                e.stopPropagation();
                agents.answer(tabId, view.requestId, "dismiss");
            }}
            className="molten-browser-agentpermission flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border px-2 py-1.5 text-xs"
        >
            <i aria-hidden="true" className="fa fa-solid fa-robot shrink-0 text-[11px] text-accent" />
            <div aria-live="polite" className="flex min-w-[150px] flex-1 items-baseline gap-2 truncate">
                <span className="truncate text-primary">{view.title}</span>
                <span className="min-w-0 truncate text-secondary">{view.detail}</span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
                {view.buttons.map((b) =>
                    b.primary ? (
                        <Button
                            key={b.decision}
                            className="!h-6 !px-2.5 !text-xs"
                            onClick={() => agents.answer(tabId, view.requestId, b.decision)}
                        >
                            {b.label}
                        </Button>
                    ) : (
                        <button
                            key={b.decision}
                            type="button"
                            onClick={() => agents.answer(tabId, view.requestId, b.decision)}
                            className="h-6 cursor-pointer rounded border border-border px-2.5 text-primary hover:bg-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                        >
                            {b.label}
                        </button>
                    )
                )}
            </div>
        </div>
    );
}
