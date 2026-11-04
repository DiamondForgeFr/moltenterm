// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What a guided workflow learned of the developer (FR-LRN-001 to FR-LRN-004, MANIFESTO principle 9): the route's names
// and types, and the rules a workflow view reads its defaults by: which answers to prefill, which steps to fold, which
// adjustments to record at the end of a run. Pure functions, tested without the app.

// must match pkg/molten/agentlearning.go
export const LearningRoute = "molten:learning";
export const LearningEvent = "molten:learning";
export const LearningAllScope = "all";
export const LearningListCommand = "moltenlearninglist";
export const LearningDefaultsCommand = "moltenlearningdefaults";
export const LearningRecordCommand = "moltenlearningrecord";
export const LearningForgetCommand = "moltenlearningforget";
export const LearningEditCommand = "moltenlearningedit";
export const LearningResetCommand = "moltenlearningreset";

export const WorkflowPipelineSetup = "pipeline-setup";
export const WorkflowMorphDesign = "morph-design";
export const LearningWorkflows = [WorkflowPipelineSetup, WorkflowMorphDesign];

export const KindAnswer = "answer";
export const KindSkip = "skip";
export const KindCorrection = "correction";
export const KindPreference = "preference";
export const KindDone = "done";
export type LearningKind = "answer" | "skip" | "correction" | "preference";

export const ByView = "view";
export const ByAgent = "agent";
export const ByUser = "user";

export type LearningConfidence = "low" | "medium" | "high";

// A step skipped in this many runs in a row is folded.
export const FoldAfterSeen = 2;

export type LearningSource = { run?: string; at: number; by: string };

export type LearningItem = {
    id: string;
    kind: LearningKind;
    key: string;
    value?: string;
    proposed?: string;
    seen: number;
    confidence: LearningConfidence;
    first: number;
    source: LearningSource;
    edited?: boolean;
};

export type LearningWorkflow = { workflow: string; items: LearningItem[] };
export type LearningList = { workflows: LearningWorkflow[] };
export type LearningDefaults = { workflow: string; prefill: LearningItem[]; folded: LearningItem[] };

export function emptyDefaults(workflow: string): LearningDefaults {
    return { workflow, prefill: [], folded: [] };
}

export function holdsValue(kind: string): boolean {
    return kind === KindAnswer || kind === KindCorrection || kind === KindPreference;
}

// The learned item of a key: the most seen one when a key was learned under several kinds.
export function prefillItem(defaults: LearningDefaults, key: string): LearningItem {
    return (defaults?.prefill ?? []).find((item) => item.key === key) ?? null;
}

export function prefillValue(defaults: LearningDefaults, key: string): string {
    return prefillItem(defaults, key)?.value ?? null;
}

export function prefillMap(defaults: LearningDefaults): Record<string, LearningItem> {
    const map: Record<string, LearningItem> = {};
    for (const item of defaults?.prefill ?? []) {
        if (map[item.key] == null) {
            map[item.key] = item;
        }
    }
    return map;
}

// The steps the developer skipped in the last runs in a row: shown folded, never removed.
export function foldedSteps(defaults: LearningDefaults): string[] {
    return (defaults?.folded ?? []).filter((item) => item.seen >= FoldAfterSeen).map((item) => item.key);
}

export function isFolded(defaults: LearningDefaults, step: string): boolean {
    return foldedSteps(defaults).includes(step);
}

// A field of a workflow's values that learning can prefill: how the field reads as text, how a learned text is
// written back, and whether the workflow accepts that text here (a choice the draft refuses, a switch the project has
// no use for).
export type PrefillField<T> = {
    key: string;
    read: (values: T) => string;
    write: (values: T, text: string) => T;
    allowed?: (values: T, text: string) => boolean;
};

export type Prefilled<T> = { values: T; prefilled: Record<string, string> };

// The values with the learned texts written in. A field already holding the learned text is not marked: only what the
// learning changed is "based on your earlier choices".
export function applyPrefill<T>(values: T, defaults: LearningDefaults, fields: PrefillField<T>[]): Prefilled<T> {
    const learned = prefillMap(defaults);
    let next = values;
    const prefilled: Record<string, string> = {};
    for (const field of fields) {
        const item = learned[field.key];
        if (item == null || item.value == null || item.value === "" || field.read(next) === item.value) {
            continue;
        }
        if (field.allowed != null && !field.allowed(next, item.value)) {
            continue;
        }
        next = field.write(next, item.value);
        prefilled[field.key] = item.value;
    }
    return { values: next, prefilled };
}

// The keys whose current value is still the prefilled one: the mark goes as soon as the developer changes the field.
export function stillPrefilled<T>(values: T, prefilled: Record<string, string>, fields: PrefillField<T>[]): string[] {
    return fields.filter((f) => prefilled[f.key] != null && f.read(values) === prefilled[f.key]).map((f) => f.key);
}

export type LearnAction =
    | { op: "record"; kind: LearningKind; key: string; value: string; proposed?: string }
    | { op: "forget"; id: string };

