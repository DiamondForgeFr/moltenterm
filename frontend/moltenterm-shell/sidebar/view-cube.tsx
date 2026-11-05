// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The 360 carpet in a view's icon (FR-SHELL-081, DS-SHELL-126, #1823, #1861, #1924): a small cube whose front face is
// the icon of the carpet panel in front, stretched into a prism of one icon per panel on screen (at most three, then
// +N) when the carpet shows several. One action makes one motion: when the number of panels on screen changes the cube
// stretches or narrows, when every panel on screen changes it turns a quarter (a prism narrows into a cube first and
// widens again after), when some stay the icons slide along the face; at rest it does not move, and under reduced
// motion the face just changes. The rules are in view-cube-model.ts, the look in view-cube.css.

import { cn, makeIconClass } from "@/util/util";
import { useState } from "react";
import { prefersReducedMotion } from "../molten-motion";
import { cubeAngle, cubeParity, cubeShape, faceRole, nextCube, startCube } from "./view-cube-model";
import "./view-cube.css";
import type { GlyphCube } from "./view-menu-model";

export function ViewCube({ cube, small }: { cube: GlyphCube; small?: boolean }) {
    const [state, setState] = useState(() => startCube(cube));
    const shown = nextCube(state, cube, !prefersReducedMotion());
    if (shown !== state) {
        setState(shown);
    }
    const { cells, more } = cubeShape(shown);
    return (
        <span
            className={cn("mt-cube", small && "is-small")}
            style={{ "--cube-n": cells, "--mt-cube-turn": `${cubeAngle(shown)}deg` } as React.CSSProperties}
            data-testid="view-cube"
            data-front={shown.id}
            data-count={cube.count}
            data-shown={shown.ids.length}
            data-cells={cells}
            data-motion={shown.motion}
            data-parity={cubeParity(shown)}
        >
            <span className="mt-cube-box">
                <span className="mt-cube-shear">
                    <span className="mt-cube-body">
                        {shown.faces.map((face, slot) => (
                            <span
                                key={slot}
                                className="mt-cube-face"
                                data-slot={slot}
                                data-role={faceRole(shown, slot)}
                                data-testid="view-cube-face"
                            >
                                <span className="mt-cube-rules" />
                                <span
                                    className="mt-cube-belt"
                                    style={{ "--mt-cube-first": face.first } as React.CSSProperties}
                                >
                                    {face.panels.map((panel) => (
                                        <span key={panel.id} className="mt-cube-cell" data-panel={panel.id}>
                                            <i
                                                className={makeIconClass(panel.icon, false, { defaultIcon: "square" })}
                                            />
                                        </span>
                                    ))}
                                </span>
                            </span>
                        ))}
                        <span className="mt-cube-face is-top" />
                    </span>
                </span>
            </span>
            {more > 0 ? (
                <span className="mt-cube-more" data-testid="view-cube-more">
                    +{more}
                </span>
            ) : null}
        </span>
    );
}
