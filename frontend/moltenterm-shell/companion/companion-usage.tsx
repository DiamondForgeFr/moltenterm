// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Usage action of the companion (FR-SHELL-026, DS-SHELL-029): the agent's own usage page, opened like any link of
// MoltenTerm's interface (openLink: the current tab's browser panel, FR-BRW-006). MoltenTerm reads nothing from it.

import { openLink } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { CompanionView, usageAction } from "./companion-model";

export function openUsagePage(view: CompanionView, open: (url: string) => Promise<void> = openLink): boolean {
    const action = usageAction(view);
    if (action == null) {
        return false;
    }
    fireAndForget(() => open(action.url));
    return true;
}

export function UsageButton({ view, className }: { view: CompanionView; className?: string }) {
    const action = usageAction(view);
    if (action == null) {
        return null;
    }
    return (
        <button
            type="button"
            title={action.title}
            aria-label={action.title}
            onClick={(e) => {
                // The block's own click handler would take the focus back from the browser panel the page opens in,
                // and the two blocks would trade it forever (React error 185).
                e.stopPropagation();
                openUsagePage(view);
            }}
            className={cn(
                "flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-secondary hover:bg-hover hover:text-primary focus-visible:bg-hover focus-visible:text-primary",
                className
            )}
            data-testid="companion-usage"
        >
            <i className="fa fa-solid fa-gauge" aria-hidden="true" />
            <span>Usage</span>
        </button>
    );
}
