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

// The steps of a lap of the light's turn: panel-motion.css turns it in steps(240), 30 frames a second (#1388).
export const WorkingLightSteps = 240;
const TurnAnimationName = "df-glow-turn";

const NoAgentAtom = atom(null as AgentStateInfo);

type TurnAnimation = Pick<Animation, "startTime" | "effect" | "ready"> & { animationName?: string };

// Each light's steps fall on its own start time, so lights started apart would change on different frames and N
// lights would cost N times the frames (#473). Snapping the start onto the grid of steps counted from the document
// timeline's origin makes every light change on the same frames; the shift is under half a step (0.75°), unseen.
export function snapTurnToGrid(anim: TurnAnimation) {
    if (anim.animationName !== TurnAnimationName || anim.startTime == null) {
        return;
    }
    const duration = anim.effect?.getComputedTiming().duration;
    if (typeof duration !== "number" || !(duration > 0)) {
        return;
    }
    const step = duration / WorkingLightSteps;
    const start = Number(anim.startTime);
    const snapped = Math.round(start / step) * step;
    if (Math.abs(snapped - start) < 0.01) {
        return;
    }
    anim.startTime = snapped;
}

function turnAnimations(el: Element): TurnAnimation[] {
    return (el.getAnimations?.({ subtree: true }) ?? []) as TurnAnimation[];
}

// Snapped when a turn starts (on mount, and when reduced motion is turned off again, which starts a new turn) once
// its start time is known, and again at each lap, which catches a turn that started while the view held it still.
function snapLight(el: Element) {
    for (const anim of turnAnimations(el)) {
        anim.ready.then(() => snapTurnToGrid(anim)).catch(() => {});
    }
}

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
            onAnimationStart={(e) => snapLight(e.currentTarget)}
            onAnimationIteration={(e) => snapLight(e.currentTarget)}
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
