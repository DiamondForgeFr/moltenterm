// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The 360 cube of a view's icon (#1823, #1861, #1924): it turns a quarter when the whole screen changes (a prism
// narrows into a cube first and widens after), slides its icons when the carpet moves with a panel staying on screen,
// stretches when the number of panels on screen changes, draws one icon per panel on screen (three at most, then +N)
// and stays still otherwise.

import { describe, expect, it } from "vitest";
import {
    cubeAngle,
    cubeMotion,
    cubeParity,
    cubeShape,
    faceRole,
    MaxCubeCells,
    nextCube,
    shownIds,
    startCube,
} from "./view-cube-model";
import type { GlyphCube } from "./view-menu-model";

const Icons: Record<string, string> = {
    companion: "gauge",
    page: "globe",
    term: "terminal",
    files: "file-lines",
    review: "code-pull-request",
    agent: "robot",
    mail: "envelope",
};
const Carpet = ["companion", "page", "term", "files", "review", "agent"];

// The carpet scrolled so that `first` is the first panel on screen, with `shown` panels on screen.
function view(first: string, shown = 1, ids: string[] = Carpet, icons: Record<string, string> = Icons): GlyphCube {
    const panels = ids.map((id) => ({ id, icon: icons[id] }));
    const index = ids.indexOf(first);
    return { cube: true, id: first, icon: icons[first], index, count: ids.length, shown, panels };
}

function frontIcons(state: ReturnType<typeof startCube>, cells = state.ids.length): string[] {
    const face = state.faces[state.slot];
    return face.panels.slice(face.first, face.first + cells).map((p) => p.icon);
}

describe("view cube at rest (#1823)", () => {
    it("starts at rest with the front panel's icon on the front face", () => {
        const state = startCube(view("page"));
        expect(cubeAngle(state)).toBeCloseTo(0);
        expect(frontIcons(state)).toEqual(["globe"]);
        expect(faceRole(state, state.slot)).toBe("front");
        expect(state.motion).toBe("none");
    });

    it("does not move while nothing changed: the same object, the same angle", () => {
        const state = startCube(view("page"));
        expect(nextCube(state, view("page"), true)).toBe(state);
        expect(nextCube(state, view("page"), false)).toBe(state);
    });

    it("keeps the motion that led to it while nothing changes", () => {
        const turned = nextCube(startCube(view("page")), view("files"), true);
        expect(turned.motion).toBe("turn");
        expect(nextCube(turned, view("files"), true)).toBe(turned);
    });
});

describe("the whole screen changes: the cube turns (#1823)", () => {
    const companion = view("companion");
    const page = view("page");
    const files = view("files");

    it("turns a quarter toward the right for a panel further on the carpet, writing it on the face that comes forward", () => {
        const state = nextCube(startCube(page), files, true);
        expect(state.motion).toBe("turn");
        expect(cubeAngle(state)).toBe(-90);
        expect(state.slot).toBe(1);
        expect(frontIcons(state)).toEqual(["file-lines"]);
        expect(faceRole(state, 0)).toBe("left");
        expect(faceRole(state, 1)).toBe("front");
        expect(faceRole(state, 2)).toBe("right");
    });

    it("turns the other way for a panel earlier on the carpet", () => {
        const state = nextCube(startCube(page), companion, true);
        expect(state.motion).toBe("turn");
        expect(cubeAngle(state)).toBe(90);
        expect(state.slot).toBe(3);
        expect(frontIcons(state)).toEqual(["gauge"]);
    });

    it("leaves the faces beside the front one as they were", () => {
        const state = nextCube(startCube(page), files, true);
        expect(state.faces[0].first).toBe(1);
        expect(state.faces[0].panels[state.faces[0].first].icon).toBe("globe");
        expect(state.faces[2].first).toBe(1);
        expect(state.faces[3].first).toBe(1);
    });

    it("keeps turning in one direction past a full turn, and the face in front always shows the panel in front", () => {
        let state = startCube(view("companion"));
        for (const id of ["page", "term", "files", "review"]) {
            state = nextCube(state, view(id), true);
            expect(frontIcons(state)).toEqual([Icons[id]]);
        }
        expect(cubeAngle(state)).toBe(-360);
        expect(state.slot).toBe(0);
        state = nextCube(state, view("term"), true);
        expect(cubeAngle(state)).toBe(-270);
        expect(frontIcons(state)).toEqual(["terminal"]);
    });

    it("only swaps the icon when the same panel's icon changes (a page that loaded its icon): no turn", () => {
        const loaded = view("page", 1, Carpet, { ...Icons, page: "brands@github" });
        const state = nextCube(startCube(page), loaded, true);
        expect(cubeAngle(state)).toBe(0);
        expect(state.motion).toBe("none");
        expect(frontIcons(state)).toEqual(["brands@github"]);
    });

    it("does not turn when a panel opened before the one in front shifts its place", () => {
        const opened = view("page", 1, ["mail", ...Carpet]);
        const state = nextCube(startCube(page), opened, true);
        expect(cubeAngle(state)).toBe(0);
        expect(state.motion).toBe("none");
        expect(state.index).toBe(2);
        expect(state.faces[state.slot].first).toBe(2);
    });

    it("turns a prism whose panels all changed, toward the side the carpet moved to", () => {
        const left = nextCube(startCube(view("companion", 2)), view("term", 2), true);
        expect(left.motion).toBe("prism-turn");
        expect(cubeAngle(left)).toBe(-90);
        expect(shownIds(view("term", 2))).toEqual(["term", "files"]);
        expect(frontIcons(left)).toEqual(["terminal", "file-lines"]);
        const back = nextCube(left, view("companion", 2), true);
        expect(back.motion).toBe("prism-turn");
        expect(cubeAngle(back)).toBe(0);
        expect(frontIcons(back)).toEqual(["gauge", "globe"]);
    });
});

