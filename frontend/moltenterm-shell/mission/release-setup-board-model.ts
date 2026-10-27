// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The setup's agent board (FR-MC-045, #1163), as the panel reads it: the coding agent in the pipeline tab's terminal
// proposes changes, flags points and highlights the step it explains through `molten pipeline setup`; wavesrv checks
// each proposal (#1099's rules) and keeps it in memory; the panel shows them live and the developer decides each one.
// Pure functions here, tested without the app; the calls and the hook are in release-setup-board.tsx.

import type { TFunction } from "../i18n/i18n";
import type { SetupChannel, SetupDraft, SetupStepChange } from "./release-setup-model";
import { PlainChannel, PlainStep, PlainWho, stepText } from "./release-setup-plain-model";

// must match pkg/molten/pipelinesetup/board.go
export type BoardItemState = "open" | "accepted" | "declined" | "withdrawn" | "kept";
export type BoardMarkOp = "add" | "change" | "remove";

export type BoardStep = { channel: SetupChannel; n: number; ids: string[]; text: string };

export type BoardItem = {
    key: string;
    kind: "change" | "flag";
    state: BoardItemState;
    by?: string;
    at: number;
    change?: SetupStepChange;
    why?: string;
    // A flag: "rc/3" (the plain-words number), its point and the agent's proposed answer.
    step?: string;
    point?: string;
    answer?: string;
    // An added or changed step as the agent says it should read, and who does it then (#1163).
    say?: string;
    who?: PlainWho;
    // The item this one was copied from ("apply to the other version too").
    from?: string;
};

export type BoardExplain = { channel: SetupChannel; n: number; ids: string[]; note?: string; by?: string; at: number };

export type BoardState = {
    dir: string;
    open: boolean;
    screen?: string;
    steps: BoardStep[];
    items: BoardItem[];
    explain?: BoardExplain;
    // The draft with the open additions and changes in place; marks by "channel/id".
    preview?: string;
    marks?: Record<string, { key: string; op: BoardMarkOp }>;
    // The draft the proposals are checked against: the "before" of a change.
    base?: string;
    seq: number;
};

export type BoardContext = { dir: string; screen: string; text: string; steps: BoardStep[] };

export type BoardApplied = {
    proposed: string;
    errors: string[];
    validatewarnings: string[];
    applied: string[];
    skipped: string[];
};

export function openItems(state: BoardState): BoardItem[] {
    return (state?.items ?? []).filter((it) => it.state === "open");
}

export function acceptedKeys(state: BoardState): string[] {
    return (state?.items ?? []).filter((it) => it.kind === "change" && it.state === "accepted").map((it) => it.key);
}

// Who proposed the accepted changes, for step 3's "proposed by": the first name when one agent did.
export function acceptedBy(state: BoardState): string {
    const names = new Set(
        (state?.items ?? []).filter((it) => it.kind === "change" && it.state === "accepted").map((it) => it.by ?? "")
    );
    return names.size === 1 ? [...names][0] : "";
}

// Whether the board changes what the screen shows: an open or accepted change.
export function boardShapesDraft(state: BoardState): boolean {
    return (state?.items ?? []).some((it) => it.kind === "change" && (it.state === "open" || it.state === "accepted"));
}

// The draft the plain-words screen tells while the agent proposes: its pipeline is the preview (the open additions
// and changes in place), so the sentences and the diagram show them where they would go.
export function previewDraft(draft: SetupDraft, state: BoardState): SetupDraft {
    if (draft == null || !state?.preview || !boardShapesDraft(state)) {
        return draft;
    }
    return { ...draft, current: state.preview };
}

// The draft before the open proposals (the base they are checked against), for a change's "before".
export function baseDraft(draft: SetupDraft, state: BoardState): SetupDraft {
    if (draft == null || !state?.base || !boardShapesDraft(state)) {
        return draft;
    }
    return { ...draft, current: state.base };
}

export function itemByKey(state: BoardState, key: string): BoardItem {
    return (state?.items ?? []).find((it) => it.key === key);
}

