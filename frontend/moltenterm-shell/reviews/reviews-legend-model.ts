// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The legend of the cards' colours (#2332, FR-REV-001 AC20): what the rail and the dot of a card mean. The lines are
// read from the cards' own tone tables (RailColours and ToneMarks in reviews-card.tsx), never from a second colour
// definition: tones that render alike share one line, with the meaning of each in its sentence, and a tone added to
// the cards appears here, with words (a Record over CardTone) or the type check fails. Pure; the words are keys, worded
// where they show.

import type { StateMarkKind } from "../state-mark";
import type { CardTone } from "./reviews-card-model";

// The panel's order of attention: what asks for the developer first, then what can move forward, what is broken, what
// runs, what stands still.
export const LegendToneOrder: CardTone[] = ["you", "ready", "broken", "agent", "running", "draft", "wait"];

export const LegendMeaningKeys: Record<CardTone, string> = {
    you: "reviews.legend.tone.you",
    ready: "reviews.legend.tone.ready",
    broken: "reviews.legend.tone.broken",
    agent: "reviews.legend.tone.agent",
    running: "reviews.legend.tone.running",
    draft: "reviews.legend.tone.draft",
    wait: "reviews.legend.tone.wait",
};

// A line is named by its state mark's shape: the one thing a card shows besides its colour.
export const LegendLabelKeys: Record<StateMarkKind, string> = {
    waiting: "reviews.legend.mark.waiting",
    ready: "reviews.legend.mark.ready",
    blocked: "reviews.legend.mark.blocked",
    running: "reviews.legend.mark.running",
    draft: "reviews.legend.mark.draft",
};

export type LegendEntry = {
    // The first tone of the line, which draws the rail and colours the label.
    tone: CardTone;
    // Every tone that renders as this line.
    tones: CardTone[];
    mark: StateMarkKind;
    labelKey: string;
    meaningKeys: string[];
};

// legendEntries: one entry per distinct look (rail colour and mark) of the tone tables, in the order of attention.
// A tone the order does not name comes last.
export function legendEntries(rails: Record<CardTone, string>, marks: Record<CardTone, StateMarkKind>): LegendEntry[] {
    const known = new Set<CardTone>([...(Object.keys(rails) as CardTone[]), ...(Object.keys(marks) as CardTone[])]);
    const ordered = [
        ...LegendToneOrder.filter((t) => known.has(t)),
        ...[...known].filter((t) => !LegendToneOrder.includes(t)),
    ];
    const entries: LegendEntry[] = [];
    for (const tone of ordered) {
        const same = entries.find((e) => rails[e.tone] === rails[tone] && marks[e.tone] === marks[tone]);
        if (same != null) {
            same.tones.push(tone);
            same.meaningKeys.push(LegendMeaningKeys[tone]);
            continue;
        }
        entries.push({
            tone,
            tones: [tone],
            mark: marks[tone],
            labelKey: LegendLabelKeys[marks[tone]],
            meaningKeys: [LegendMeaningKeys[tone]],
        });
    }
    return entries;
}

// How the legend card opens and closes. Hovering the button or focusing it with the keyboard shows it and leaving hides
// it; a click pins it open for reading. A pinned card ignores the pointer and the focus leaving: only a second click on
// the button, Escape or a click outside closes it.
export type LegendState = { open: boolean; pinned: boolean };

export const LegendClosed: LegendState = { open: false, pinned: false };

// The reasons floating-ui gives for a change that only the pointer or the focus moving made.
const PassiveReasons = new Set<string>(["hover", "focus", "focus-out", "safe-polygon"]);
const PinReasons = new Set<string>(["click", "reference-press"]);

export function legendChange(state: LegendState, open: boolean, reason?: string): LegendState {
    if (open) {
        return { open: true, pinned: state.pinned || PinReasons.has(reason) };
    }
    if (state.pinned && PassiveReasons.has(reason)) {
        return state;
    }
    return LegendClosed;
}

// Escape brings the focus back to the button, since the card was the last thing the developer looked at; a click
// outside leaves it where the developer put it.
export function legendReturnsFocus(open: boolean, reason?: string): boolean {
    return !open && reason === "escape-key";
}

// Hover waits a little before showing, like a tooltip: crossing the header never flashes the card.
export const LegendHoverDelay = { open: 300, close: 100 };