describe("one action, one motion, whatever the carpet passes through (#1924)", () => {
    // [from, to, motion, steps]: the panels on screen before the action and where the carpet rests.
    const Rules: [string, string[], string[], string, number][] = [
        ["one panel, another one", ["page"], ["term"], "turn", 0],
        ["one panel, one far along the carpet", ["page"], ["review"], "turn", 0],
        ["one panel, back to an earlier one", ["files"], ["companion"], "turn", 0],
        ["a cube becomes a prism", ["page"], ["page", "term"], "stretch", 0],
        ["a prism becomes a cube", ["page", "term"], ["page"], "stretch", 0],
        ["a prism of two becomes three", ["page", "term"], ["page", "term", "files"], "stretch", 0],
        ["the count changes and every panel is new", ["page"], ["files", "review"], "stretch", 0],
        ["two panels, none stays, going on", ["companion", "page"], ["files", "review"], "prism-turn", 0],
        ["two panels, none stays, going back", ["files", "review"], ["companion", "page"], "prism-turn", 0],
        ["two panels, none stays, next to each other", ["companion", "page"], ["term", "files"], "prism-turn", 0],
        ["three panels, none stays", ["companion", "page", "term"], ["files", "review", "agent"], "prism-turn", 0],
        ["two panels, one stays, going on", ["page", "term"], ["term", "files"], "slide", 1],
        ["two panels, one stays, going back", ["term", "files"], ["page", "term"], "slide", -1],
        ["three panels, one stays, going on", ["companion", "page", "term"], ["term", "files", "review"], "slide", 2],
        ["three panels, two stay, going back", ["page", "term", "files"], ["companion", "page", "term"], "slide", -1],
        ["the same panels", ["page", "term"], ["page", "term"], "none", 0],
    ];

    it.each(Rules)("%s", (_name, from, to, motion, steps) => {
        expect(cubeMotion(from, to)).toEqual({ motion, steps });
    });

    it("never slides one panel and never shows a prism in between: every change of a single panel is a turn", () => {
        for (const a of Carpet) {
            for (const b of Carpet.filter((id) => id !== a)) {
                expect(cubeMotion([a], [b]).motion).toBe("turn");
            }
        }
    });

    it("follows the developer's sequence: [1,2], tab 4, tab 2", () => {
        const first = startCube(view("companion", 2));
        // Tab 4 on [1,2]: both panels are replaced, the carpet comes to rest on [3,4].
        const second = nextCube(first, view("term", 2), true);
        expect(second.motion).toBe("prism-turn");
        expect(second.ids).toEqual(["term", "files"]);
        expect(cubeAngle(second)).toBe(-90);
        expect(frontIcons(second)).toEqual(["terminal", "file-lines"]);
        // Tab 2 on [3,4]: the carpet rests on [2,3], panel 3 stays: a slide, the cube does not turn again.
        const third = nextCube(second, view("page", 2), true);
        expect(third.motion).toBe("slide");
        expect(third.ids).toEqual(["page", "term"]);
        expect(cubeAngle(third)).toBe(-90);
        expect(third.slot).toBe(second.slot);
        expect(third.faces[third.slot].first).toBe(1);
        expect(frontIcons(third)).toEqual(["globe", "terminal"]);
    });

    it("turns the same way as the carpet moved, for a prism as for a cube", () => {
        const forward = nextCube(startCube(view("page", 2)), view("review", 2), true);
        const back = nextCube(startCube(view("review", 2)), view("page", 2), true);
        expect(forward.motion).toBe("prism-turn");
        expect(back.motion).toBe("prism-turn");
        expect(cubeAngle(forward)).toBe(-90);
        expect(cubeAngle(back)).toBe(90);
    });

    it("flips its parity with every turn, so two prism turns in a row do not share it", () => {
        let state = startCube(view("companion", 2));
        const parities: number[] = [cubeParity(state)];
        for (const first of ["term", "review", "term", "companion"]) {
            state = nextCube(state, view(first, 2), true);
            expect(state.motion).toBe("prism-turn");
            parities.push(cubeParity(state));
        }
        expect(parities).toEqual([0, 1, 0, 1, 0]);
        expect(cubeParity(nextCube(startCube(view("companion", 2)), view("review", 2), true))).toBe(1);
        expect(cubeParity({ ...state, turns: -1 })).toBe(1);
    });

    it("moves once for an action even if the rest of it is reported twice", () => {
        const rested = nextCube(startCube(view("companion", 2)), view("term", 2), true);
        expect(nextCube(rested, view("term", 2), true)).toBe(rested);
    });

    it("makes no motion at all under reduced motion, a prism included", () => {
        const state = nextCube(startCube(view("companion", 2)), view("term", 2), false);
        expect(state.motion).toBe("none");
        expect(cubeAngle(state)).toBe(0);
        expect(state.slot).toBe(0);
        expect(frontIcons(state)).toEqual(["terminal", "file-lines"]);
    });
});

