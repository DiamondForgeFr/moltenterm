// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The annotate mode as drawn (FR-BRW-017 AC12 to AC14, AC17, #2327): the tray, a zone and its comment field, and the
// review of what will be sent, to whom and why. Synthetic agents and branches only.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import {
    CommentField,
    NumberBadge,
    type Outcome,
    ReviewView,
    type ReviewViewProps,
    Tray,
    ZoneMark,
} from "./annotate-layer";
import type { AnnotateTarget, Recipient, Zone } from "./annotate-model";

const Noop = () => {};
const Zone1: Zone = { id: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.25, comment: "The title is cut." };

function tray(count: number, leaveAsk = false): string {
    return renderToStaticMarkup(
        <Tray
            count={count}
            leaveAsk={leaveAsk}
            onClear={Noop}
            onReview={Noop}
            onClose={Noop}
            onDiscard={Noop}
            onKeep={Noop}
        />
    );
}

afterEach(() => I18nModel.getInstance().setLanguageSetting("en"));

describe("the tray", () => {
    it("says what to do while nothing is drawn, with no Send", () => {
        const html = tray(0);
        expect(html).toContain("Draw a zone around what to change");
        expect(html).not.toContain("browser-annotate-review");
        expect(html).not.toContain("browser-annotate-clear");
    });

    it("counts the zones and offers Clear all and the review once one is drawn", () => {
        expect(tray(1)).toContain("1 zone<");
        const html = tray(3);
        expect(html).toContain("3 zones");
        expect(html).toContain("Clear all");
        expect(html).toContain("Review and send");
        expect(html).toContain("molten-btn");
    });

    it("asks before the zones are lost", () => {
        const html = tray(2, true);
        expect(html).toContain("Discard 2 zones?");
        expect(html).toContain("molten-btn-destructive");
        expect(html).toContain("Keep drawing");
        expect(html).not.toContain("Review and send");
    });

    it("says it in French too", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        expect(tray(2)).toContain("2 zones");
        expect(tray(1)).toContain("1 zone<");
        expect(tray(2)).toContain("Relire et envoyer");
        expect(tray(2, true)).toContain("Abandonner 2 zones ?");
    });
});

describe("a zone and its comment field", () => {
    it("marks the zone with its number and comment, and names it for the keyboard", () => {
        const html = renderToStaticMarkup(<ZoneMark zone={Zone1} n={2} active={false} onEdit={Noop} onErase={Noop} />);
        expect(html).toContain('aria-label="Zone 2: The title is cut."');
        expect(html).toContain('data-n="2"');
        expect(html).toContain('tabindex="0"');
        expect(html).toContain("cursor-pointer");
        expect(html).toContain("left:10.000%");
        expect(html).toContain("The title is cut.");
        expect(renderToStaticMarkup(<NumberBadge n={7} />)).toContain(">7<");
    });

    it("shows a zone with no comment by its number alone", () => {
        const html = renderToStaticMarkup(
            <ZoneMark zone={{ ...Zone1, comment: "" }} n={1} active onEdit={Noop} onErase={Noop} />
        );
        expect(html).toContain('aria-label="Zone 1"');
        expect(html).not.toContain('<span class="min-w-0 truncate');
    });

    it("opens the field with the comment, its hint and a way to erase the zone", () => {
        const html = renderToStaticMarkup(
            <CommentField
                zone={Zone1}
                n={1}
                stage={{ w: 1000, h: 600 }}
                onChange={Noop}
                onCommit={Noop}
                onCancel={Noop}
                onErase={Noop}
            />
        );
        expect(html).toContain("<textarea");
        expect(html).toContain("The title is cut.");
        expect(html).toContain('maxLength="1000"');
        expect(html).toContain("Enter validates, Shift+Enter adds a line");
        expect(html).toContain("Erase this zone");
        expect(html).toContain("What is wrong here?");
    });
});

const Target: AnnotateTarget = {
    address: "http://localhost:5173/some/path?x=1",
    root: "/w/shop-wt/a",
    dir: "/w/shop",
    branch: "feature/1-a",
    workspaceId: "ws-1",
    recipients: [],
};

function who(name: string, why: Recipient["why"], lead: boolean): Recipient {
    return { blockId: `b-${name.toLowerCase()}`, name, agent: "claude", why, lead };
}

function review(props: Partial<ReviewViewProps> = {}): string {
    const recipients = props.recipients ?? [who("Camille", "works", false)];
    return renderToStaticMarkup(
        <ReviewView
            target={Target}
            recipients={recipients}
            chosen={recipients[0] ?? null}
            lost=""
            image="data:image/png;base64,AAAA"
            imageFailed={false}
            report={{ text: "The report's text." }}
            busy={null}
            outcome={null}
            onPick={Noop}
            onSend={Noop}
            onCopy={Noop}
            onBack={Noop}
            onDone={Noop}
            {...props}
        />
    );
}

