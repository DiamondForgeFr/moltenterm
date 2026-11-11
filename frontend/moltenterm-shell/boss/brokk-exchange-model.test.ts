// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    afterCancel,
    afterClick,
    afterConfirm,
    BrokkItem,
    conversationOpen,
    ExchangeItem,
    leadOf,
    MaxActionLabel,
    MaxActions,
    MaxSafeLabel,
    offersActions,
    parseReply,
    sayLine,
    stepOf,
    withAnswer,
    withMessage,
} from "./brokk-exchange-model";

const Fence = "```";

function block(body: string): string {
    return `${Fence}brokk-actions\n${body}\n${Fence}`;
}

describe("the replies an answer offers (FR-BOSS-009, AC24; FR-BOSS-004, AC12)", () => {
    it("leaves an answer without a block as it is", () => {
        expect(parseReply("Two agents run now.")).toEqual({ text: "Two agents run now.", actions: [] });
        expect(parseReply("")).toEqual({ text: "", actions: [] });
        expect(parseReply(null)).toEqual({ text: "", actions: [] });
    });

    it("takes the block at the end out of the text and offers its replies", () => {
        const parsed = parseReply(`Open the PR #2024?\n\n${block('["Yes", "No"]')}`);
        expect(parsed.text).toBe("Open the PR #2024?");
        expect(parsed.actions).toEqual([
            { label: "Yes", authorise: true },
            { label: "No", authorise: true },
        ]);
    });

    it("asks for every reply by default; only a short one he marks safe, with a real true, goes at once (#2220)", () => {
        const parsed = parseReply(
            block(
                '[{"label": "Yes, delete", "authorise": true}, {"label": "Later", "safe": "true"}, {"label": "No", "safe": true}, "Maybe"]'
            )
        );
        expect(parsed.actions).toEqual([
            { label: "Yes, delete", authorise: true },
            { label: "Later", authorise: true },
            { label: "No", authorise: false },
            { label: "Maybe", authorise: true },
        ]);
    });

    it("never lifts the confirmation of an authorisation or of a long reply marked safe (#2220)", () => {
        const long = "y".repeat(MaxSafeLabel + 1);
        const parsed = parseReply(
            block(
                JSON.stringify([
                    { label: "Yes, merge", authorise: true, safe: true },
                    { label: long, safe: true },
                    { label: "y".repeat(MaxSafeLabel), safe: true },
                ])
            )
        );
        expect(parsed.actions.map((a) => a.authorise)).toEqual([true, true, false]);
    });

    it("offers at most four replies, each of a text that fits, the first of each text", () => {
        const many = JSON.stringify(["a", "b", "a", "c", "d", "e"]);
        expect(parseReply(block(many)).actions.map((a) => a.label)).toEqual(["a", "b", "c", "d"]);
        expect(MaxActions).toBe(4);
        const long = "x".repeat(MaxActionLabel + 1);
        const fits = "y".repeat(MaxActionLabel);
        expect(parseReply(block(JSON.stringify([long, fits, "", "  ", 3, null, {}]))).actions).toEqual([
            { label: fits, authorise: true },
        ]);
    });

    it("sends the text it shows: control characters and runs of spaces are made one space", () => {
        expect(parseReply(block(JSON.stringify(["Yes,\n\tdelete   it"]))).actions[0].label).toBe("Yes, delete it");
    });

    it("shows a block that is not a list of replies as the text it is", () => {
        const text = `Here is code:\n${block("not json")}`;
        expect(parseReply(text)).toEqual({ text, actions: [] });
        const object = `A\n${block('{"label": "Yes"}')}`;
        expect(parseReply(object)).toEqual({ text: object, actions: [] });
    });

    it("keeps the words after the block, and takes the last block only", () => {
        const parsed = parseReply(`First\n${block('["old"]')}\nSecond\n${block('["new"]')}\nThat is all.`);
        expect(parsed.actions.map((a) => a.label)).toEqual(["new"]);
        expect(parsed.text).toContain("Second");
        expect(parsed.text).toContain("That is all.");
        expect(parsed.text).toContain('["old"]');
        expect(parsed.text).not.toContain('["new"]');
    });

    it("hides a block that is still being written, and offers nothing yet", () => {
        const parsed = parseReply(`Open it?\n\n${Fence}brokk-actions\n["Ye`);
        expect(parsed).toEqual({ text: "Open it?", actions: [] });
    });

    it("reads a block of a list that has no valid entry as a block without replies", () => {
        expect(parseReply(`Done.\n${block("[]")}`)).toEqual({ text: "Done.", actions: [] });
    });
});

