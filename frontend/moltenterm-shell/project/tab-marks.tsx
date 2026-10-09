// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What MoltenTerm adds after a tab's name: the pin of the Project tab (FR-SHELL-015) and the most urgent state of the
// tab's coding agents (FR-SHELL-011).

import { makeORef, useWaveObjectValue } from "@/app/store/wos";
import { AgentTabDot } from "../agent-state-ui";
import { ProjectTabMetaKey } from "./project-model";

export function MoltentermTabMarks({ tabId }: { tabId: string }) {
    const [tab] = useWaveObjectValue<Tab>(makeORef("tab", tabId));
    const pinned = !!(tab?.meta as Record<string, any>)?.[ProjectTabMetaKey];
    return (
        <>
            {pinned ? (
                <i
                    className="fa fa-solid fa-thumbtack pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 rotate-45 text-11 text-muted"
                    title="The Project tab: where the project stands. Closed, it comes back from the palette or the rail."
                    aria-label="Pinned Project tab"
                    data-testid="project-tab-pin"
                />
            ) : null}
            <AgentTabDot tabId={tabId} />
        </>
    );
}
