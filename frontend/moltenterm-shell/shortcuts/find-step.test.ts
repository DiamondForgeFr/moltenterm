// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Find next and previous from the keyboard (#1759, FR-SHELL-139 AC10, TC-SHELL-254-3).

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FindSteps, registerFindSteps, stepFind } from "./find-step";

const SearchSource = fs.readFileSync(path.resolve(__dirname, "../../app/element/search.tsx"), "utf8");

function bar() {
    const calls: string[] = [];
    const steps: FindSteps = { next: () => void calls.push("next"), prev: () => void calls.push("prev") };
    return { key: {}, ref: { current: steps }, calls };
}

describe("find next and previous", () => {
    it("steps the open bar forward and back", () => {
        const b = bar();
        registerFindSteps(b.key, b.ref);
        expect(stepFind(b.key, true, 1)).toBe(true);
        expect(stepFind(b.key, true, -1)).toBe(true);
        expect(b.calls).toEqual(["next", "prev"]);
    });

    it("does nothing with the bar closed, so that ⌘G keeps its other meaning", () => {
        const b = bar();
        registerFindSteps(b.key, b.ref);
        expect(stepFind(b.key, false, 1)).toBe(false);
        expect(b.calls).toEqual([]);
    });

    it("does nothing for a panel with no bar", () => {
        expect(stepFind(undefined, true, 1)).toBe(false);
        expect(stepFind({}, true, 1)).toBe(false);
    });

    it("keeps each bar apart", () => {
        const first = bar();
        const second = bar();
        registerFindSteps(first.key, first.ref);
        registerFindSteps(second.key, second.ref);
        stepFind(second.key, true, 1);
        expect(first.calls).toEqual([]);
        expect(second.calls).toEqual(["next"]);
    });

    it("calls the latest callbacks of the bar, as it renders them into the ref", () => {
        const b = bar();
        registerFindSteps(b.key, b.ref);
        const later: string[] = [];
        b.ref.current = { next: () => void later.push("next"), prev: () => void later.push("prev") };
        stepFind(b.key, true, 1);
        expect(b.calls).toEqual([]);
        expect(later).toEqual(["next"]);
    });

    it("forgets a bar when it unmounts, and an old bar's cleanup does not forget a newer one", () => {
        const b = bar();
        const stop = registerFindSteps(b.key, b.ref);
        stop();
        expect(stepFind(b.key, true, 1)).toBe(false);

        const older = bar();
        const stopOlder = registerFindSteps(older.key, older.ref);
        const newer = { current: { next: () => void older.calls.push("newer"), prev: () => {} } };
        registerFindSteps(older.key, newer);
        stopOlder();
        expect(stepFind(older.key, true, 1)).toBe(true);
        expect(older.calls).toEqual(["newer"]);
    });
});

describe("the find bar component", () => {
    it("registers its steps under its isOpen atom, from the callbacks it renders", () => {
        expect(SearchSource).toContain('from "../../moltenterm-shell/shortcuts/find-step"');
        expect(SearchSource).toMatch(/stepsRef\.current = \{ next: onNextWrapper, prev: onPrevWrapper \}/);
        expect(SearchSource).toMatch(/useEffect\(\(\) => registerFindSteps\(isOpenAtom, stepsRef\), \[isOpenAtom\]\)/);
    });
});
