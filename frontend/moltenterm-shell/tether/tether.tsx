// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The one link between a rail button and its panel (FR-BOSS-009, AC65 to AC69, #2196): a continuous rope tied at both
// ends, which comes out with the panel, settles once, follows it and retracts with it. Brokk's group draws it for the five
// panels of its rail and for the thread between his title-bar face and his square; nothing else draws a link.

import { cn } from "@/util/util";
import { CSSProperties } from "react";
import { TetherLine } from "./tether-model";
import "./tether.css";

export type TetherProps = {
    line: TetherLine;
    // True once what the rope holds is in; false while it is out of sight or on its way out.
    open: boolean;
    className?: string;
    testId?: string;
};

export function Tether({ line, open, className, testId }: TetherProps) {
    const style = {
        left: line.left,
        top: line.top,
        width: line.width,
        ["--mt-tether-w" as string]: `${line.width}px`,
        ["--mt-tether-from" as string]: Number(line.from.toFixed(4)),
    } as CSSProperties;
    return (
        <div
            className={cn("mt-tether", open && "is-in", className)}
            style={style}
            aria-hidden
            data-testid={testId}
            data-open={open ? "true" : "false"}
        >
            <i className="mt-tether-rope" />
            <i className="mt-tether-anchor" />
            <i className="mt-tether-knot" />
        </div>
    );
}
