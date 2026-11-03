// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The 360 cube of a view's icon (FR-SHELL-081, #1823): which face shows which panel, and how far the cube has turned.
// It has four faces around its vertical axis. A new panel in front is written on the face beside the front one, on the
// side the carpet moved toward (a panel further right on the carpet comes from the right), and the cube turns a
// quarter to bring it forward; the other faces keep whatever they showed. Under reduced motion the front face just
// changes its icon. Kept apart from the component so the rules are tested without the app.

import type { GlyphCube } from "./view-menu-model";

export const CubeSlots = 4;
export const QuarterTurnDeg = 90;

export type CubeState = {
    // The carpet panel in front, and its place among the carpet's panels.
    id: string;
    index: number;
    // The icon each face holds; slot is the face in front.
    icons: string[];
    slot: number;
    // Quarter turns made so far, counted past a full turn so a face never spins back.
    turns: number;
};

export function startCube(cube: GlyphCube): CubeState {
    return { id: cube.id, index: cube.index, icons: Array(CubeSlots).fill(cube.icon), slot: 0, turns: 0 };
}

function modSlot(n: number): number {
    return ((n % CubeSlots) + CubeSlots) % CubeSlots;
}

// The state once `cube` is what the icon must show. Returns the same object while nothing changed.
export function nextCube(state: CubeState, cube: GlyphCube, animate: boolean): CubeState {
    if (cube.id === state.id) {
        if (cube.icon === state.icons[state.slot] && cube.index === state.index) {
            return state;
        }
        const icons = state.icons.slice();
        icons[state.slot] = cube.icon;
        return { ...state, icons, index: cube.index };
    }
    const icons = state.icons.slice();
    if (!animate) {
        icons[state.slot] = cube.icon;
        return { ...state, id: cube.id, index: cube.index, icons };
    }
    const dir = cube.index >= state.index ? 1 : -1;
    const slot = modSlot(state.slot + dir);
    icons[slot] = cube.icon;
    return { id: cube.id, index: cube.index, icons, slot, turns: state.turns + dir };
}

// The angle of the cube's body around its vertical axis: a quarter turn the other way brings the face on its right.
export function cubeAngle(state: CubeState): number {
    return 0 - QuarterTurnDeg * state.turns;
}

export type CubeRole = "front" | "right" | "back" | "left";

// Where a face sits relative to the front one, which sets how much it is shaded.
export function faceRole(state: CubeState, slot: number): CubeRole {
    const roles: CubeRole[] = ["front", "right", "back", "left"];
    return roles[modSlot(slot - state.slot)];
}
