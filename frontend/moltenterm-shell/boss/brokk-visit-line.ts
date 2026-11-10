// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What a visit says in words (FR-BOSS-009, AC29, AC30, AC79, AC81, #2070, #2203, #2205): the sentence of the event that brought him, the
// very words his rows say of it, so that the collapsed sidebar that stays half open for him, and the banner it unfolds
// with, tell what he wants and not only that he wants something. The count is the visit's own: the events it names, the
// gravest in words and the others as "and N more", so the line and the number come from one source. The scene's accessible
// name stays for screen readers (brokk-visit-scene-model.ts). Pure, so the rules are tested without a window.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import { t, tCount } from "../i18n/i18n";
import type { ToHandleItem } from "./boss-to-handle-model";
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

// An event that is no row of the list (a download, the update on offer, a plan reading, a security alert) says what it is,
// by its kind: its key is how a source names it (brokk-extra-feeds.ts). Never a count of "things to handle": those are
// the rows, and these are not.
const ReasonKeys: [prefix: string, key: string][] = [
    ["download:", "boss.visit.reason.download"],
    ["update:", "boss.visit.reason.update"],
    ["usage:", "boss.visit.reason.usage"],
    ["security:", "boss.visit.reason.security"],
];

const OtherReasonKey = "boss.visit.reason.other";

function reasonKeyOf(key: string): string {
    return ReasonKeys.find(([prefix]) => key.startsWith(prefix))?.[1] ?? OtherReasonKey;
}

// A failing CI or a pull request ready to merge is said in his own words, the PR by its number only (AC81, #2205): its
// row's line is the PR title or the names of the failing checks, GitHub's text in the project's language, which stays on
// the row, the card and Integration. The number is the key's last segment ("ci:<dir>:<number>"), as a dir may hold ":".
const PrReasonKeys: [prefix: string, key: string][] = [
    ["ci:", "boss.visit.reason.ciFailed"],
    ["ready:", "boss.visit.reason.ready"],
];

function prLineOf(key: string): CaptionLine {
    const reason = PrReasonKeys.find(([prefix]) => key.startsWith(prefix))?.[1];
    if (reason == null) {
        return null;
    }
    const number = key.slice(key.lastIndexOf(":") + 1);
    return /^\d+$/.test(number) ? { key: reason, vars: { number } } : { key: OtherReasonKey };
}

// The line of the gravest event of the visit, and how many others it covers. The example of the settings' "Show a visit"
// (#2079) stands for an agent that waited 6 min and has no row.
export function visitLineOf(visit: Visit, items: ToHandleItem[], now: number): CaptionLine {
    if (visit.example === true) {
        return { key: "boss.visit.exampleLine" };
    }
    const key = visit.keys[0];
    const item = items.find((entry) => entry.key === key);
    const first: CaptionLine =
        prLineOf(key ?? "") ?? (item != null ? lineOfRow(item, now) : { key: reasonKeyOf(key ?? "") });
    const others = Math.max(0, visit.count - 1);
    if (others === 0) {
        return first;
    }
    const sentence = first.text ?? t(first.key, first.vars);
    return { text: `${sentence} ${tCount("boss.peek.more", others)}` };
}
