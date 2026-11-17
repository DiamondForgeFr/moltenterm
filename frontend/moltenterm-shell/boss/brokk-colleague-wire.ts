// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the windows and Electron main say to each other about Brokk as a kind colleague (FR-BOSS-009, #2221): Electron main
// owns the colleague's run (emain/moltenterm-colleague-owner.ts); the windows tell it what only a page knows and show the
// moments it raises. Pure and shared by both sides: it imports nothing of Electron or of the portrait.

import { Moment, Proximity, proximityOf } from "./brokk-colleague";

// What only a page knows: the agents at work (its copy of wavesrv's states), the developer's setting and the interface
// language. Every window reports the same values; the latest report is the one Electron main uses.
export type PageFacts = {
    working: number;
    proximity: Proximity;
    language: string;
};

export const DefaultPageFacts: PageFacts = { working: 0, proximity: proximityOf(null), language: "en" };

// The moments waiting to be shown, oldest first, with the revision they were told at: a window ignores anything older
// than what it holds, whatever the order the pushes and the first answer arrive in.
export type MomentsUpdate = { rev: number; moments: Moment[] };

export const EmptyMomentsUpdate: MomentsUpdate = { rev: 0, moments: [] };

const LanguageCode = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/;
const MaxAgents = 99;
const MaxIdChars = 80;

// Facts as they arrive from a window: anything that is not one of the known shapes is the default, since the language
// ends in the prompt of his model.
export function pageFactsOf(raw: unknown): PageFacts {
    const source = (raw != null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const working = Number(source.working);
    const language = typeof source.language === "string" && LanguageCode.test(source.language) ? source.language : "";
    return {
        working: Number.isInteger(working) && working > 0 ? Math.min(working, MaxAgents) : 0,
        proximity: proximityOf(source.proximity),
        language: language || DefaultPageFacts.language,
    };
}

export function samePageFacts(a: PageFacts, b: PageFacts): boolean {
    return a.working === b.working && a.proximity === b.proximity && a.language === b.language;
}

// A moment's id as it arrives from a window, or null.
export function momentIdOf(raw: unknown): string {
    return typeof raw === "string" && raw !== "" && raw.length <= MaxIdChars ? raw : null;
}
