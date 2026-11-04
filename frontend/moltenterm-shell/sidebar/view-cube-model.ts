// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The 360 cube of a view's icon (FR-SHELL-081, #1823, #1861): which face shows which panels, how many icons it draws,
// and which motion a change of screen makes. It has four faces around its vertical axis, each a belt of the carpet's
// icons seen through a window as wide as the panels on screen (one icon: a cube; two or three: a prism; more: three,
// then +N). What changed on the carpet picks one motion, with one meaning each:
//   slide    the carpet moved by some panels and one at least stays on screen: the belt of the front face slides along
//            the window, in the carpet's direction;
//   turn     none of the panels on screen stays: the cube turns a quarter toward the side the carpet moved to, the
//            panels are written on the face that comes forward, the other faces keep whatever they showed;
//   stretch  the number of panels on screen changed: the window widens or narrows around the same belt;
//   none     the same panels, or a panel replaced where the others stayed: the front face just changes.
// Under reduced motion every change is "none". Kept apart from the component so the rules are tested without the app.

import type { GlyphCube, GlyphCubePanel } from "./view-menu-model";

export const CubeSlots = 4;
export const QuarterTurnDeg = 90;
// A prism draws at most this many icons; the panels on screen beyond them are counted (+N).
export const MaxCubeCells = 3;

export type CubeMotion = "none" | "slide" | "turn" | "stretch";

// What a face holds: the carpet's icons and the place of the first one on screen.
export type CubeFace = { panels: GlyphCubePanel[]; first: number };

export type CubeState = {
    // The first panel on screen, and its place among the carpet's panels.
    id: string;
    index: number;
    // The panels on screen, in carpet order.
    ids: string[];
    // What each face holds; slot is the face in front.
    faces: CubeFace[];
    slot: number;
    // Quarter turns made so far, counted past a full turn so a face never spins back.
    turns: number;
    // The motion that led to this state: it tells the stylesheet what may move.
    motion: CubeMotion;
};

// The panels a cube has on screen, in carpet order.
export function shownIds(cube: GlyphCube): string[] {
    return cube.panels.slice(cube.index, cube.index + Math.max(1, cube.shown)).map((panel) => panel.id);
}

function faceOf(cube: GlyphCube): CubeFace {
    return { panels: cube.panels, first: cube.index };
}

export function startCube(cube: GlyphCube): CubeState {
    return {
        id: cube.id,
        index: cube.index,
        ids: shownIds(cube),
        faces: Array.from({ length: CubeSlots }, () => faceOf(cube)),
        slot: 0,
        turns: 0,
        motion: "none",
    };
}

function modSlot(n: number): number {
    return ((n % CubeSlots) + CubeSlots) % CubeSlots;
}

function sameIds(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((id, i) => id === b[i]);
}

function sameFace(a: CubeFace, b: CubeFace): boolean {
    return (
        a.first === b.first &&
        a.panels.length === b.panels.length &&
        a.panels.every((p, i) => p.id === b.panels[i].id && p.icon === b.panels[i].icon)
    );
}

// The motion from the panels that were on screen to those that are. steps: how many panels the belt slides, positive
// when the carpet moved toward its end (the panels enter on the right).
export function cubeMotion(from: string[], to: string[]): { motion: CubeMotion; steps: number } {
    if (sameIds(from, to)) {
        return { motion: "none", steps: 0 };
    }
    if (from.length !== to.length) {
        return { motion: "stretch", steps: 0 };
    }
    const n = to.length;
    const before = new Set(from);
    // A belt moves by whole panels: the ones that enter are new, so a panel carried to the other end (a reorder) is not
    // a slide.
    for (let k = 1; k < n; k++) {
        const kept = n - k;
        if (Array.from({ length: kept }, (_, i) => i).every((i) => to[i] === from[i + k])) {
            return to.slice(kept).some((id) => before.has(id))
                ? { motion: "none", steps: 0 }
                : { motion: "slide", steps: k };
        }
        if (Array.from({ length: kept }, (_, i) => i + k).every((i) => to[i] === from[i - k])) {
            return to.slice(0, k).some((id) => before.has(id))
                ? { motion: "none", steps: 0 }
                : { motion: "slide", steps: -k };
        }
    }
    return { motion: to.some((id) => before.has(id)) ? "none" : "turn", steps: 0 };
}

// The state once `cube` is what the icon must show. Returns the same object while nothing changed.
export function nextCube(state: CubeState, cube: GlyphCube, animate: boolean): CubeState {
    const ids = shownIds(cube);
    const face = faceOf(cube);
    const { motion } = cubeMotion(state.ids, ids);
    const moves = animate && motion !== "none";
    if (!moves) {
        if (sameFace(state.faces[state.slot], face) && state.index === cube.index && sameIds(state.ids, ids)) {
            return state;
        }
        const faces = state.faces.slice();
        faces[state.slot] = face;
        return { ...state, id: cube.id, index: cube.index, ids, faces, motion: "none" };
    }
    const faces = state.faces.slice();
    if (motion !== "turn") {
        faces[state.slot] = face;
        return { ...state, id: cube.id, index: cube.index, ids, faces, motion };
    }
    const dir = cube.index >= state.index ? 1 : -1;
    const slot = modSlot(state.slot + dir);
    faces[slot] = face;
    return { id: cube.id, index: cube.index, ids, faces, slot, turns: state.turns + dir, motion };
}

// The icons the window draws and the panels on screen beyond them: three icons and +1 for four panels.
export function cubeShape(state: CubeState): { cells: number; more: number } {
    const cells = Math.min(Math.max(1, state.ids.length), MaxCubeCells);
    return { cells, more: Math.max(0, state.ids.length - MaxCubeCells) };
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
