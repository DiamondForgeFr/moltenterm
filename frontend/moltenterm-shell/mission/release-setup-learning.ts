// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the pipeline setup learns of the developer (FR-LRN-004, DS-LRN-005): six choices of the description step that are
// the developer's habits and not facts about a project. A finished run teaches the ones the developer changed from the
// proposal; the next description opens on them, marked as coming from the earlier choices. Pure functions, tested
// without the app.

import {
    correctionsToLearn,
    FlagOff,
    FlagOn,
    LearnAction,
    LearningDefaults,
    PrefillField,
} from "../learning/learning-model";
import type { DescribeFrom } from "./release-setup-describe-model";
import { SetupChoice, SetupDraft, SetupOptions, validTagPrefix } from "./release-setup-model";
import type { SetupPath } from "./release-setup-stepper";

export const PipelineLearningKeys = ["merge", "rcformat", "tagprefix", "notes", "milestone", "syncback"] as const;
export type PipelineLearningKey = (typeof PipelineLearningKeys)[number];

function choiceAllowed(choices: SetupChoice[], id: string): boolean {
    return (choices ?? []).some((c) => c.id === id && c.allowed);
}

function flag(on: boolean): string {
    return on ? FlagOn : FlagOff;
}

// The fields of the options that learn, for the draft in hand: a learned value only goes where the draft allows it.
export function pipelineLearningFields(draft: SetupDraft): PrefillField<SetupOptions>[] {
    const isFlag = (_o: SetupOptions, text: string) => text === FlagOn || text === FlagOff;
    return [
        {
            key: "merge",
            read: (o) => o.merge ?? "",
            write: (o, text) => ({ ...o, merge: text }),
            allowed: (_o, text) => choiceAllowed(draft?.merges, text),
        },
        {
            key: "rcformat",
            read: (o) => o.rcformat ?? "",
            write: (o, text) => ({ ...o, rcformat: text }),
            allowed: (_o, text) => choiceAllowed(draft?.rcformats, text),
        },
        {
            key: "tagprefix",
            read: (o) => o.tagprefix ?? "",
            write: (o, text) => ({ ...o, tagprefix: text }),
            allowed: (_o, text) => validTagPrefix(text),
        },
        {
            key: "notes",
            read: (o) => flag(!!o.notes),
            write: (o, text) => ({ ...o, notes: text === FlagOn }),
            allowed: isFlag,
        },
        {
            key: "milestone",
            read: (o) => flag(!!o.milestone),
            write: (o, text) => ({ ...o, milestone: text === FlagOn }),
            allowed: (o, text) => isFlag(o, text) && !!draft?.facts?.ongithub,
        },
        {
            key: "syncback",
            read: (o) => flag(!!o.syncback),
            write: (o, text) => ({ ...o, syncback: text === FlagOn }),
            allowed: (o, text) => isFlag(o, text) && o.branchmodel !== "single",
        },
    ];
}

// Only the description that started from the standard questions teaches and is prefilled: a model project or a saved
// template brings choices of its own, which are not the developer's habits.
export function learnsFrom(path: SetupPath, from: DescribeFrom, kind: SetupOptions["kind"]): boolean {
    return path === "describe" && from === "standard" && kind !== "saas";
}

// What a finished run teaches: the choices ended on a value other than the proposal (draft.defaults), and the earlier
// corrections the developer put back to the proposal.
export function pipelineLessons(draft: SetupDraft, options: SetupOptions, learned: LearningDefaults): LearnAction[] {
    if (draft == null || options == null) {
        return [];
    }
    return correctionsToLearn(options, draft.defaults, learned, pipelineLearningFields(draft));
}
