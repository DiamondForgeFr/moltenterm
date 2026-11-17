// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What a visit says in words (FR-BOSS-009, AC29, AC30, AC79, AC81, AC82, AC83, #2070, #2203, #2205, #2222): one sentence
// of his own for the event that brought him, so that the collapsed sidebar that stays half open for him, and the banner it
// unfolds with, tell what he wants and not only that he wants something. The sentence is written in his voice, one of
// several phrasings of the reason (brokk-visit-wording.ts), and carries nothing an agent, a notification or GitHub wrote:
// a row's text, a title or a check name stays on the row and the card. The count is the visit's own: the events it names,
// the gravest in words and the others as a sentence of their own, so the line and the number come from one source. The
// scene's accessible name stays for screen readers (brokk-visit-scene-model.ts). Pure, so the rules are tested without a
// window: the phrasing to say is the caller's pick.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import { t, tCount } from "../i18n/i18n";
import type { ToHandleItem } from "./boss-to-handle-model";
import { answerButtons, checkGoThere } from "./boss-to-handle-model";
import type { CaptionLine } from "./brokk-scene";
import type { Visit } from "./brokk-visit";
import { FirstWording, VisitPhrasings, VisitReason, WordingPick, wordingKey } from "./brokk-visit-wording";

const Min = 60 * 1000;

type Reason = { reason: VisitReason; vars?: Record<string, string | number> };

// An agent that waits or stopped, said by its name and by what it needs, never by what its notification wrote (AC83): a
// question its buttons answer is a question, a prompt that only takes the developer there to press Enter is a go-ahead,
// and an agent that waits with nothing to answer has waited so many minutes.
function agentReasonOf(item: ToHandleItem, now: number): Reason {
    if (item.name === "") {
        return { reason: "other" };
    }
    const vars = { name: item.name };
    if (item.tone === "error") {
        return { reason: "error", vars };
    }
    if (item.tone !== "waiting") {
        return { reason: "other" };
    }
    if (item.lineFromNotice && item.notice != null && answerButtons(item.notice).length > 0) {
        return { reason: checkGoThere(item.notice) ? "goAhead" : "asks", vars };
    }
    if (item.since > 0) {
        const minutes = Math.max(1, Math.floor((now - item.since) / Min));
        return { reason: "waitedFor", vars: { name: item.name, minutes } };
    }
    return { reason: "waiting", vars };
}

// An event that is no row of the list (a download, the update on offer, a plan reading, a security alert) says what it is,
// by its kind: its key is how a source names it (brokk-extra-feeds.ts). Never a count of "things to handle": those are
// the rows, and these are not.
const KindReasons: [prefix: string, reason: VisitReason][] = [
    ["download:", "download"],
    ["update:", "update"],
    ["usage:", "usage"],
    ["security:", "security"],
];

// A failing CI or a pull request ready to merge is said in his own words, the PR by its number only (AC81, #2205): its
// row's line is the PR title or the names of the failing checks, GitHub's text in the project's language, which stays on
// the row, the card and Integration. The number is the key's last segment ("ci:<dir>:<number>"), as a dir may hold ":".
const PrReasons: [prefix: string, reason: VisitReason][] = [
    ["ci:", "ciFailed"],
    ["ready:", "ready"],
];

function prReasonOf(key: string): Reason {
    const reason = PrReasons.find(([prefix]) => key.startsWith(prefix))?.[1];
    if (reason == null) {
        return null;
    }
    const number = key.slice(key.lastIndexOf(":") + 1);
    return /^\d+$/.test(number) ? { reason, vars: { number } } : { reason: "other" };
}

function reasonOf(key: string, items: ToHandleItem[], now: number): Reason {
    const pr = prReasonOf(key);
    if (pr != null) {
        return pr;
    }
    if (key.startsWith("agent:")) {
        const item = items.find((entry) => entry.key === key);
        return item != null ? agentReasonOf(item, now) : { reason: "other" };
    }
    const kind = KindReasons.find(([prefix]) => key.startsWith(prefix))?.[1];
    return { reason: kind ?? "other" };
}

function sentenceOf(reason: Reason, key: string, pick: WordingPick): CaptionLine {
    const size = VisitPhrasings[reason.reason];
    const index = Math.min(Math.max(pick(reason.reason, `${reason.reason}|${key}`) ?? 0, 0), size - 1);
    return { key: wordingKey(reason.reason, index), vars: reason.vars };
}

// The line of the gravest event of the visit, and how many others it covers. The example of the settings' "Show a visit"
// (#2079) stands for an agent that waited 6 min and has no row.
export function visitLineOf(
    visit: Visit,
    items: ToHandleItem[],
    now: number,
    pick: WordingPick = FirstWording
): CaptionLine {
    if (visit.example === true) {
        return { key: "boss.visit.exampleLine" };
    }
    const key = visit.keys[0] ?? "";
    const first = sentenceOf(reasonOf(key, items, now), key, pick);
    const others = Math.max(0, visit.count - 1);
    if (others === 0) {
        return first;
    }
    return { text: `${t(first.key, first.vars)} ${tCount("boss.visit.more", others)}` };
}
