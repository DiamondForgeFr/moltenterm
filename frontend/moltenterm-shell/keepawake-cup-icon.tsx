// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The keep-awake cup icon, shared by the window row's cup (keepawake-cup.tsx) and Brokk's rail (boss/brokk-group.tsx).
// It stands in a module of its own so the rail does not load the window row's popover.

import { cn } from "@/util/util";
import "./keepawake-cup.css";
import { snapToCycle } from "./suite/suite";

function SteamLine({ index }: { index: number }) {
    return (
        <span className={`mt-cup-steam mt-cup-steam-${index}`}>
            <svg viewBox="0 0 3 5.5" fill="none" stroke="currentColor" strokeWidth={0.9} strokeLinecap="round">
                <path d="M1.5 0.4C0.5 1.5 2.5 2.7 1.5 3.9S0.9 4.8 1.5 5.1" />
            </svg>
        </span>
    );
}

// The window row's cup, drawn in SVG so its steam can wave when coffee mode is on (DS-SHELL-151). The mug is a 16 unit
// square; the three steam lines are boxes of their own, moved by transform only (keepawake-cup.css). Brokk's rail draws it
// in the action colour with steam that rises and fades (FR-BOSS-009 AC80, #2206).
export function CupIcon({
    on,
    className,
    tone,
    steam,
}: {
    on: boolean;
    className?: string;
    tone?: "action";
    steam?: "rise";
}) {
    return (
        <span
            className={cn("mt-cup", className)}
            data-on={on ? "" : undefined}
            data-tone={tone}
            data-steam={steam}
            data-testid="keepawake-cup-icon"
            aria-hidden
            onAnimationStart={(e) => {
                for (const anim of e.currentTarget.getAnimations?.({ subtree: true }) ?? []) {
                    anim.ready.then(() => snapToCycle(anim)).catch(() => {});
                }
            }}
        >
            <svg className="mt-cup-body" viewBox="0 0 16 16" fill="currentColor">
                <path d="M2 7.5h9.2v4.3A3.2 3.2 0 0 1 8 15H5.2A3.2 3.2 0 0 1 2 11.8z" />
                <path
                    d="M11.2 9h1.1a1.8 1.8 0 0 1 0 3.6h-1.1"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.4}
                    strokeLinecap="round"
                />
            </svg>
            <SteamLine index={1} />
            <SteamLine index={2} />
            <SteamLine index={3} />
        </span>
    );
}
