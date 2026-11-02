// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The control bar of a tab an agent drives (FR-BRW-008, DS-BRW-011): above the page, in the engine choice's slot and
// style, calm (no warning colour, no modal). "<Agent> is controlling this tab", the last action on one line, Take over
// and Stop; the user's click or key in the page is held back and the line says how to take over (#971). After Take
// over, "You took over" with "Give back to <Agent>".

import { Button } from "@/app/element/button";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { useT } from "../i18n/i18n";
import { ActionCueMs, activeCue, BrowserAgentModel, controlBarView, permissionBarView } from "./browser-agent";

export function AgentControlBar({ agents, tabId }: { agents: BrowserAgentModel; tabId: string }) {
    const t = useT();
    const tabs = useAtomValue(agents.tabsAtom);
    const held = useAtomValue(agents.heldAtom);
    const view = controlBarView(tabs[tabId], held[tabId] === true);
    // The site permission bar takes this slot while the agent waits for the user's answer.
    if (view == null || permissionBarView(tabs[tabId]) != null) {
        return null;
    }
    return (
        <div
            role="region"
            aria-label={t("browser.agent.controlAria")}
            className="molten-browser-agentbar flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border px-2 py-1.5 text-12"
        >
            <i
                aria-hidden="true"
                className={cn(
                    "fa fa-solid shrink-0 text-11",
                    view.takenOver ? "fa-hand text-secondary" : "fa-robot text-[var(--mt-state-running)]"
                )}
            />
            <div aria-live="polite" className="flex min-w-[150px] flex-1 items-baseline gap-2 truncate">
                <span className="truncate text-primary">{view.title}</span>
                {view.detail ? <span className="min-w-0 truncate text-secondary">{view.detail}</span> : null}
            </div>
            {view.viewport ? (
                <span
                    title={t("browser.agent.viewportTitle")}
                    className="shrink-0 rounded-4 border border-border px-1.5 py-px font-mono text-11 text-secondary"
                >
                    {view.viewport}
                </span>
            ) : null}
            <div className="flex shrink-0 items-center gap-2">
                {view.buttons.map((b) =>
                    b.primary ? (
                        <Button
                            key={b.action}
                            className="!h-6 !px-2.5 !text-12"
                            onClick={() => agents.control(tabId, b.action)}
                        >
                            {b.label}
                        </Button>
                    ) : (
                        <button
                            key={b.action}
                            type="button"
                            onClick={() => agents.control(tabId, b.action)}
                            className="h-6 cursor-pointer rounded-6 border border-border px-2.5 text-primary hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--mt-focus-ring)"
                        >
                            {b.label}
                        </button>
                    )
                )}
            </div>
        </div>
    );
}

// Where the agent just acted, drawn over the page (not injected in it): a pointer at the click point, an outline on the
// element. The input tools send the cue with each action.
export function AgentActionCueOverlay({ agents, tabId }: { agents: BrowserAgentModel; tabId: string }) {
    const tabs = useAtomValue(agents.tabsAtom);
    const tab = tabs[tabId];
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (tab?.cue == null || tab.actionts == null) {
            return;
        }
        setNow(Date.now());
        const timer = setTimeout(() => setNow(Date.now()), ActionCueMs + 50);
        return () => clearTimeout(timer);
    }, [tab?.actionts, tab?.cue]);
    const cue = activeCue(tab, now);
    if (cue == null) {
        return null;
    }
    const hasBox = cue.width > 0 && cue.height > 0;
    return (
        <div
            aria-hidden="true"
            className="molten-browser-agentcue pointer-events-none absolute inset-0 z-10 overflow-hidden"
        >
            {hasBox ? (
                <div
                    className="absolute rounded-4 border-2 border-accent"
                    style={{ left: cue.x, top: cue.y, width: cue.width, height: cue.height }}
                />
            ) : null}
            {!hasBox && cue.x != null && cue.y != null ? (
                <div
                    className="absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-accent shadow-e2"
                    style={{ left: cue.x, top: cue.y }}
                />
            ) : null}
        </div>
    );
}
