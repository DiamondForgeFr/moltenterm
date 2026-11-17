// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { globalStore } from "@/app/store/jotaiStore";
import { ExchangeView, ExchangeViewProps } from "./brokk-exchange";
import { BrokkItem, ExchangeItem, InlineAction } from "./brokk-exchange-model";
import { BrokkSpeech, NothingShown } from "./brokk-speech";

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

// FR-BOSS-009, AC87 (#2259): his latest answer is revealed as he says it (brokk-speech.ts).
describe("his answer as he says it (AC87)", () => {
    const speech = BrokkSpeech.getInstance();

    afterEach(() => globalStore.set(speech.shownAtom, NothingShown));

    // #2285: the whole answer is laid out unseen, keeping its place, and the words said are drawn over it.
    it("shows the words said, keeps the place of the rest unseen, and is busy for screen readers until whole", () => {
        globalStore.set(speech.shownAtom, { id: "m1", count: "Olivia waits".length });
        const html = render([question, answer([yes])]);
        expect(html).toMatch(
            /<div class="mt-brokk-md-unsaid" aria-hidden="true" data-testid="brokk-msg-unsaid"><p>Olivia waits to delete 2 branches\.<\/p><\/div>/
        );
        expect(html).toMatch(/<div class="mt-brokk-md-said" data-testid="brokk-msg-said"><p>Olivia waits<\/p><\/div>/);
        expect(html).toMatch(/data-role="brokk" data-testid="brokk-msg" aria-busy="true"/);
    });

    it("closes the marks the cut leaves open, so that his words never show them while he speaks", () => {
        const text = "Two things: **the review of the branch** and `molten ci`.";
        globalStore.set(speech.shownAtom, { id: "m1", count: "Two things: **the review".length });
        const html = render([question, { ...answer([yes]), text }]);
        expect(html).toMatch(/data-testid="brokk-msg-said"><p>Two things: <strong>the review<\/strong><\/p>/);
        expect(html).not.toMatch(/brokk-msg-said">[^]*?\*\*/);
    });

    it("offers its replies only once it is whole", () => {
        globalStore.set(speech.shownAtom, { id: "m1", count: 6 });
        expect(render([question, answer([yes])])).not.toContain('data-testid="brokk-act"');
        globalStore.set(speech.shownAtom, NothingShown);
        const html = render([question, answer([yes])]);
        expect(html).toContain('data-testid="brokk-act"');
        expect(html).not.toContain("aria-busy");
        expect(html).not.toContain("brokk-msg-unsaid");
    });

    it("reveals only the answer being said: the developer's message and earlier answers show whole", () => {
        globalStore.set(speech.shownAtom, { id: "m9", count: 0 });
        const html = render([question, answer([yes])]);
        expect(html).toContain("<p>Olivia waits to delete 2 branches.</p></div>");
        expect(html).toContain(">Any news?</div>");
    });
});

// FR-BOSS-009 AC89 and AC90 (#2285): his answers read as Markdown, full width with no bubble; the developer's messages
// stay the plain text they typed, in a quiet block on the right.
describe("the look of the exchange (AC89, AC90)", () => {
    it("renders his Markdown: paragraphs, lists, bold, code and a code block", () => {
        const text = "First point.\n\n- one\n- **two**\n\nRun `molten ci` then:\n\n```sh\nmolten ci status\n```";
        const html = render([question, { ...answer([]), text }]);
        expect(html).toContain("<p>First point.</p>");
        expect(html).toContain("<ul>\n<li>one</li>\n<li><strong>two</strong></li>\n</ul>");
        expect(html).toContain("<code>molten ci</code>");
        expect(html).toMatch(/<pre><code class="language-sh">molten ci status\n<\/code><\/pre>/);
        expect(html).toMatch(/class="mt-brokk-msg-text mt-brokk-md" data-testid="brokk-msg-text"/);
    });

    it("keeps the developer's message as typed: no Markdown, no HTML", () => {
        const html = render([{ ...question, text: "**not bold** <i>nor this</i>" }, answer([])]);
        expect(html).toContain(">**not bold** &lt;i&gt;nor this&lt;/i&gt;</div>");
        expect(html).not.toContain("<strong>not bold");
    });

    it("draws his side with the brass rule and the developer's as a quiet block on the right", () => {
        const css = readFileSync(join(__dirname, "brokk-group.css"), "utf8");
        const rule = (selector: string) =>
            new RegExp(`${selector.replace(/[[\]".]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[1];
        expect(rule('.mt-brokk-msg[data-role="brokk"]')).toMatch(/border-left: 2px solid/);
        expect(rule('.mt-brokk-msg[data-role="brokk"]')).not.toMatch(/background/);
        expect(rule('.mt-brokk-msg[data-role="you"]')).toMatch(/align-self: flex-end;/);
        expect(rule('.mt-brokk-msg[data-role="you"]')).toMatch(/background: var\(--mt-surface-2\);/);
        expect(rule(".mt-brokk-msg")).toMatch(/line-height: 1\.6;/);
        // His answers are read on the frame itself: it follows the theme, never the terminal's dark surface.
        expect(rule(".mt-brokk-field")).toMatch(/background: var\(--mt-surface-1\);/);
        expect(rule(".mt-brokk-md pre")).not.toMatch(/surface-term/);
    });
});
