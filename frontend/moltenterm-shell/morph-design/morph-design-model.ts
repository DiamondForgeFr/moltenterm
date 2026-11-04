// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The mod design view (FR-MORPH-019, DS-MORPH-016): the names it shares with wavesrv (pkg/molten/agentmorphdesign.go,
// pkg/molten/morphdesign) and the rules the panel reads a design by. Kept free of React and of the app's stores, so the
// tab strip and the tests read them without loading the panel.

import { foldedSteps, LearningDefaults, prefillValue } from "../learning/learning-model";

// must match pkg/molten/agentmorphdesign.go
export const MorphDesignRoute = "molten:morphdesign";
export const MorphDesignEvent = "molten:morphdesign";
export const MorphDesignHandoffEvent = "molten:morphdesign:handoff";
export const MorphDesignTabCommand = "moltenmorphdesigntab";
export const MorphDesignStateCommand = "moltenmorphdesignstate";
export const MorphDesignChooseCommand = "moltenmorphdesignchoose";
export const MorphDesignSkipCommand = "moltenmorphdesignskip";
export const MorphDesignDecideCommand = "moltenmorphdesigndecide";

// must match pkg/molten/morphdesign/tab.go
export const MoltentermMorphDesignView = "molten-morphdesign";
export const MorphDesignPanelMetaKey = "molten:morphdesign";
export const MorphDesignTermMetaKey = "molten:morphdesignterm";
export const MorphDesignTabIcon = "wand-magic-sparkles";

export const MorphSteps = ["need", "questions", "plan", "preview", "adjust", "finish", "validate", "collect"] as const;
export type MorphStepId = (typeof MorphSteps)[number];

export type MorphStepState = "todo" | "done" | "skipped";
export type MorphBy = "agent" | "panel" | "terminal";

export type MorphStep = { id: MorphStepId; state: MorphStepState; by?: MorphBy; say?: string };
export type MorphChoice = { label: string; detail?: string };
export type MorphQuestion = {
    key: string;
    step: MorphStepId;
    text: string;
    kind: "choice" | "icon";
    choices: MorphChoice[];
    recommended?: string;
    answer?: string;
    answeredby?: MorphBy;
};
export type MorphPlan = {
    summary: string;
    moltenpart: string[];
    agentpart: string[];
    accesses: string[];
    waits: string[];
    agreed?: boolean;
    agreedby?: MorphBy;
};
export type MorphDraft = { state: "none" | "sample" | "real"; note?: string; commands: string[]; boxes: string[] };
export type MorphAgent = { blockid: string; firstname?: string; agent?: string; tabid?: string; here?: boolean };
export type MorphTold = { status: "sent" | "typed" | "queued" | "noagent"; to?: string; at: number };

export type MorphDesign = {
    mod: string;
    name?: string;
    dir: string;
    workspaceid?: string;
    tabid?: string;
    current: MorphStepId;
    steps: MorphStep[];
    questions: MorphQuestion[];
    plan?: MorphPlan;
    draft: MorphDraft;
    agent?: MorphAgent;
    told?: MorphTold;
    outcome?: "validated" | "gaveup";
    updated: number;
    panel?: string;
    opened?: string[];
};

// A hand-off asks the window to open a design's tab (kind tab) or to bring an open panel into view (kind focus).
export type MorphHandoffKind = "tab" | "focus";
export type MorphHandoff = {
    id: string;
    kind: MorphHandoffKind;
    mod: string;
    name?: string;
    dir: string;
    workspaceid: string;
    tabid?: string;
    blockid?: string;
    at: number;
};

// What the panel shows: the mod, as /morph named it, the folder it was opened in, and the agent's terminal beside it
// when the panel was placed next to one.
export type MorphDesignTarget = { mod: string; name?: string; dir: string; term?: string };

export function readMorphDesignTarget(value: unknown): MorphDesignTarget {
    if (value == null || typeof value !== "object") {
        return null;
    }
    const v = value as Record<string, unknown>;
    if (typeof v.mod !== "string" || !v.mod || typeof v.dir !== "string" || !v.dir) {
        return null;
    }
    return {
        mod: v.mod,
        name: typeof v.name === "string" && v.name ? v.name : undefined,
        dir: v.dir,
        term: typeof v.term === "string" && v.term ? v.term : undefined,
    };
}

// A hand-off the window can act on: a tab needs the mod and its folder, a focus needs the panel's tab and block.
export function readMorphHandoff(data: any): MorphHandoff {
    if (data == null || typeof data.id !== "string" || !data.id) {
        return null;
    }
    if (typeof data.mod !== "string" || !data.mod || typeof data.dir !== "string" || !data.dir) {
        return null;
    }
    if (typeof data.workspaceid !== "string" || !data.workspaceid) {
        return null;
    }
    const kind: MorphHandoffKind = data.kind === "focus" ? "focus" : "tab";
    if (
        kind === "focus" &&
        (typeof data.tabid !== "string" || !data.tabid || typeof data.blockid !== "string" || !data.blockid)
    ) {
        return null;
    }
    return { ...data, kind } as MorphHandoff;
}

// The title the panel carries in its header and in a tab's name: "Conception · <mod>", the name /morph gave else the id.
export function panelTitleOf(
    target: MorphDesignTarget,
    tr: (key: string, vars?: Record<string, string>) => string
): string {
    if (target == null) {
        return tr("morphDesign.viewName");
    }
    return tr("morphDesign.tabName", { mod: target.name || target.mod });
}

