// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { Atom, atom, createStore, PrimitiveAtom } from "jotai";
import { describe, expect, it } from "vitest";
import { tabHasUnsavedWork, viewHasUnsavedWork } from "./unsaved-work";

const store = createStore();
const get = <T>(a: Atom<T>): T => store.get(a);

describe("unsaved work in a tab view (#476)", () => {
    it("sees a preview with edits not saved", () => {
        const content = atom<string>(null) as PrimitiveAtom<string>;
        const vm = { viewType: "preview", newFileContent: content };
        expect(viewHasUnsavedWork(vm, get)).toBe(false);
        store.set(content, "edited");
        expect(viewHasUnsavedWork(vm, get)).toBe(true);
        store.set(content, null);
        expect(viewHasUnsavedWork(vm, get)).toBe(false);
    });

    it("sees a configuration file edited and not saved", () => {
        const edited = atom(false) as PrimitiveAtom<boolean>;
        const vm = { viewType: "waveconfig", hasEditedAtom: edited };
        expect(viewHasUnsavedWork(vm, get)).toBe(false);
        store.set(edited, true);
        expect(viewHasUnsavedWork(vm, get)).toBe(true);
    });

    it("ignores views that keep nothing in memory, and missing models", () => {
        expect(tabHasUnsavedWork([{ viewType: "term" }, null, { viewType: "sysinfo" }], get)).toBe(false);
        expect(tabHasUnsavedWork(null, get)).toBe(false);
    });

    it("answers for the whole tab", () => {
        const content = atom<string>("x") as PrimitiveAtom<string>;
        expect(tabHasUnsavedWork([{ viewType: "term" }, { viewType: "preview", newFileContent: content }], get)).toBe(
            true
        );
    });
});