describe("the carpet moves by a panel and another stays: the icons slide (#1861)", () => {
    it("slides forward when the carpet moves toward its end: the first panel leaves, a new one enters", () => {
        expect(cubeMotion(["page", "term"], ["term", "files"])).toEqual({ motion: "slide", steps: 1 });
        const state = nextCube(startCube(view("page", 2)), view("term", 2), true);
        expect(state.motion).toBe("slide");
        expect(state.slot).toBe(0);
        expect(cubeAngle(state)).toBe(0);
        expect(state.faces[0].first).toBe(2);
        expect(frontIcons(state)).toEqual(["terminal", "file-lines"]);
    });

    it("slides back when the carpet moves toward its start", () => {
        expect(cubeMotion(["term", "files"], ["page", "term"])).toEqual({ motion: "slide", steps: -1 });
        const state = nextCube(startCube(view("term", 2)), view("page", 2), true);
        expect(state.motion).toBe("slide");
        expect(state.faces[0].first).toBe(1);
        expect(cubeAngle(state)).toBe(0);
    });

    it("slides a three-panel prism by one panel, or by two while one stays", () => {
        expect(cubeMotion(["a", "b", "c"], ["b", "c", "d"])).toEqual({ motion: "slide", steps: 1 });
        expect(cubeMotion(["a", "b", "c"], ["c", "d", "e"])).toEqual({ motion: "slide", steps: 2 });
        expect(cubeMotion(["c", "d", "e"], ["a", "b", "c"])).toEqual({ motion: "slide", steps: -2 });
    });

    it("keeps the belt whole: the face still holds every carpet panel, only the first one on screen moves", () => {
        const state = nextCube(startCube(view("page", 2)), view("term", 2), true);
        expect(state.faces[0].panels.map((p) => p.id)).toEqual(Carpet);
    });

    it("a single panel on screen cannot slide: the one that stays does not exist, the cube turns", () => {
        expect(cubeMotion(["page"], ["term"])).toEqual({ motion: "turn", steps: 0 });
    });
});

