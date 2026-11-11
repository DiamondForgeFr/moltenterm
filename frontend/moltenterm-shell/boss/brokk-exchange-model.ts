// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The exchange of Brokk's conversation window (FR-BOSS-009, AC22 to AC25, #2033): the developer's messages and his
// answers, the replies an answer offers as buttons and the rule that an authorisation asks once more, the line under his
// square that comes from his session, and when the window is open. Pure, so the rules are tested without a window.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import { withoutGraphBlocks } from "../brainstorm/brainstorm-fence";
import { BrokkTone, readTone } from "./brokk-tone";

// A reply his answer offers (FR-BOSS-004, AC12): its text is what is sent, so a button cannot hide what it sends.
// authorise: the reply asks once more before it is sent, which every reply does but a short one he marks safe.
export type InlineAction = { label: string; authorise: boolean };

export const MaxActions = 4;
export const MaxActionLabel = 80;
// The longest reply he may mark safe, sent without a confirmation.
export const MaxSafeLabel = 24;

// The info string of the fenced block that ends an answer; must match pkg/molten/brokksession/brief.md.
export const ActionsFence = "brokk-actions";

const OpenFence = new RegExp("^```" + ActionsFence + "\\s*$");
const CloseFence = /^```\s*$/;

export type ParsedReply = { text: string; actions: InlineAction[]; tone: BrokkTone };

// Control characters in a reply's text would reach his terminal as typed keys.
// eslint-disable-next-line no-control-regex
const ControlRuns = /[\u0000-\u001f\u007f]+/g;

function actionOf(entry: unknown): InlineAction {
    const raw = typeof entry === "string" ? entry : (entry as { label?: unknown })?.label;
    if (typeof raw !== "string") {
        return null;
    }
    const label = raw.replace(ControlRuns, " ").replace(/\s+/g, " ").trim();
    if (label === "" || label.length > MaxActionLabel) {
        return null;
    }
    return { label, authorise: !sentAtOnce(entry, label) };
}

// Every reply asks once more by default (#2220): the model, or a text injected into what it read, decides only which
// short replies it marks safe, and never lifts the confirmation of an authorisation.
function sentAtOnce(entry: unknown, label: string): boolean {
    if (entry == null || typeof entry !== "object" || label.length > MaxSafeLabel) {
        return false;
    }
    const marks = entry as { authorise?: unknown; safe?: unknown };
    return marks.safe === true && marks.authorise !== true;
}

// Up to four valid replies, the first of each text.
function actionsOf(list: unknown[]): InlineAction[] {
    const rtn: InlineAction[] = [];
    for (const entry of list) {
        const action = actionOf(entry);
        if (action == null || rtn.some((other) => other.label === action.label)) {
            continue;
        }
        rtn.push(action);
        if (rtn.length === MaxActions) {
            break;
        }
    }
    return rtn;
}

// His answer split into what he says and the replies he offers. The block is the last fenced block of the convention; a
// block that is still being written (no closing fence yet) is left out of the text and offers nothing yet, and a block
// that is not a JSON list stays in the text as it is. The graph of his thought (`brokk-graph`, FR-BOSS-010, #2246) is
// never part of what he says: the brainstorm reads it (brainstorm-graph-model.ts). Nor is the marker of his tone (AC88,
// #2259): it is read into `tone`. `final`: his agent is done with the answer, so a marker cut at its end is no longer
// held back.
export function parseReply(markdown: string, final = true): ParsedReply {
    const parsed = splitActions(markdown);
    const read = readTone(parsed.text, final);
    return { text: read.text, actions: parsed.actions, tone: read.tone };
}

function splitActions(markdown: string): { text: string; actions: InlineAction[] } {
    const text = withoutGraphBlocks(markdown ?? "");
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    let open = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
        if (OpenFence.test(lines[i])) {
            open = i;
            break;
        }
    }
    if (open < 0) {
        return { text, actions: [] };
    }
    let close = -1;
    for (let i = open + 1; i < lines.length; i++) {
        if (CloseFence.test(lines[i])) {
            close = i;
            break;
        }
    }
    const before = lines.slice(0, open).join("\n").trimEnd();
    if (close < 0) {
        return { text: before, actions: [] };
    }
    const after = lines
        .slice(close + 1)
        .join("\n")
        .trim();
    let list: unknown;
    try {
        list = JSON.parse(lines.slice(open + 1, close).join("\n"));
    } catch {
        return { text, actions: [] };
    }
    if (!Array.isArray(list)) {
        return { text, actions: [] };
    }
    return { text: [before, after].filter((part) => part !== "").join("\n\n"), actions: actionsOf(list) };
}

// What clicking a reply does: it asks once more, unless he marked it safe (AC24, #2220).
export type ActionStep = "send" | "confirm";

export function stepOf(action: InlineAction): ActionStep {
    return action.authorise ? "confirm" : "send";
}

// The reply waiting for its confirmation, or null. A click on a reply, then Confirmer or Annuler.
export type Confirming = InlineAction;

export type ActionOutcome = { confirming: Confirming; send: string };

export function afterClick(action: InlineAction): ActionOutcome {
    return stepOf(action) === "confirm" ? { confirming: action, send: null } : { confirming: null, send: action.label };
}

export function afterConfirm(confirming: Confirming): ActionOutcome {
    return { confirming: null, send: confirming?.label ?? null };
}

export function afterCancel(): ActionOutcome {
    return { confirming: null, send: null };
}

// One line of the exchange. A message of his has the id of the message it answers, so that each answer stays apart.
export type YouItem = { id: string; role: "you"; text: string; at: number };
export type BrokkItem = {
    id: string;
    role: "brokk";
    // His words, without the block of replies.
    text: string;
    actions: InlineAction[];
    at: number;
    // The turn of his transcript this answer was read from, 0 until the first reading.
    turn: number;
    // His agent is done with the message: the answer will not change.
    final: boolean;
    // The tone he tagged it with (AC88); neutral when none, or left out.
    tone?: BrokkTone;
};
export type ExchangeItem = YouItem | BrokkItem;

export function withMessage(items: ExchangeItem[], id: string, text: string, at: number): ExchangeItem[] {
    return [...items, { id, role: "you", text, at }];
}

// Puts what he has written so far of the answer to message `id`; the first reading adds it after the message.
export function withAnswer(
    items: ExchangeItem[],
    id: string,
    read: { markdown: string; turn: number; at: number; final: boolean }
): ExchangeItem[] {
    const parsed = parseReply(read.markdown, read.final);
    const item: BrokkItem = {
        id,
        role: "brokk",
        text: parsed.text,
        actions: read.final ? parsed.actions : [],
        at: read.at,
        turn: read.turn,
        final: read.final,
        tone: parsed.tone,
    };
    const at = items.findIndex((other) => other.role === "brokk" && other.id === id);
    if (at < 0) {
        return [...items, item];
    }
    const same = items[at] as BrokkItem;
    if (
        same.text === item.text &&
        same.final === item.final &&
        same.turn === item.turn &&
        same.tone === item.tone &&
        same.actions.length === item.actions.length
    ) {
        return items;
    }
    return items.map((other, i) => (i === at ? item : other));
}

// Only his last answer offers its replies, and only once it is complete: the developer's next message answers the ones
// before it.
export function offersActions(items: ExchangeItem[], item: ExchangeItem): boolean {
    const last = items[items.length - 1];
    return item.role === "brokk" && item === last && item.final && item.actions.length > 0;
}

// His one line under the square when his session has something to say: the lead of his answer, a few words of its first
// paragraph, with the light markdown left out.
export const LeadChars = 160;

export function leadOf(text: string, max: number = LeadChars): string {
    const paragraph = (text ?? "").split(/\n\s*\n/).find((part) => part.trim() !== "") ?? "";
    const plain = paragraph
        .replace(/```[^\n]*\n?/g, " ")
        .replace(/^\s{0,3}(#{1,6}|[-*>])\s+/gm, "")
        .replace(/[*_`]+/g, "")
        .replace(/\s+/g, " ")
        .trim();
    if (plain.length <= max) {
        return plain;
    }
    return plain.slice(0, max - 1).trimEnd() + "…";
}

// The line under the square: his latest answer while the developer has not seen it, else the moment he has to say
// (brokk-colleague.ts), else nothing: "" hides the line.
export function sayLine(unseen: BrokkItem, moment: string): string {
    const lead = unseen != null ? leadOf(unseen.text) : "";
    return lead !== "" ? lead : (moment ?? "");
}

// The conversation window is open while the field has the focus, and stays open while text is left in it (AC22).
export function conversationOpen(focused: boolean, draft: string): boolean {
    return focused || (draft ?? "").trim() !== "";
}
