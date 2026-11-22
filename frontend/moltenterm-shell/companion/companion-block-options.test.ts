// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import en from "../i18n/locales/en.json";
import fr from "../i18n/locales/fr.json";
import {
    SectionNameKeys,
    setSectionHidden,
    setSectionSpan,
    setUsageAttached,
    setUsageMinimal,
} from "./companion-arrange-model";
import {
    BlockOption,
    BlockPrefKey,
    optionAnnouncement,
    optionsOf,
    optionValue,
    setLayoutOption,
} from "./companion-block-options";
import { CompanionPrefs, readCompanionPrefs } from "./companion-files-model";
import {
    CompanionLayout,
    CompanionSectionIds,
    DefaultCompanionLayout,
    normalizeLayout,
    readStoredLayout,
    SectionPlacement,
} from "./companion-layout";

const keysOf = (id: (typeof CompanionSectionIds)[number]) => optionsOf(id).map((o) => o.key);
const placementOf = (layout: CompanionLayout, id: string): SectionPlacement => layout.find((p) => p.id === id);
const option = (id: (typeof CompanionSectionIds)[number], key: string): BlockOption =>
    optionsOf(id).find((o) => o.key === key);

// A restart: what is stored is JSON in the client's settings, and what the companion reads back is what it makes of it.
const restart = (layout: CompanionLayout): CompanionLayout => readStoredLayout(JSON.parse(JSON.stringify(layout)));
const restartPrefs = (prefs: CompanionPrefs): CompanionPrefs => readCompanionPrefs(JSON.parse(JSON.stringify(prefs)));

function text(dictionary: unknown, key: string): string {
    return key.split(".").reduce<any>((node, part) => node?.[part], dictionary);
}

