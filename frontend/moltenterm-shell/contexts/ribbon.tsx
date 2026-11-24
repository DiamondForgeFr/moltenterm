// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The ribbon's drawing (FR-SHELL-159, #2476, #2519), shared by the window's ribbon in both sidebar modes and the ribbons
// of its menu: a flat shape in a workspace's colour with the end shape of its context, the emblem, the name, and a dot
// when an agent waits in another context. While agents of the window's context work, the sidebar's ribbon catches the
// light of the molten bath above it (the rim and the halo) and the collapsed one keeps a still glow.

import { cn } from "@/util/util";
import { forwardRef } from "react";
import { StateMark } from "../state-mark";
import { Emblem } from "./emblem";
import { ribbonShape } from "./ribbon-shapes";
import "./ribbon.css";

type RibbonFaceProps = {
    emblem: string;
    name: string;
    paint: string;
    ink: string;
    // The id of the end shape (ribbon-shapes.ts); the V point when none is given.
    shape?: string;
    // The agents waiting in another context: a dot when there are any.
    waiting?: number;
    // How hot the ribbon runs, 0 to 3 (ribbonHeatLevel): the light of the bath on its top edge in the sidebar, a still
    // glow in the collapsed ribbon. 0 draws and runs nothing.
    heat?: number;
    // The light the heat draws: the sidebar's ribbon under the bath, or the collapsed one at the window's edge.
    lit?: "rim" | "glow";
};

export function RibbonFace({ emblem, name, paint, ink, shape, waiting = 0, heat = 0, lit = "rim" }: RibbonFaceProps) {
    const warm = heat > 0;
    return (
        <span
            className="mt-ribbon-shape"
            data-heat={heat}
            data-shape={ribbonShape(shape).id}
            style={
                {
                    ["--ribbon-paint" as string]: paint,
                    ["--ribbon-ink" as string]: ink,
                    ["--ribbon-clip" as string]: ribbonShape(shape).clip,
                } as React.CSSProperties
            }
        >
            {warm && lit === "rim" ? <span className="mt-ribbon-halo" aria-hidden /> : null}
            {warm && lit === "rim" ? <span className="mt-ribbon-rim" aria-hidden /> : null}
            {warm && lit === "glow" ? <span className="mt-ribbon-glow" aria-hidden /> : null}
            <span className="mt-ribbon-emblem">
                <Emblem name={emblem} size={14} />
            </span>
            <span className="mt-ribbon-name">{name}</span>
            {waiting > 0 ? (
                <span className="mt-ribbon-dot" data-testid="context-ribbon-dot">
                    <StateMark kind="waiting" />
                </span>
            ) : null}
        </span>
    );
}

type RibbonButtonProps = RibbonFaceProps & {
    // Rolled up to its emblem, unrolling under the pointer (the collapsed sidebar's ribbon).
    rolled: boolean;
    open: boolean;
    label: string;
    title: string;
    onClick: () => void;
};

export const RibbonButton = forwardRef<HTMLButtonElement, RibbonButtonProps>(function RibbonButton(
    { rolled, open, label, title, onClick, heat = 0, ...face },
    ref
) {
    return (
        <button
            ref={ref}
            type="button"
            className={cn("mt-ribbon", rolled && "is-rolled")}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={label}
            title={title}
            data-testid="context-ribbon"
            data-mode={rolled ? "collapsed" : "sidebar"}
            data-heat={heat}
            onClick={onClick}
        >
            <RibbonFace {...face} heat={heat} lit={rolled ? "glow" : "rim"} />
        </button>
    );
});