export function readMorphDesign(data: any): MorphDesign {
    if (data == null || typeof data.mod !== "string" || !Array.isArray(data.steps)) {
        return null;
    }
    return {
        ...data,
        steps: data.steps,
        questions: data.questions ?? [],
        draft: { commands: [], boxes: [], state: "none", ...(data.draft ?? {}) },
        plan: data.plan ?? undefined,
    } as MorphDesign;
}

// The mod as the developer reads it: the name /morph gave, else its id.
export function designTitle(design: Pick<MorphDesign, "mod" | "name">): string {
    return design?.name || design?.mod || "";
}

export function stepOf(design: MorphDesign, id: MorphStepId): MorphStep {
    return design?.steps?.find((s) => s.id === id) ?? { id, state: "todo" };
}

export type StepView = "current" | "todo" | "done" | "skipped" | "terminal";

// How a step reads in the panel: the current one stands out; a step the developer said they do in the terminal is
// "done" with that mark.
export function stepView(design: MorphDesign, id: MorphStepId): StepView {
    const step = stepOf(design, id);
    if (step.state === "skipped") {
        return "skipped";
    }
    if (step.state === "done") {
        return step.by === "terminal" ? "terminal" : "done";
    }
    return design.current === id ? "current" : "todo";
}

export function questionsOf(design: MorphDesign, id: MorphStepId): MorphQuestion[] {
    return (design?.questions ?? []).filter((q) => q.step === id);
}

export function openQuestions(design: MorphDesign, id: MorphStepId): MorphQuestion[] {
    return questionsOf(design, id).filter((q) => !q.answer);
}

// The answer the developer gave before, when it is one of the choices this question offers now. A question already
// answered is not prefilled: the answer stands.
export function prefilledChoice(question: MorphQuestion, defaults: LearningDefaults): string {
    if (question.answer) {
        return null;
    }
    const learned = prefillValue(defaults, question.key);
    if (learned == null) {
        return null;
    }
    return question.choices.some((c) => c.label === learned) ? learned : null;
}

// A step the developer skipped in the last runs in a row is folded, unless it is the one in hand: the current step, a
// step with a question waiting, or one the developer already settled in this design.
export function stepFolded(design: MorphDesign, defaults: LearningDefaults, id: MorphStepId): boolean {
    if (!foldedSteps(defaults).includes(id)) {
        return false;
    }
    return stepView(design, id) === "todo" && openQuestions(design, id).length === 0;
}

// Whether the agent has anything to show under the step: the panel then lists it, else it says what the step is for.
export function stepHasContent(design: MorphDesign, id: MorphStepId): boolean {
    const step = stepOf(design, id);
    if (step.say) {
        return true;
    }
    switch (id) {
        case "questions":
        case "finish":
            return questionsOf(design, id).length > 0;
        case "plan":
            return design.plan != null;
        case "preview":
            return design.draft.state !== "none" || design.draft.commands.length > 0 || design.draft.boxes.length > 0;
        default:
            return false;
    }
}

export type MorphReceiver = { blockId: string; name: string; tabId: string; here: boolean };

// The agent that gets the developer's decisions, as the panel names it: the one wavesrv found, else one running in a
// terminal of the design's own tab that wavesrv has not seen yet.
export function receiverOf(design: MorphDesign, fallback: { blockId: string; name: string } | null): MorphReceiver {
    if (design?.agent != null) {
        return {
            blockId: design.agent.blockid,
            name: [design.agent.firstname, design.agent.agent].filter(Boolean).join(" · "),
            tabId: design.agent.tabid ?? "",
            here: !!design.agent.here,
        };
    }
    if (fallback != null) {
        return { blockId: fallback.blockId, name: fallback.name, tabId: design.tabid ?? "", here: true };
    }
    return null;
}

// The clicks in flight, each by its own key ("skip:preview", "choose:audience:My team", "agree"). A control waits only
// for its own click, or for the clicks of the small group it belongs to (a step's gestures, a question's choices, the
// validation and the give up): the rest of the panel stays usable.
export type BusyKeys = ReadonlySet<string>;

export function stepGestureBusy(busy: BusyKeys, step: MorphStepId): boolean {
    return busy.has(`skip:${step}`) || busy.has(`terminal:${step}`) || busy.has(`back:${step}`);
}

export function questionBusy(busy: BusyKeys, key: string): boolean {
    for (const k of busy) {
        if (k.startsWith(`choose:${key}:`)) {
            return true;
        }
    }
    return false;
}

export function decisionBusy(busy: BusyKeys): boolean {
    return busy.has("validate") || busy.has("giveup");
}

// The agent wavesrv named ended since it published the design: the window's own agent states know at once, so the panel
// stops saying that agent gets the choices.
export function withLiveAgent(design: MorphDesign, receiverIsLive: boolean): MorphDesign {
    return design.agent != null && !receiverIsLive ? { ...design, agent: undefined } : design;
}

export const ToldKeys: Record<MorphTold["status"], string> = {
    sent: "morphDesign.told.sent",
    typed: "morphDesign.told.typed",
    queued: "morphDesign.told.queued",
    noagent: "morphDesign.told.noagent",
};

// The learning keys of a design's steps are the step ids; a question's key is its own.
export function isStepKey(key: string): boolean {
    return (MorphSteps as readonly string[]).includes(key);
}