describe("the options of each block while arranging (#2459)", () => {
    it("gives every block shown and full width, in that order, and nothing it did not have", () => {
        for (const id of CompanionSectionIds) {
            expect(keysOf(id).slice(0, 2), id).toEqual(["shown", "wide"]);
        }
        expect(keysOf("agents")).toEqual(["shown", "wide"]);
        expect(keysOf("topics")).toEqual(["shown", "wide"]);
        expect(keysOf("answer")).toEqual(["shown", "wide"]);
        expect(keysOf("task")).toEqual(["shown", "wide"]);
        expect(keysOf("permission")).toEqual(["shown", "wide"]);
    });

    it("gives the plan usage its form and its attaching, the milestone block its three groups, the files their list", () => {
        expect(keysOf("usage")).toEqual(["shown", "wide", "minimal", "attached"]);
        expect(keysOf("tasks")).toEqual(["shown", "wide", "takenopen", "reviewopen", "idleopen"]);
        expect(keysOf("files")).toEqual(["shown", "wide", "filesopen"]);
    });

    it("saves the layout's options with the layout and the others in the companion's settings", () => {
        for (const id of CompanionSectionIds) {
            for (const o of optionsOf(id)) {
                expect(o.store, `${id} ${o.key}`).toBe(
                    ["shown", "wide", "minimal", "attached"].includes(o.key) ? "layout" : "pref"
                );
            }
        }
    });

    it("has a name for every option in both languages, and a help text where it names one", () => {
        for (const id of CompanionSectionIds) {
            for (const o of optionsOf(id)) {
                for (const key of [o.labelKey, o.helpKey, optionAnnouncement(o, true), optionAnnouncement(o, false)]) {
                    if (key == null) {
                        continue;
                    }
                    expect(typeof text(en, key), `en ${key}`).toBe("string");
                    expect(typeof text(fr, key), `fr ${key}`).toBe("string");
                }
            }
        }
        for (const id of CompanionSectionIds) {
            expect(typeof text(en, SectionNameKeys[id])).toBe("string");
        }
    });

    it("reads each layout option from the placement, with every default as before", () => {
        const none: CompanionPrefs = {};
        for (const id of CompanionSectionIds) {
            const p = placementOf(DefaultCompanionLayout, id);
            expect(optionValue(option(id, "shown"), p, none), id).toBe(true);
            expect(optionValue(option(id, "wide"), p, none), id).toBe(id === "permission");
        }
        const usage = placementOf(DefaultCompanionLayout, "usage");
        expect(optionValue(option("usage", "minimal"), usage, none)).toBe(false);
        expect(optionValue(option("usage", "attached"), usage, none)).toBe(false);
        expect(optionValue(option("usage", "minimal"), { ...usage, minimal: true }, none)).toBe(true);
        expect(optionValue(option("usage", "attached"), { ...usage, attached: true }, none)).toBe(true);
        expect(optionValue(option("topics", "shown"), { id: "topics", span: "flow", hidden: true }, none)).toBe(false);
    });

    it("reads each preference option from the settings, folded until the developer opens it", () => {
        const tasks = placementOf(DefaultCompanionLayout, "tasks");
        for (const key of ["takenopen", "reviewopen", "idleopen"] as BlockPrefKey[]) {
            expect(optionValue(option("tasks", key), tasks, {}), key).toBe(false);
            expect(optionValue(option("tasks", key), tasks, { [key]: true }), key).toBe(true);
        }
        expect(
            optionValue(option("files", "filesopen"), placementOf(DefaultCompanionLayout, "files"), { filesopen: true })
        ).toBe(true);
    });

    it("lets a wide milestone block open its Taken by others group before any choice, as it does", () => {
        const tasks = placementOf(DefaultCompanionLayout, "tasks");
        const taken = option("tasks", "takenopen");
        expect(optionValue(taken, tasks, {}, { takenopen: true })).toBe(true);
        expect(optionValue(taken, tasks, { takenopen: false }, { takenopen: true })).toBe(false);
        expect(optionValue(taken, tasks, { takenopen: true }, { takenopen: false })).toBe(true);
    });

    it("sets each layout option on the drafted layout, the others untouched", () => {
        const shown = setLayoutOption(DefaultCompanionLayout, "files", option("files", "shown"), false);
        expect(shown).toEqual(setSectionHidden(DefaultCompanionLayout, "files", true));
        const wide = setLayoutOption(DefaultCompanionLayout, "topics", option("topics", "wide"), true);
        expect(wide).toEqual(setSectionSpan(DefaultCompanionLayout, "topics", "full"));
        expect(setLayoutOption(wide, "topics", option("topics", "wide"), false)).toEqual(DefaultCompanionLayout);
        const minimal = setLayoutOption(DefaultCompanionLayout, "usage", option("usage", "minimal"), true);
        expect(minimal).toEqual(setUsageMinimal(DefaultCompanionLayout, true));
        const attached = setLayoutOption(minimal, "usage", option("usage", "attached"), true);
        expect(attached).toEqual(setUsageAttached(setUsageMinimal(DefaultCompanionLayout, true), true));
        expect(setLayoutOption(attached, "usage", option("usage", "attached"), false)).toEqual(minimal);
    });

    it("leaves the layout as it is for a preference option, and for a usage choice of another block", () => {
        const layout = setSectionHidden(DefaultCompanionLayout, "answer", true);
        expect(setLayoutOption(layout, "files", option("files", "filesopen"), true)).toEqual(layout);
        expect(setLayoutOption(layout, "tasks", option("tasks", "idleopen"), true)).toEqual(layout);
        expect(setLayoutOption(layout, "topics", optionsOf("usage")[2], true)).toEqual(layout);
        expect(setLayoutOption(layout, "topics", optionsOf("usage")[3], true)).toEqual(layout);
    });

    it("keeps every layout option across a restart, for every block", () => {
        let layout: CompanionLayout = DefaultCompanionLayout;
        for (const id of CompanionSectionIds) {
            layout = setLayoutOption(layout, id, option(id, "shown"), id === "answer" ? false : true);
            layout = setLayoutOption(layout, id, option(id, "wide"), id !== "permission");
        }
        layout = setLayoutOption(layout, "usage", option("usage", "minimal"), true);
        layout = setLayoutOption(layout, "usage", option("usage", "attached"), true);
        const back = restart(layout);
        expect(back).toEqual(normalizeLayout(layout));
        for (const id of CompanionSectionIds) {
            const before = placementOf(layout, id);
            const after = placementOf(back, id);
            for (const key of ["shown", "wide"]) {
                expect(optionValue(option(id, key), after, {}), `${id} ${key}`).toBe(
                    optionValue(option(id, key), before, {})
                );
            }
        }
        expect(optionValue(option("usage", "minimal"), placementOf(back, "usage"), {})).toBe(true);
        expect(optionValue(option("usage", "attached"), placementOf(back, "usage"), {})).toBe(true);
        expect(optionValue(option("answer", "shown"), placementOf(back, "answer"), {})).toBe(false);
        expect(optionValue(option("permission", "wide"), placementOf(back, "permission"), {})).toBe(false);
    });

    it("keeps every preference option across a restart", () => {
        const set: CompanionPrefs = { filesopen: true, takenopen: false, idleopen: true, reviewopen: true };
        const back = restartPrefs(set);
        for (const id of ["tasks", "files"] as const) {
            for (const o of optionsOf(id).filter((x) => x.store === "pref")) {
                const placement = placementOf(DefaultCompanionLayout, id);
                expect(optionValue(o, placement, back, { takenopen: true }), `${id} ${o.key}`).toBe(
                    optionValue(o, placement, set, { takenopen: true })
                );
            }
        }
        expect(back.takenopen).toBe(false);
        expect(restartPrefs({ takenopen: true }).takenopen).toBe(true);
        expect(restartPrefs({}).takenopen).toBeUndefined();
    });

    it("says what an option did, for the screen reader", () => {
        expect(optionAnnouncement(option("files", "shown"), false)).toBe("companion.arrange.hiddenNow");
        expect(optionAnnouncement(option("files", "shown"), true)).toBe("companion.arrange.shownNow");
        expect(optionAnnouncement(option("files", "wide"), true)).toBe("companion.arrange.wideOn");
        expect(optionAnnouncement(option("usage", "minimal"), true)).toBe("companion.arrange.minimalOn");
        expect(optionAnnouncement(option("usage", "attached"), false)).toBe("companion.arrange.attachOff");
        expect(optionAnnouncement(option("files", "filesopen"), true)).toBe("companion.arrange.opt.setOn");
    });
});
