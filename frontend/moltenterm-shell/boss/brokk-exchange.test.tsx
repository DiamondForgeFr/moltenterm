// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ExchangeView, ExchangeViewProps } from "./brokk-exchange";
import { BrokkItem, ExchangeItem, InlineAction } from "./brokk-exchange-model";

const yes: InlineAction = { label: "Yes", authorise: false };
const grant: InlineAction = { label: "Yes, delete the 2 branches", authorise: true };

const question: ExchangeItem = { id: "m1", role: "you", text: "Any news?", at: 1 };

function answer(actions: InlineAction[], final = true): BrokkItem {
    return { id: "m1", role: "brokk", text: "Olivia waits to delete 2 branches.", actions, at: 2, turn: 3, final };
}

function render(items: ExchangeItem[], props: Partial<ExchangeViewProps> = {}): string {
    return renderToStaticMarkup(
        <ExchangeView
            items={items}
            name="Brokk"
            confirming={null}
            busy={false}
            onPick={vi.fn()}
            onConfirm={vi.fn()}
            onCancel={vi.fn()}
            {...props}
        />
    );
}

describe("the replies under his answer (FR-BOSS-009, AC24)", () => {
    it("shows one button per reply, with the text it sends, under his last complete answer", () => {
        const html = render([question, answer([yes, { label: "No", authorise: false }])]);
        expect([...html.matchAll(/data-testid="brokk-act"[^>]*>([^<]*)</g)].map((m) => m[1])).toEqual(["Yes", "No"]);
        expect(html).not.toContain('data-testid="brokk-ask"');
    });

    it("shows no button while the answer is still coming in, nor on an answer the developer answered", () => {
        expect(render([question, answer([yes], false)])).not.toContain('data-testid="brokk-act"');
        const answered: ExchangeItem = { id: "m2", role: "you", text: "Yes", at: 3 };
        expect(render([question, answer([yes]), answered])).not.toContain('data-testid="brokk-act"');
    });

    it("waits while a message is on its way", () => {
        expect(render([question, answer([yes])], { busy: true })).toMatch(/data-testid="brokk-act"[^>]*disabled=""/);
        expect(render([question, answer([yes])])).not.toMatch(/data-testid="brokk-act"[^>]*disabled=""/);
    });

    it("marks an authorisation, which the app asks about once more", () => {
        const html = render([question, answer([yes, grant])]);
        expect(html).toMatch(/data-testid="brokk-act" data-authorise="true"[^>]*>Yes, delete the 2 branches</);
        expect(html.match(/data-authorise="true"/g)).toHaveLength(1);
    });

    it("asks once more in place of the buttons: what would be sent, Confirm and Cancel", () => {
        const html = render([question, answer([yes, grant])], { confirming: grant });
        expect(html).toMatch(/data-testid="brokk-ask"[^>]*>Send “Yes, delete the 2 branches”\?</);
        expect(html).toMatch(/data-testid="brokk-act-confirm"[^>]*>Confirm/);
        expect(html).toMatch(/data-testid="brokk-act-cancel"[^>]*>Cancel</);
        expect(html).not.toContain('data-testid="brokk-act"');
    });

    it("shows his words as text, and the button's text as it is, never as HTML", () => {
        const html = render([
            question,
            { ...answer([{ label: "<b>Yes</b>", authorise: false }]), text: "<img src=x onerror=alert(1)>" },
        ]);
        expect(html).not.toContain("<img");
        expect(html).not.toContain("<b>Yes</b>");
        expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    });

    it("tells a screen reader who speaks, and names the group of replies", () => {
        const html = render([question, answer([yes])]);
        expect(html).toContain('<span class="sr-only">You: </span>');
        expect(html).toContain('<span class="sr-only">Brokk: </span>');
        expect(html).toContain('role="group"');
    });

    it("sends nothing by itself: a click runs the handler of the window, which applies the confirmation rule", () => {
        const source = readFileSync(join(__dirname, "brokk-exchange.tsx"), "utf8");
        expect(source).toContain("onClick={() => onPick(action)}");
        const talk = readFileSync(join(__dirname, "brokk-talk.tsx"), "utf8");
        expect(talk).toContain("const outcome = afterClick(action);");
        expect(talk).toContain("const outcome = afterConfirm(confirming);");
        expect(talk).toContain("setConfirming(afterCancel().confirming);");
    });
});
