// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The sidebar's heat (FR-SHELL-122, DS-SHELL-133, #1409): while agents of the workspace work, a faint heat rises in
// the free space at the bottom of the sidebar's page, stronger with more of them, and cools out when the last one
// stops. It is ambient, never the indicator: the agent rows, the tiles and the dots keep telling the state. It is a
// flex spacer after the page's last section, so it is exactly the free space and never covers a row; with no free
// space it has no height and draws nothing (sidebar-heat.css). The embers rise from a molten bath along its bottom
// edge (#1457): the bath rises before they start, and cools and sinks after they stop.

import { atoms, getSettingsKeyAtom } from "@/app/store/global";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import type { AgentStateInfo } from "../agent-state-model";
import { agentRowLook } from "./sidebar-agents-model";
import "./sidebar-heat.css";

export const SidebarHeatSettingKey = "moltenterm:sidebarheat";
export const SidebarHeatMaxLevel = 3;
export const SidebarHeatMinHeightPx = 40;
// The frames the heat may change on: the dominoes' 1/15 s grid (#1399), which the working light's 1/30 s grid
// contains (#1388). sidebar-heat.css plays every cycle, a whole number of seconds, in 15 steps a second.
export const SidebarHeatStepsPerSecond = 15;
// The loops whose start snapRise puts on the grid: the embers' rises and the bath's flows (#1457).
const LoopAnimationPrefixes = ["mt-sb-heat-rise-", "mt-sb-heat-flow-"];
const CoolAnimationName = "mt-sb-heat-out";

type RiseAnimation = Pick<Animation, "startTime" | "effect"> & { animationName?: string };

// 1 to 3 with the working agents of the workspace, 0 with none.
export function sidebarHeatLevel(agents: AgentStateInfo[]): number {
    const working = (agents ?? []).filter((a) => agentRowLook(a) === "working").length;
    return Math.min(working, SidebarHeatMaxLevel);
}

// Each layer's steps fall on its own start time: layers or indicators started apart would change on different frames
// (#473), and a lap that falls on its own time costs a main-thread frame (#1399). When a rise starts (its layer fades
// in, so a jump cannot show) its start goes back onto a whole cycle of the document timeline: its steps and its laps
// then fall with the dominoes'. At a lap, a rise that was held still and resumed off the grid goes back onto the
// nearest step only, under 1/30 s: a whole cycle would make the particles jump.
export function snapRise(anim: RiseAnimation, atLap: boolean) {
    if (!LoopAnimationPrefixes.some((p) => anim.animationName?.startsWith(p)) || anim.startTime == null) {
        return;
    }
    const duration = anim.effect?.getComputedTiming().duration;
    if (typeof duration !== "number" || !Number.isFinite(duration) || !(duration > 0)) {
        return;
    }
    const start = Number(anim.startTime);
    const step = 1000 / SidebarHeatStepsPerSecond;
    const snapped = atLap ? Math.round(start / step) * step : Math.floor(start / duration) * duration;
    if (Math.abs(snapped - start) < 0.01) {
        return;
    }
    anim.startTime = snapped;
}

function snapLayer(layer: Element, atLap: boolean) {
    for (const anim of (layer.getAnimations?.() ?? []) as (Animation & RiseAnimation)[]) {
        anim.ready.then(() => snapRise(anim, atLap)).catch(() => {});
    }
}

// Too little free space for a heat to read: sidebar-heat.css draws nothing (data-small). Written on the element, so a
// resize never re-renders the sidebar; a size container query would restart the rises at every root style change.
export function isHeatTooSmall(height: number): boolean {
    return height < SidebarHeatMinHeightPx;
}

function useSmallMark(el: HTMLDivElement) {
    useEffect(() => {
        if (el == null || typeof ResizeObserver === "undefined") {
            return;
        }
        const mark = (height: number) => {
            el.toggleAttribute("data-small", isHeatTooSmall(height));
        };
        mark(el.getBoundingClientRect().height);
        const observer = new ResizeObserver((entries) => mark(entries[entries.length - 1].contentRect.height));
        observer.observe(el);
        return () => observer.disconnect();
    }, [el]);
}

export function SidebarHeat({ agents, shown }: { agents: AgentStateInfo[]; shown: boolean }) {
    const setting = useAtomValue(getSettingsKeyAtom(SidebarHeatSettingKey));
    const reducedMotion = useAtomValue(atoms.prefersReducedMotionAtom);
    const level = sidebarHeatLevel(agents);
    const allowed = shown && setting !== false && !reducedMotion;
    const on = allowed && level > 0;
    const [cooling, setCooling] = useState(false);
    const [prevOn, setPrevOn] = useState(on);
    const [lastLevel, setLastLevel] = useState(level);
    const [el, setEl] = useState<HTMLDivElement>(null);
    useSmallMark(el);
    // Decided while rendering, as the working light: the heat stays mounted from on to cooling, or it would vanish
    // for a frame before its cool-down starts. Only the last agent stopping cools it; the setting, reduced motion or
    // the sidebar going away remove it at once.
    if (prevOn !== on) {
        setPrevOn(on);
        setCooling(!on && allowed);
    }
    if (level > 0 && level !== lastLevel) {
        setLastLevel(level);
    }
    if (!allowed || (!on && !cooling)) {
        return null;
    }
    return (
        <div
            ref={setEl}
            className="mt-sb-heat"
            data-testid="sidebar-heat"
            data-level={on ? level : lastLevel}
            data-cooling={on ? undefined : ""}
            aria-hidden
            onAnimationStart={(e) => snapLayer(e.target as Element, false)}
            onAnimationIteration={(e) => snapLayer(e.target as Element, true)}
            onAnimationEnd={(e) => {
                if (e.animationName === CoolAnimationName && !on) {
                    setCooling(false);
                }
            }}
        >
            <div className="mt-sb-heat-glow" />
            <div className="mt-sb-heat-embers">
                <div className="mt-sb-heat-layer is-a" />
                <div className="mt-sb-heat-layer is-b" />
                <div className="mt-sb-heat-layer is-c" />
            </div>
            <div className="mt-sb-heat-bath" data-testid="sidebar-heat-bath">
                <div className="mt-sb-heat-iron" />
                <div className="mt-sb-heat-molten">
                    <div className="mt-sb-heat-wave is-back" />
                    <div className="mt-sb-heat-wave is-front" />
                    <div className="mt-sb-heat-glint" />
                </div>
            </div>
        </div>
    );
}
