// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The tone of Brokk's answer (FR-BOSS-009, AC88, #2259): his brief lets him open an answer with one marker of the suite's
// expression contract, `[[smile]]`, taken from a fixed list. The marker is read here and never shown. No marker, or a
// name outside the list, is neutral: the tone is never guessed from his words. Only his own session's answers are read
// so (brokk-exchange-model.ts parseReply); what another agent writes never moves his face (FR-BOSS-007).
//
// It is part of the bubble's up-front JavaScript: it imports the package's contract entry only, which holds no React and
// no clip, never the package itself.

import { readExpression, stripExpressionMarkers } from "@diamondforge/character/contract";
import type { BrokkExpression } from "./brokk-ask-model";

// must match pkg/molten/brokksession/brief.md
export const BrokkTones = [
    "smile",
    "warm",
    "amused",
    "proud",
    "concerned",
    "surprised",
    "thinking",
    "neutral",
] as const;

export type BrokkTone = (typeof BrokkTones)[number];

export const NeutralTone: BrokkTone = "neutral";

// The gesture each tone plays, among the clips he ships (portrait/brokk/brokk-manifest.json, the gestures of the
// listening pose). Null plays none: proud and surprised have no clip of their own yet, and are listed for Constance
// (character-studio) on #2259 rather than drawn or played as something else here.
export const ToneGesture: Record<BrokkTone, BrokkExpression> = {
    smile: "smile",
    warm: "smile",
    amused: "smile",
    proud: null,
    concerned: "frown",
    surprised: null,
    thinking: "doubtful",
    neutral: null,
};

export function toneOf(name: string): BrokkTone {
    return readExpression(BrokkTones, name, NeutralTone);
}

export type ToneRead = { text: string; tone: BrokkTone };

const Fence = /^\s{0,3}```/;

// His words without any tone marker, and the tone of the first one. A marker in a fenced block of code is code (a
// `[[bin]]` table, say) and stays as written. While the answer is still being written (`final` false), a marker cut at
// the end is held back, so that no piece of it ever shows.
export function readTone(text: string, final = true): ToneRead {
    const source = (text ?? "").replace(/\r\n/g, "\n");
    if (!source.includes("[")) {
        return { text: source, tone: NeutralTone };
    }
    const lines = source.split("\n");
    const out: string[] = [];
    const markers: string[] = [];
    let prose: string[] = [];
    let inCode = false;
    const flush = (last: boolean) => {
        if (prose.length === 0) {
            return;
        }
        const run = prose.join("\n");
        prose = [];
        const ends = !last || final;
        const stripped = stripExpressionMarkers(run, { final: ends });
        markers.push(...stripped.markers);
        if (!ends) {
            out.push(stripped.text);
            return;
        }
        // The contract trims what it strips: the blank lines around a block of code are kept.
        const lead = run.match(/^\s*/)[0];
        const trail = run.slice(lead.length).match(/\s*$/)[0];
        out.push(stripped.text === "" ? lead + trail : lead + stripped.text + trail);
    };
    for (const line of lines) {
        if (Fence.test(line)) {
            if (!inCode) {
                flush(false);
            }
            inCode = !inCode;
            out.push(line);
            continue;
        }
        if (inCode) {
            out.push(line);
            continue;
        }
        prose.push(line);
    }
    flush(true);
    const joined = out.join("\n");
    return {
        text: final ? joined.replace(/\n{3,}/g, "\n\n").trim() : joined.replace(/^\s+/, ""),
        tone: markers.length > 0 ? toneOf(markers[0]) : NeutralTone,
    };
}

// The text alone, for what only shows his words (the brainstorm's turn).
export function withoutTone(text: string, final = true): string {
    return readTone(text, final).text;
}
