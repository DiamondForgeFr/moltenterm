// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The ribbon's drawing (FR-SHELL-159, #2476), shared by the window's ribbon in both sidebar modes and the ribbons of
// its menu: a flat shape in a workspace's colour, a notched point on the right, the emblem, the name, and a dot when an
// agent waits in another context.

import { cn } from "@/util/util";
import { forwardRef } from "react";
import { StateMark } from "../state-mark";
import { Emblem } from "./emblem";
import "./ribbon.css";

type RibbonFaceProps = {
    emblem: string;
    name: string;
    paint: string;
    ink: string;
    // The agents waiting in another context: a dot when there are any.
    waiting?: number;
};

export function RibbonFace({ emblem, name, paint, ink, waiting = 0 }: RibbonFaceProps) {
    return (
        <span
            className="mt-ribbon-shape"
            style={{ ["--ribbon-paint" as string]: paint, ["--ribbon-ink" as string]: ink } as React.CSSProperties}
        >
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
    { rolled, open, label, title, onClick, ...face },
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
            onClick={onClick}
        >
            <RibbonFace {...face} />
        </button>
    );
});