describe("the confirmation rule (AC24)", () => {
    const yes = { label: "Yes", authorise: false };
    const grant = { label: "Yes, delete the branches", authorise: true };

    it("sends a reply he marked safe at once, as the text of the button", () => {
        expect(stepOf(yes)).toBe("send");
        expect(afterClick(yes)).toEqual({ confirming: null, send: "Yes" });
    });

    it("asks once more for an authorisation, and sends nothing yet", () => {
        expect(stepOf(grant)).toBe("confirm");
        expect(afterClick(grant)).toEqual({ confirming: grant, send: null });
    });

    it("sends the authorisation on Confirmer, and nothing on Annuler", () => {
        expect(afterConfirm(grant)).toEqual({ confirming: null, send: "Yes, delete the branches" });
        expect(afterCancel()).toEqual({ confirming: null, send: null });
        expect(afterConfirm(null)).toEqual({ confirming: null, send: null });
    });
});

describe("the exchange (AC23)", () => {
    it("keeps each answer apart, in the order of the messages", () => {
        let items: ExchangeItem[] = [];
        items = withMessage(items, "m1", "how many agents run?", 1);
        items = withAnswer(items, "m1", { markdown: "Two.", turn: 3, at: 2, final: true });
        items = withMessage(items, "m2", "and blocked?", 3);
        items = withAnswer(items, "m2", { markdown: "One, Olivia.", turn: 4, at: 4, final: true });
        expect(items.map((i) => `${i.role}:${i.id}:${i.text}`)).toEqual([
            "you:m1:how many agents run?",
            "brokk:m1:Two.",
            "you:m2:and blocked?",
            "brokk:m2:One, Olivia.",
        ]);
    });

    it("grows an answer in place as more of it is read, and gives the same list when nothing changed", () => {
        let items = withMessage([], "m1", "hello", 1);
        items = withAnswer(items, "m1", { markdown: "Two agents", turn: 3, at: 2, final: false });
        const again = withAnswer(items, "m1", { markdown: "Two agents", turn: 3, at: 2, final: false });
        expect(again).toBe(items);
        items = withAnswer(items, "m1", { markdown: "Two agents run now.", turn: 3, at: 3, final: true });
        expect(items).toHaveLength(2);
        expect((items[1] as BrokkItem).text).toBe("Two agents run now.");
        expect((items[1] as BrokkItem).final).toBe(true);
    });

    it("offers the replies of the last complete answer only", () => {
        const answer = `Open it?\n${block('["Yes", "No"]')}`;
        let items = withMessage([], "m1", "hello", 1);
        items = withAnswer(items, "m1", { markdown: answer, turn: 3, at: 2, final: false });
        expect(offersActions(items, items[1])).toBe(false);
        items = withAnswer(items, "m1", { markdown: answer, turn: 3, at: 2, final: true });
        expect(offersActions(items, items[1])).toBe(true);
        expect(offersActions(items, items[0])).toBe(false);
        items = withMessage(items, "m2", "Yes", 3);
        expect(offersActions(items, items[1])).toBe(false);
    });

    it("offers no replies when the answer has none", () => {
        let items = withMessage([], "m1", "hello", 1);
        items = withAnswer(items, "m1", { markdown: "Fine.", turn: 3, at: 2, final: true });
        expect(offersActions(items, items[1])).toBe(false);
    });
});

describe("the window opens and folds (AC22)", () => {
    it("opens with the focus, and stays open while text is left in the field", () => {
        expect(conversationOpen(true, "")).toBe(true);
        expect(conversationOpen(true, "hello")).toBe(true);
        expect(conversationOpen(false, "hello")).toBe(true);
    });

    it("folds when the field is empty and has lost the focus", () => {
        expect(conversationOpen(false, "")).toBe(false);
        expect(conversationOpen(false, "   ")).toBe(false);
        expect(conversationOpen(false, null)).toBe(false);
    });
});

describe("his line under the square (AC25)", () => {
    const answer = (text: string): BrokkItem => ({
        id: "m1",
        role: "brokk",
        text,
        actions: [],
        at: 1,
        turn: 1,
        final: true,
    });

    it("is the lead of his answer when the developer has not seen it", () => {
        expect(sayLine(answer("Two agents run now.\n\nOlivia waits."), "3 agents work")).toBe("Two agents run now.");
    });

    it("is the activity summary when his session has nothing unseen to say", () => {
        expect(sayLine(null, "3 agents work")).toBe("3 agents work");
        expect(sayLine(answer("   "), "3 agents work")).toBe("3 agents work");
    });

    it("shortens a long lead and leaves the light markdown out", () => {
        const long = "word ".repeat(80);
        const lead = leadOf(long);
        expect(lead.length).toBeLessThanOrEqual(160);
        expect(lead.endsWith("…")).toBe(true);
        expect(leadOf("## **Two** agents `run`\n\nmore")).toBe("Two agents run");
        expect(leadOf("- one\n- two")).toBe("one two");
    });
});
