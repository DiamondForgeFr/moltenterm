// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The 360 carpet in a view's icon (FR-SHELL-081, DS-SHELL-126, #1823): a small cube whose front face is the icon of the
// carpet panel in front. When the carpet turns to another panel the cube turns a quarter to show it; at rest it does
// not move, and under reduced motion the front face just changes. The look is in view-cube.css.

import { cn, makeIconClass } from "@/util/util";
import { useState } from "react";
import { prefersReducedMotion } from "../molten-motion";
import { cubeAngle, faceRole, nextCube, startCube } from "./view-cube-model";
import "./view-cube.css";
import type { GlyphCube } from "./view-menu-model";

export function ViewCube({ cube, small }: { cube: GlyphCube; small?: boolean }) {
    const [state, setState] = useState(() => startCube(cube));
    const shown = nextCube(state, cube, !prefersReducedMotion());
    if (shown !== state) {
        setState(shown);
    }
    return (
        <span
            className={cn("mt-cube", small && "is-small")}
            style={{ "--mt-cube-turn": `${cubeAngle(shown)}deg` } as React.CSSProperties}
            data-testid="view-cube"
            data-front={shown.id}
            data-count={cube.count}
        >
            <span className="mt-cube-body">
                {shown.icons.map((icon, slot) => (
                    <span
                        key={slot}
                        className="mt-cube-face"
                        data-slot={slot}
                        data-role={faceRole(shown, slot)}
                        data-testid="view-cube-face"
                    >
                        <i className={makeIconClass(icon, false, { defaultIcon: "square" })} />
                    </span>
                ))}
                <span className="mt-cube-face is-top" />
            </span>
        </span>
    );
}