describe("the review (FR-BRW-017 AC14)", () => {
    it("shows what will be sent: the address, the branch, the image and the report as wavesrv writes it", () => {
        const html = review();
        expect(html).toContain("What will be sent");
        expect(html).toContain("http://localhost:5173/some/path?x=1");
        expect(html).toContain("feature/1-a");
        expect(html).toContain('src="data:image/png;base64,AAAA"');
        expect(html).toContain("The report&#x27;s text.");
        expect(html).toContain("MoltenTerm adds its own header");
    });

    it("proposes the agent working on the worktree and says why, with one click to send it", () => {
        const html = review();
        expect(html).toContain("Camille");
        expect(html).toContain("works on feature/1-a");
        expect(html).toContain("Send to Camille");
        expect(html).toContain("molten-btn");
        expect(html).not.toContain("will be asked to hand the zones");
    });

    it("proposes the project's lead otherwise, which is asked to dispatch the zones", () => {
        const html = review({ recipients: [who("Hugo", "project", true)] });
        expect(html).toContain("leads this project");
        expect(html).toContain("Hugo will be asked to hand the zones to the right agents.");
        expect(html).toContain("Send to Hugo");
        expect(review({ recipients: [who("Hugo", "pr", true)] })).toContain("signed the pull request");
        expect(review({ recipients: [who("Hugo", "owns", true)] })).toContain("owns the agent working on feature/1-a");
        expect(review({ recipients: [who("Hugo", "locked", true)] })).toContain("keeps a name locked for this project");
    });

    it("lets the developer choose among the agents, the chosen one carrying the selected mark", () => {
        const html = review({ recipients: [who("Camille", "works", false), who("Hugo", "project", true)] });
        expect(html).toContain('role="radiogroup"');
        expect(html.match(/role="radio"/g)).toHaveLength(2);
        expect(html.match(/mt-selected-action/g)).toHaveLength(1);
        expect(html).toContain('aria-checked="true"');
        expect(review()).not.toContain("radiogroup");
    });

    it("offers only to copy the report when no agent runs, and sends nothing", () => {
        const html = review({ recipients: [], chosen: null });
        expect(html).toContain("No agent runs for this project right now");
        expect(html).toContain("Copy the report");
        expect(html).not.toContain("browser-annotate-send");
    });

    it("holds the send until the image and the report are ready", () => {
        expect(review({ image: "" })).toMatch(/disabled=""[^>]*data-testid="browser-annotate-send"/);
        expect(review({ report: {} })).toMatch(/disabled=""[^>]*data-testid="browser-annotate-send"/);
        expect(review()).not.toMatch(/disabled=""[^>]*data-testid="browser-annotate-send"/);
        expect(review({ busy: "send" })).toContain("Sending…");
    });

    it("says when the report could not be prepared", () => {
        const html = review({ report: { error: { error: "the page's address is not an http or https address" } } });
        expect(html).toContain("The report could not be prepared");
        expect(html).not.toContain("browser-annotate-report");
    });

    it.each([
        ["delivered", "Camille has it."],
        ["typed", "The request is typed in Camille&#x27;s prompt: press Enter there to send it."],
        ["queued", "Camille is busy: the request is typed when their prompt is free."],
    ] as const)(
        "says how it was handed over (%s) and that the image is kept as a material, then offers Done",
        (delivery, text) => {
            const outcome: Outcome = { kind: "sent", result: { status: "sent", to: "Camille", delivery } };
            const html = review({ outcome });
            expect(html).toContain(text);
            expect(html).toContain("kept in this project&#x27;s materials, not in its files");
            expect(html).toContain("browser-annotate-done");
            expect(html).not.toContain("browser-annotate-send");
            expect(html).not.toContain("browser-annotate-copy");
        }
    );

    it("says an agent that stopped running, and keeps the choice open", () => {
        const html = review({ outcome: { kind: "gone", name: "Camille" } });
        expect(html).toContain("Camille no longer runs. Choose another agent or copy the report.");
        expect(html).toContain("browser-annotate-send");
    });

    it("says a picked agent that went, chooses no other in its place, and asks for a new pick among the agents left", () => {
        const html = review({ recipients: [who("Hugo", "project", true)], chosen: null, lost: "Camille" });
        expect(html).toContain('data-testid="browser-annotate-lost"');
        expect(html).toContain("Camille no longer runs. Choose another agent or copy the report.");
        expect(html).toContain('role="radiogroup"');
        expect(html).toContain("Hugo");
        expect(html).not.toContain('aria-checked="true"');
        expect(html).not.toContain("browser-annotate-chosen");
        expect(html).not.toContain("browser-annotate-send");
        expect(html).toContain("browser-annotate-copy");
    });

    it("says a picked agent that went when no agent is left, with the copy as the way out", () => {
        const html = review({ recipients: [], chosen: null, lost: "Camille" });
        expect(html).toContain("browser-annotate-lost");
        expect(html).toContain("No agent runs for this project right now");
        expect(html).not.toContain("browser-annotate-send");
    });

    it("says nothing of a lost agent when none was picked", () => {
        expect(review()).not.toContain("browser-annotate-lost");
    });

    it.each([
        ["workspace", "Camille works in another workspace: nothing was sent."],
        ["project", "Camille works on another project: nothing was sent."],
    ] as const)("says why a send was refused (%s), and keeps the choice open", (reason, text) => {
        const html = review({ outcome: { kind: "refused", name: "Camille", reason } });
        expect(html).toContain(text);
        expect(html).toContain("browser-annotate-send");
        expect(html).not.toContain("browser-annotate-done");
    });

    it("says why a send was refused in French too", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        const html = review({ outcome: { kind: "refused", name: "Camille", reason: "workspace" } });
        expect(html).toContain("Camille travaille dans un autre espace de travail");
    });

    it("says the copy was made, and a failure with its reason", () => {
        expect(review({ outcome: { kind: "copied" } })).toContain("Report copied. The image is kept in this project");
        const failed = review({
            outcome: { kind: "failed", text: { key: "browser.annotate.sendFailed", vars: { error: "boom" } } },
        });
        expect(failed).toContain("Nothing was sent: ");
    });

    it("is in French too, with no platform name", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        const html = review({ recipients: [who("Hugo", "project", true)] });
        expect(html).toContain("Envoyer à Hugo");
        expect(html).toContain("dirige ce projet");
        expect(html).toContain("Ce qui sera envoyé");
        expect(html).toContain("Copier le rapport");
        expect(html).not.toMatch(/\b(Mac|macOS|Finder|Windows)\b/);
    });
});