describe("the number of panels on screen changes: the cube stretches (#1861)", () => {
    it("stretches from a cube to a prism and back, whichever panels", () => {
        expect(cubeMotion(["page"], ["page", "term"]).motion).toBe("stretch");
        expect(cubeMotion(["page", "term"], ["page"]).motion).toBe("stretch");
        expect(cubeMotion(["page", "term"], ["page", "term", "files"]).motion).toBe("stretch");
        expect(cubeMotion(["page", "term", "files"], ["term"]).motion).toBe("stretch");
        expect(cubeMotion(["page"], ["files", "review"]).motion).toBe("stretch");
    });

    it("writes the wider face in place: no turn, and the shape follows", () => {
        const state = nextCube(startCube(view("page")), view("page", 2), true);
        expect(state.motion).toBe("stretch");
        expect(state.slot).toBe(0);
        expect(cubeAngle(state)).toBe(0);
        expect(cubeShape(state)).toEqual({ cells: 2, more: 0 });
        expect(frontIcons(state)).toEqual(["globe", "terminal"]);
        const narrow = nextCube(state, view("page", 1), true);
        expect(narrow.motion).toBe("stretch");
        expect(cubeShape(narrow)).toEqual({ cells: 1, more: 0 });
    });

    it("stretches and settles when the count changes while the first panel changes too", () => {
        const state = nextCube(startCube(view("page", 2)), view("term", 1), true);
        expect(state.motion).toBe("stretch");
        expect(state.faces[0].first).toBe(2);
        expect(cubeAngle(state)).toBe(0);
    });
});

describe("a panel replaced while the others stay: the face just changes", () => {
    it("is no motion when the panels differ but one stays and nothing moved along the carpet", () => {
        expect(cubeMotion(["page", "term"], ["page", "files"])).toEqual({ motion: "none", steps: 0 });
        expect(cubeMotion(["page", "term"], ["term", "page"])).toEqual({ motion: "none", steps: 0 });
        const state = nextCube(startCube(view("page", 2)), view("page", 2, ["page", "files"]), true);
        expect(state.motion).toBe("none");
        expect(cubeAngle(state)).toBe(0);
        expect(frontIcons(state)).toEqual(["globe", "file-lines"]);
    });
});

describe("one icon per panel on screen, three at most, then +N (#1861)", () => {
    it.each([
        [1, 1, 0],
        [2, 2, 0],
        [3, 3, 0],
        [4, 3, 1],
        [6, 3, 3],
    ])("draws %i panels on screen as %i icons and +%i", (shown, cells, more) => {
        const state = startCube(view("companion", shown));
        expect(state.ids).toHaveLength(shown);
        expect(cubeShape(state)).toEqual({ cells, more });
        expect(MaxCubeCells).toBe(3);
    });

    it("draws the icons in carpet order, one per panel", () => {
        const state = startCube(view("page", 3));
        expect(frontIcons(state, 3)).toEqual(["globe", "terminal", "file-lines"]);
        expect(frontIcons(startCube(view("page", 2)))).toEqual(["globe", "terminal"]);
    });

    it("never shows more panels than the carpet holds from the first one on", () => {
        expect(shownIds(view("agent", 3))).toEqual(["agent"]);
        expect(shownIds(view("review", 3))).toEqual(["review", "agent"]);
    });

    it("counts four panels on screen as three icons and +1, then +0 once one leaves", () => {
        const four = nextCube(startCube(view("page", 3)), view("page", 4), true);
        expect(cubeShape(four)).toEqual({ cells: 3, more: 1 });
        expect(four.motion).toBe("stretch");
        expect(cubeShape(nextCube(four, view("page", 3), true))).toEqual({ cells: 3, more: 0 });
    });
});

describe("reduced motion: just the new face", () => {
    it("never turns, slides or stretches: whichever change comes, the front face holds the new panels", () => {
        let state = startCube(view("page"));
        state = nextCube(state, view("files"), false);
        expect(cubeAngle(state)).toBe(0);
        expect(state.motion).toBe("none");
        expect(frontIcons(state)).toEqual(["file-lines"]);
        state = nextCube(state, view("companion"), false);
        expect(cubeAngle(state)).toBe(0);
        expect(state.id).toBe("companion");
        state = nextCube(state, view("companion", 2), false);
        expect(state.motion).toBe("none");
        expect(cubeShape(state)).toEqual({ cells: 2, more: 0 });
        state = nextCube(state, view("page", 2), false);
        expect(state.motion).toBe("none");
        expect(state.slot).toBe(0);
        expect(cubeAngle(state)).toBe(0);
        expect(frontIcons(state)).toEqual(["globe", "terminal"]);
    });
});
