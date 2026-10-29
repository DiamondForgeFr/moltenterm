// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A working agent on its view's tile (FR-SHELL-112, #1349): the suite's turning light around the tile, in
// incandescent, in place of the corner dot; it shows only while an agent works for the developer, never as
// decoration, and cools to cast iron in --mt-duration-cool once the agent stops (panel-motion.css). The tile keeps
// the agent's state in its accessible name and its tooltip, as the dot did.

import { getWaveObjectAtom, makeORef } from "@/app/store/wos";
import { atom, useAtomValue } from "jotai";
import { useMemo, useState } from "react";
import { AgentStateInfo } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { prefersReducedMotion } from "../molten-motion";
import { agentMarkTitle, TabAgentMark } from "../tab-identity-ui";
import "./panel-motion.css";

const NoAgentAtom = atom(null as AgentStateInfo);

export function isAgentWorking(info: AgentStateInfo): boolean {
    return info?.state === "working";
}

// The most urgent agent of a view, or null for a block that has no view in this workspace (tabId empty).
export function useTabUrgentAgent(tabId: string): AgentStateInfo {
    const agentAtom = useMemo(() => {
        if (!tabId) {
            return NoAgentAtom;
        }
        const tabAtom = getWaveObjectAtom<Tab>(makeORef("tab", tabId));
        return AgentStates.getInstance().tabAtom(atom((get) => get(tabAtom)?.blockids ?? []));
    }, [tabId]);
    return useAtomValue(agentAtom);
}

// The light around a tile (positioned and rounded): on while `on`, cooling for a moment after.
export function WorkingLight({ on }: { on: boolean }) {
    const [cooling, setCooling] = useState(false);
    const [prevOn, setPrevOn] = useState(on);
    // Decided while rendering, not in an effect: the light must stay mounted from on to cooling, or its turn would
    // restart and a frame would show the tile without it.
    if (prevOn !== on) {
        setPrevOn(on);
        setCooling(!on && !prefersReducedMotion());
    }
    if (!on && !cooling) {
        return null;
    }
    return (
        <span
            className="df-glow mt-working-light"
            data-on={on ? "" : undefined}
            data-cooling={on ? undefined : ""}
            data-testid="working-light"
            aria-hidden
            onAnimationEnd={(e) => {
                if (e.target === e.currentTarget && !on) {
                    setCooling(false);
                }
            }}
        />
    );
}

// The tile's corner mark: the agent's dot, or, while it works, only its state for assistive technologies (the
// turning light shows it).
export function TileAgentMark({ info }: { info: AgentStateInfo }) {
    if (!isAgentWorking(info)) {
        return <TabAgentMark info={info} />;
    }
    return (
        <span
            className="sr-only"
            role="img"
            aria-label={agentMarkTitle(info)}
            data-testid="tab-agent-mark"
            data-state="working"
        />
    );
}

// A tile's tooltip with its working agent's state, which the dot's own tooltip gave.
export function withWorkingTitle(title: string, info: AgentStateInfo): string {
    if (!isAgentWorking(info) || title == null) {
        return title;
    }
    const agent = agentMarkTitle(info);
    return agent ? `${title}\n${agent}` : title;
}
