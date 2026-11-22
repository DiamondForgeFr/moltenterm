// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The options of each block of the companion while arranging (FR-SHELL-018, #2459): what its settings popover lists. They
// are the choices the blocks already had, gathered, and none is new: shown and full width are every block's; the plan
// usage adds its form and its attaching (#2450); the milestone block its three groups' open or folded state (#2418,
// #2454); the changed files whether every file is listed (#555). A layout option is saved with the layout; a preference
// option in the companion's remembered choices (companion-prefs.ts), the same store, as it is set. Pure, so it is tested
// without a window.

import { setSectionHidden, setSectionSpan, setUsageAttached, setUsageMinimal } from "./companion-arrange-model";
import type { CompanionPrefs } from "./companion-files-model";
import { CompanionLayout, CompanionSectionId, normalizeLayout, SectionPlacement } from "./companion-layout";

// The remembered choices that are a block's option (a yes or a no).
export type BlockPrefKey = "filesopen" | "takenopen" | "idleopen" | "reviewopen";

// The placement fields an option sets, as the arranging mode's drafted layout holds them.
export type LayoutOptionKey = "shown" | "wide" | "minimal" | "attached";

export type BlockOptionKey = LayoutOptionKey | BlockPrefKey;

export type BlockOption = {
    key: BlockOptionKey;
    // A layout option is drafted with the layout and saved when the mode is left; a preference is saved as it is set.
    store: "layout" | "pref";
    // The form of the usage is two words to choose between, the others a yes or a no.
    kind: "toggle" | "choice";
    labelKey: string;
    helpKey?: string;
};

const Shown: BlockOption = {
    key: "shown",
    store: "layout",
    kind: "toggle",
    labelKey: "companion.arrange.opt.shown",
    helpKey: "companion.arrange.opt.shownHelp",
};

const Wide: BlockOption = {
    key: "wide",
    store: "layout",
    kind: "toggle",
    labelKey: "companion.arrange.opt.wide",
    helpKey: "companion.arrange.opt.wideHelp",
};

const Form: BlockOption = {
    key: "minimal",
    store: "layout",
    kind: "choice",
    labelKey: "companion.arrange.opt.form",
    helpKey: "companion.arrange.formMinimalHelp",
};

const Attach: BlockOption = {
    key: "attached",
    store: "layout",
    kind: "toggle",
    labelKey: "companion.arrange.attach",
    helpKey: "companion.arrange.attachHelp",
};

const Groups: BlockOption[] = [
    {
        key: "takenopen",
        store: "pref",
        kind: "toggle",
        labelKey: "companion.arrange.opt.takenOpen",
        helpKey: "companion.arrange.opt.groupHelp",
    },
    {
        key: "reviewopen",
        store: "pref",
        kind: "toggle",
        labelKey: "companion.arrange.opt.reviewOpen",
        helpKey: "companion.arrange.opt.groupHelp",
    },
    {
        key: "idleopen",
        store: "pref",
        kind: "toggle",
        labelKey: "companion.arrange.opt.idleOpen",
        helpKey: "companion.arrange.opt.groupHelp",
    },
];

const EveryFile: BlockOption = {
    key: "filesopen",
    store: "pref",
    kind: "toggle",
    labelKey: "companion.arrange.opt.filesAll",
    helpKey: "companion.arrange.opt.filesAllHelp",
};

const OwnOptions: Partial<Record<CompanionSectionId, BlockOption[]>> = {
    usage: [Form, Attach],
    tasks: Groups,
    files: [EveryFile],
};

// A block's options, in the order its popover lists them: shown, full width, then its own.
export function optionsOf(id: CompanionSectionId): BlockOption[] {
    return [Shown, Wide, ...(OwnOptions[id] ?? [])];
}

// The choices a preference option has before the developer made one: the milestone block opens its Taken by others group
// while it is wide, so it has no stored answer until one is made (#2418).
export type PrefDefaults = Partial<Record<BlockPrefKey, boolean>>;

export function optionValue(
    option: BlockOption,
    placement: SectionPlacement,
    prefs: CompanionPrefs,
    defaults: PrefDefaults = {}
): boolean {
    switch (option.key) {
        case "shown":
            return placement.hidden !== true;
        case "wide":
            return placement.span === "full";
        case "minimal":
            return placement.minimal === true;
        case "attached":
            return placement.attached === true;
        default:
            return prefs?.[option.key] ?? defaults[option.key] ?? false;
    }
}

// The layout with a layout option set. A preference option leaves it as it is: it is saved elsewhere.
export function setLayoutOption(
    layout: CompanionLayout,
    id: CompanionSectionId,
    option: BlockOption,
    value: boolean
): CompanionLayout {
    switch (option.key) {
        case "shown":
            return setSectionHidden(layout, id, !value);
        case "wide":
            return setSectionSpan(layout, id, value ? "full" : "flow");
        case "minimal":
            return id === "usage" ? setUsageMinimal(layout, value) : normalizeLayout(layout);
        case "attached":
            return id === "usage" ? setUsageAttached(layout, value) : normalizeLayout(layout);
        default:
            return normalizeLayout(layout);
    }
}

// What the screen reader hears once an option is set, a key of companion.arrange and the variables it takes.
export function optionAnnouncement(option: BlockOption, value: boolean): string {
    switch (option.key) {
        case "shown":
            return value ? "companion.arrange.shownNow" : "companion.arrange.hiddenNow";
        case "wide":
            return value ? "companion.arrange.wideOn" : "companion.arrange.wideOff";
        case "minimal":
            return value ? "companion.arrange.minimalOn" : "companion.arrange.minimalOff";
        case "attached":
            return value ? "companion.arrange.attachOn" : "companion.arrange.attachOff";
        default:
            return value ? "companion.arrange.opt.setOn" : "companion.arrange.opt.setOff";
    }
}
