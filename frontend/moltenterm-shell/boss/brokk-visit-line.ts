// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What a visit says in words (FR-BOSS-009, AC29, AC30, #2070): the sentence of the event that brought him, the very words
// his rows say of it, so that the collapsed sidebar that stays half open for him, and the banner it unfolds with,
// tell what he wants and not only that he wants something. The scene's accessible name stays for screen readers
// (brokk-visit-scene-model.ts). Pure, so the rules are tested without a window.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import type { InfoItem, ToHandleItem } from "./boss-to-handle-model";
import { toHandleHeadline } from "./boss-to-handle-model";
import type { CaptionLine } from "./brokk-scene";
import type { Visit } from "./brokk-visit";

const Min = 60 * 1000;

// A row that waits for the developer is the sentence of his mood's caption, "Léa attend depuis 6 min"; one that carries
// its own text (a question, a permission) says that text with the name it is about, like any other row.
function lineOfRow(item: ToHandleItem, now: number): CaptionLine {
    if (item.key.startsWith("agent:") && item.tone === "waiting" && !item.lineFromNotice && item.since > 0) {
        const minutes = Math.max(1, Math.floor((now - item.since) / Min));
        return { key: "boss.screen.waitedFor", vars: { name: item.name, minutes } };
    }
    return { text: toHandleHeadline(item) };
}

const FinishedPrefix = "finished:";

// The line of the gravest event of the visit that has words of its own, or how many things wait when none has (a
// download, an update or a plan reading, which are no row).
export function visitLineOf(visit: Visit, items: ToHandleItem[], info: InfoItem[], now: number): CaptionLine {
    // The example of the settings' "Show a visit" (#2079) stands for an agent that waited 6 min and has no row.
    if (visit.example === true) {
        return { key: "boss.visit.exampleLine" };
    }
    for (const key of visit.keys) {
        const item = items.find((entry) => entry.key === key);
        if (item != null) {
            return lineOfRow(item, now);
        }
        if (key.startsWith(FinishedPrefix)) {
            const done = info.find((entry) => entry.key === `done:${key.slice(FinishedPrefix.length)}`);
            if (done != null) {
                return { key: "boss.screen.finished", vars: { name: done.name } };
            }
        }
    }
    return { key: "boss.screen.toHandle", count: visit.count };
}