// The agent's own words for the steps it proposed or had accepted, by "channel/id": the sentence the panel shows
// instead of the model's, and the who chip.
export function saidSteps(state: BoardState): Map<string, { say?: string; who?: PlainWho }> {
    const said = new Map<string, { say?: string; who?: PlainWho }>();
    for (const it of state?.items ?? []) {
        if (it.kind !== "change" || !it.change?.channel || !(it.say || it.who)) {
            continue;
        }
        if (it.state === "open" || it.state === "accepted") {
            said.set(`${it.change.channel}/${it.change.id}`, { say: it.say, who: it.who });
        }
    }
    return said;
}

export function saidOf(said: Map<string, { say?: string; who?: PlainWho }>, channel: SetupChannel, step: PlainStep) {
    for (const id of step?.ids ?? []) {
        const words = said.get(`${channel}/${id}`);
        if (words != null) {
            return words;
        }
    }
    return null;
}

export function otherChannel(channel: SetupChannel): SetupChannel {
    return channel === "rc" ? "public" : "rc";
}

// The other version a step change could apply to as well: it has the same step, and no proposal on it yet.
export function copyTarget(item: BoardItem, state: BoardState, channels: PlainChannel[]): SetupChannel {
    const c = item?.change;
    if (item?.state !== "open" || c == null || c.op === "versions" || c.op === "add" || !c.channel) {
        return null;
    }
    const other = otherChannel(c.channel);
    const plain = (channels ?? []).find((p) => p.channel === other);
    if (plain == null || !plain.steps.some((s) => s.ids.includes(c.id))) {
        return null;
    }
    if (state?.marks?.[`${other}/${c.id}`] != null) {
        return null;
    }
    return other;
}

// The mark of each plain-words step of a channel, by its number: a step telling a proposed step is marked.
export function stepMarks(plain: PlainChannel, state: BoardState): Map<number, { key: string; op: BoardMarkOp }> {
    const marks = new Map<number, { key: string; op: BoardMarkOp }>();
    for (const step of plain?.steps ?? []) {
        for (const id of step.ids) {
            const mark = state?.marks?.[`${plain.channel}/${id}`];
            if (mark != null) {
                marks.set(step.n, mark);
                break;
            }
        }
    }
    return marks;
}

// The open items the channel's block shows beside its steps: its step changes, and the flags on one of its steps.
export function channelItems(state: BoardState, channel: SetupChannel): BoardItem[] {
    return openItems(state).filter((it) =>
        it.kind === "change" ? it.change?.channel === channel : it.step?.startsWith(`${channel}/`)
    );
}

// The open items no channel holds: version changes and flags on the whole setup.
export function generalItems(state: BoardState): BoardItem[] {
    return openItems(state).filter((it) =>
        it.kind === "change" ? it.change?.op === "versions" || !it.change?.channel : !it.step
    );
}

// The flags the developer kept, with their answer.
export function keptFlags(state: BoardState): BoardItem[] {
    return (state?.items ?? []).filter((it) => it.kind === "flag" && it.state === "kept");
}

// The steps the board publishes for the agent's `show`: what the screen tells, numbered as the developer sees them.
export function boardSteps(channels: PlainChannel[], t: TFunction, state?: BoardState): BoardStep[] {
    const said = saidSteps(state);
    const steps: BoardStep[] = [];
    for (const plain of channels ?? []) {
        for (const step of plain.steps) {
            const text = saidOf(said, plain.channel, step)?.say || stepText(t, step);
            steps.push({ channel: plain.channel, n: step.n, ids: [...step.ids], text });
        }
    }
    return steps;
}

export function contextSignature(c: BoardContext): string {
    return JSON.stringify([c.dir, c.screen, c.text, c.steps]);
}

// What a change card says it does, as an i18n key and its values.
export function changeSentence(item: BoardItem): { key: string; vars: Record<string, string> } {
    const c = item.change;
    if (c == null || c.op === "versions") {
        return { key: "mc.setup.board.op.versions", vars: {} };
    }
    return { key: `mc.setup.board.op.${c.op}`, vars: { title: c.title || c.id || "" } };
}