// What a finished run teaches. A field the developer ended on a value other than the proposal is a correction (the
// same value as an earlier run confirms it, another replaces it); a field put back to the proposal forgets the
// correction an earlier run left, since the developer no longer corrects it.
export function correctionsToLearn<T>(
    finals: T,
    proposals: T,
    defaults: LearningDefaults,
    fields: PrefillField<T>[]
): LearnAction[] {
    const learned = prefillMap(defaults);
    const actions: LearnAction[] = [];
    for (const field of fields) {
        const final = field.read(finals);
        const proposed = field.read(proposals);
        if (final === "") {
            continue;
        }
        if (final !== proposed) {
            actions.push({ op: "record", kind: KindCorrection, key: field.key, value: final, proposed });
            continue;
        }
        const earlier = learned[field.key];
        if (earlier != null && earlier.value !== final) {
            actions.push({ op: "forget", id: earlier.id });
        }
    }
    return actions;
}

export const MaxRunLabel = 80;

// A run's label as the store takes it: one line, no control characters, at most MaxRunLabel characters.
export function runLabel(text: string): string {
    // eslint-disable-next-line no-control-regex
    const oneLine = (text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
    return Array.from(oneLine).slice(0, MaxRunLabel).join("").trim();
}

export function confidenceKey(confidence: string): string {
    return `learning.confidence.${confidence === "high" || confidence === "medium" ? confidence : "low"}`;
}

export type LearnedKeyControl = "choice" | "flag" | "text";

// How the interface words a key a workflow's view records: its title, and how its value reads. A key the interface
// does not know (an agent recorded it) is shown as recorded, as data.
export type LearnedKeyInfo = {
    titleKey: string;
    control: LearnedKeyControl;
    // choice: the option ids, and the key of each one's name.
    choices?: string[];
    choiceKey?: (id: string) => string;
};

export type LearnedWorkflowInfo = { nameKey: string; keys: Record<string, LearnedKeyInfo> };

export const MergeChoices = ["merge", "squash", "rebase"];
export const RcFormatChoices = ["numeric", "rcdot"];

export const LearnedWorkflowInfos: Record<string, LearnedWorkflowInfo> = {
    [WorkflowPipelineSetup]: {
        nameKey: "learning.workflow.pipelineSetup",
        keys: {
            merge: {
                titleKey: "learning.keys.pipelineSetup.merge",
                control: "choice",
                choices: MergeChoices,
                choiceKey: (id) => `mc.setup.merge.${id}`,
            },
            rcformat: {
                titleKey: "learning.keys.pipelineSetup.rcformat",
                control: "choice",
                choices: RcFormatChoices,
                choiceKey: (id) => `learning.value.rcformat.${id}`,
            },
            tagprefix: { titleKey: "learning.keys.pipelineSetup.tagprefix", control: "text" },
            notes: { titleKey: "learning.keys.pipelineSetup.notes", control: "flag" },
            milestone: { titleKey: "learning.keys.pipelineSetup.milestone", control: "flag" },
            syncback: { titleKey: "learning.keys.pipelineSetup.syncback", control: "flag" },
        },
    },
    [WorkflowMorphDesign]: { nameKey: "learning.workflow.morphDesign", keys: {} },
};

export function workflowInfo(workflow: string): LearnedWorkflowInfo {
    return LearnedWorkflowInfos[workflow] ?? null;
}

export function keyInfo(workflow: string, key: string): LearnedKeyInfo {
    return workflowInfo(workflow)?.keys[key] ?? null;
}

export const FlagOn = "true";
export const FlagOff = "false";

export type TextOf = (key: string, vars?: Record<string, string | number>) => string;

// A value as the developer reads it: a choice by its name, a switch as yes or no, the rest as it was recorded.
export function valueText(workflow: string, key: string, value: string, tr: TextOf): string {
    const info = keyInfo(workflow, key);
    if (info?.control === "flag" && (value === FlagOn || value === FlagOff)) {
        return tr(value === FlagOn ? "learning.value.yes" : "learning.value.no");
    }
    if (info?.control === "choice" && info.choices?.includes(value) && info.choiceKey != null) {
        return tr(info.choiceKey(value), { prefix: "" });
    }
    return value;
}

// What an item is about: the key's title, or the key itself when the interface does not know it.
export function itemTitle(workflow: string, item: LearningItem, tr: TextOf): string {
    const info = keyInfo(workflow, item.key);
    return info != null ? tr(info.titleKey) : item.key;
}

// An item as a plain sentence, in the interface language.
export function itemSentence(workflow: string, item: LearningItem, tr: TextOf): string {
    const title = itemTitle(workflow, item, tr);
    const value = valueText(workflow, item.key, item.value ?? "", tr);
    if (item.kind === KindSkip) {
        return tr("learning.sentence.skip", { title });
    }
    if (item.kind === KindCorrection && item.proposed) {
        return tr("learning.sentence.correctionFrom", {
            title,
            value,
            proposed: valueText(workflow, item.key, item.proposed, tr),
        });
    }
    return tr(`learning.sentence.${item.kind}`, { title, value });
}
