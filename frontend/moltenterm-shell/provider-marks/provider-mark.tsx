// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// An agent's provider mark in a square slot (#2542, FR-BOSS-009 AC113). Decorative: the surface that draws it already
// names the agent (a popover, a label, an accessible name). A mark with a dark and a light variant draws both, and the
// stylesheet shows the one that reads on the theme; the files are drawn as they are, never recoloured. It draws nothing
// for an agent without a mark: the caller picks its own generic glyph (`hasProviderMark`).

import { cn } from "@/util/util";
import { CSSProperties } from "react";
import "./provider-mark.css";
import { canonicalAgent, markOf, markSize } from "./provider-marks";

export function hasProviderMark(agent: string | undefined): boolean {
    return markOf(agent) != null;
}

export function ProviderMark({ agent, slot, className }: { agent: string; slot: number; className?: string }) {
    const mark = markOf(agent);
    if (mark == null) {
        return null;
    }
    const { width, height } = markSize(mark, slot);
    const style: CSSProperties = { width, height, maxWidth: "none" };
    const same = mark.onDark === mark.onLight;
    return (
        <span
            className={cn("mt-pmark", className)}
            style={{ width: slot, height: slot }}
            aria-hidden
            data-testid="provider-mark"
            data-mark={canonicalAgent(agent)}
        >
            <img src={mark.onDark} alt="" draggable={false} style={style} data-tone={same ? undefined : "on-dark"} />
            {same ? null : <img src={mark.onLight} alt="" draggable={false} style={style} data-tone="on-light" />}
        </span>
    );
}
