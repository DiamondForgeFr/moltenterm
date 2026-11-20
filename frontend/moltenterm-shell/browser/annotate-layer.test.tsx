// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The comment mode as drawn (FR-BRW-017 AC14, AC17, AC24, AC27, #2327, #2422): the toolbar and its questions, the list of
// comments, a comment and its field, and the review of what will be sent, to whom and why. Synthetic agents, pages and
// branches only.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { I18nModel } from "../i18n/i18n";
import type { Captured } from "./annotate-capture";
import { CommentField } from "./annotate-layer";
import type { AnnotateTarget, Recipient, Zone } from "./annotate-model";
import { type Outcome, ReviewView, type ReviewViewProps } from "./annotate-review";
import { CaptureBar, CommentList, CommentToolbar, type CommentToolbarProps } from "./annotate-toolbar";

const Noop = () => {};
const Page = "http://localhost:5173/some/path?x=1";
const Zone1: Zone = {
    id: 1,
    kind: "zone",
    anchor: { box: { x: 100, y: 1200, w: 300, h: 150 }, selector: "main > .card", rel: null, fixed: false, path: null },
    address: Page,
    comment: "The title is cut.",
    refs: [],
};
const Thumb = "data:image/png;base64,iVBORw0KGgo=";

const toolbarProps: CommentToolbarProps = {
    tool: "point",
    paused: false,
    count: 0,
    listOpen: false,
    leaveAsk: false,
    pageAsk: null,
    onTool: Noop,
    onPause: Noop,
    onList: Noop,
    onClear: Noop,
    onReview: Noop,
    onClose: Noop,
    onDiscard: Noop,
    onKeep: Noop,
    onKeepPage: Noop,
    onDiscardPage: Noop,
};

function bar(change: Partial<CommentToolbarProps> = {}): string {
    return renderToStaticMarkup(<CommentToolbar {...toolbarProps} {...change} />);
}

afterEach(() => I18nModel.getInstance().setLanguageSetting("en"));

describe("the toolbar (FR-BRW-017 AC24)", () => {
    it("holds the three tools, Pause, the count that opens the list, and Close", () => {
        const html = bar();
        for (const id of ["tool-point", "tool-zone", "tool-freehand", "pause", "count", "close"]) {
            expect(html).toContain(`data-testid="browser-annotate-${id}"`);
        }
        expect(html).toContain('role="toolbar"');
        expect(html).toContain("0 comments");
        expect(html).toContain('aria-expanded="false"');
    });

    it("says what the tool in use does, while no comment is made", () => {
        expect(bar()).toContain("Click an element to comment on it.");
        expect(bar({ tool: "zone" })).toContain("Drag a rectangle around what to change.");
        expect(bar({ tool: "freehand" })).toContain("Draw an outline around what to change.");
        expect(bar({ paused: true })).toContain("Paused: the page works as usual.");
        expect(bar({ count: 2 })).not.toContain("browser-annotate-hint");
    });

    it("marks the tool in use with the selected line, and none while paused", () => {
        const html = bar({ tool: "zone" });
        expect(html.match(/mt-selected-action/g)).toHaveLength(1);
        expect(html).toMatch(/mt-selected-action[^>]*aria-pressed="true"[^>]*data-testid="browser-annotate-tool-zone"/);
        expect(bar({ tool: "zone", paused: true })).not.toContain("mt-selected-action");
    });

    it("shows Pause pressed, and offers to resume, while paused", () => {
        const on = bar({ paused: true });
        expect(on).toMatch(/aria-pressed="true"[^>]*data-testid="browser-annotate-pause"/);
        expect(on).toContain('aria-label="Resume commenting"');
        expect(bar()).toContain('aria-label="Pause: use the page as usual"');
    });

    it("counts the comments, and offers Clear all and the review only once there is one", () => {
        expect(bar({ count: 1 })).toContain("1 comment<");
        const html = bar({ count: 3, listOpen: true });
        expect(html).toContain("3 comments");
        expect(html).toContain('aria-expanded="true"');
        expect(html).toContain("Clear all");
        expect(html).toContain("Review and send");
        expect(bar()).not.toContain("browser-annotate-review");
        expect(bar()).not.toContain("browser-annotate-clear");
    });

    it("keeps the bar on one line in a narrow panel: the number and an icon, the words when the panel has room", () => {
        const html = bar({ count: 3 });
        expect(html).toContain('class="hidden @[560px]:inline">3 comments<');
        expect(html).toContain('class="@[560px]:hidden">3<');
        expect(html).toMatch(/aria-label="Clear all"[^>]*data-testid="browser-annotate-clear"/);
        expect(html).toContain('title="Clear all"');
    });

    it("keeps the call to action alone orange: Review and send is the one molten button", () => {
        const html = bar({ count: 2 });
        expect(html.match(/molten-btn(?![-\w])/g)).toHaveLength(1);
        expect(html).toMatch(/molten-btn[^>]*data-testid="browser-annotate-review"/);
        expect(html).not.toContain("molten-btn-destructive");
    });

    it("says when the report is full", () => {
        expect(bar({ count: 20 })).toContain("That is the most comments one report holds (20).");
    });

    it("asks before the comments are lost, with Discard as the destructive action", () => {
        const html = bar({ count: 2, leaveAsk: true });
        expect(html).toContain("Discard 2 comments?");
        expect(html).toContain("molten-btn-destructive");
        expect(html).toContain("Keep commenting");
        expect(html).not.toContain("Review and send");
        expect(html).not.toContain("browser-annotate-tool-point");
    });

    it("asks to keep or discard the comments of a page that was left, naming the page", () => {
        const html = bar({ count: 3, pageAsk: { count: 2, page: "localhost:5173/some/path", pages: 1 } });
        expect(html).toContain("The page changed. Keep the 2 comments you left on localhost:5173/some/path?");
        expect(html).toContain("without an image");
        expect(html).toMatch(/molten-btn[^>]*data-testid="browser-annotate-ask-keep"/);
        expect(html).toContain('data-testid="browser-annotate-ask-discard"');
        expect(html).not.toContain("Review and send");
        const one = bar({ count: 1, pageAsk: { count: 1, page: "localhost:5173/cart", pages: 1 } });
        expect(one).toContain("Keep the comment you left on localhost:5173/cart?");
        const many = bar({ count: 4, pageAsk: { count: 4, page: "localhost:5173/a", pages: 2 } });
        expect(many).toContain("you left on 2 other pages?");
    });

    it("is in French too, with no platform name", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        const html = bar({ count: 2 });
        expect(html).toContain("2 commentaires");
        expect(html).toContain("Relire et envoyer");
        expect(html).toContain("Commenter un élément");
        expect(bar({ count: 2, leaveAsk: true })).toContain("Abandonner 2 commentaires ?");
        expect(bar({ paused: true })).toContain("En pause");
        expect(bar({ count: 2, pageAsk: { count: 2, page: "localhost:5173/a", pages: 1 } })).toContain(
            "Garder les 2 commentaires"
        );
        expect(html).not.toMatch(/\b(Mac|macOS|Finder|Windows)\b/);
    });
});

describe("the bar shown while the pictures are taken", () => {
    it("says how far the page is, and can be cancelled", () => {
        const html = renderToStaticMarkup(<CaptureBar done={1} total={4} onCancel={Noop} />);
        expect(html).toContain("Capturing the page… 1 of 4");
        expect(html).toContain('data-testid="browser-annotate-capture-cancel"');
        expect(html).toContain('role="status"');
    });
});

describe("the list of comments", () => {
    const zones: Zone[] = [
        Zone1,
        { ...Zone1, id: 2, kind: "point", comment: "", address: Page },
        {
            ...Zone1,
            id: 3,
            kind: "freehand",
            comment: "Too close.\nSecond line",
            address: "http://localhost:5173/cart",
        },
    ];
    const list = (editingId = 0, shown = zones) =>
        renderToStaticMarkup(
            <CommentList zones={shown} address={Page} editingId={editingId} onGo={Noop} onEdit={Noop} onErase={Noop} />
        );

    it("lists every comment, numbered, by its first line, with a way to go to it, edit it and erase it", () => {
        const html = list();
        expect(html.match(/data-testid="browser-annotate-list-item"/g)).toHaveLength(3);
        expect(html).toContain('data-n="1"');
        expect(html).toContain("The title is cut.");
        expect(html).toContain("Too close.");
        expect(html).not.toContain("Second line");
        expect(html).toContain("No text yet");
        expect(html.match(/data-testid="browser-annotate-list-go"/g)).toHaveLength(3);
        expect(html.match(/data-testid="browser-annotate-list-edit"/g)).toHaveLength(3);
        expect(html.match(/data-testid="browser-annotate-list-erase"/g)).toHaveLength(3);
        expect(html).toContain('aria-label="Comments"');
    });

    it("says where a comment of another page is, and cannot be gone to from this one", () => {
        const html = list();
        expect(html).toContain("On localhost:5173/cart");
        expect(html.match(/disabled=""/g)).toHaveLength(1);
        expect(html).toMatch(/disabled=""[^>]*data-testid="browser-annotate-list-go"/);
    });

    it("says there is none yet", () => {
        expect(list(0, [])).toContain("No comment yet.");
    });

    it("says when the page no longer has the element a comment is on, instead of keeping quiet about it", () => {
        const html = renderToStaticMarkup(
            <CommentList
                zones={zones}
                address={Page}
                editingId={0}
                missing={[1, 3]}
                onGo={Noop}
                onEdit={Noop}
                onErase={Noop}
            />
        );
        // The third comment is on another page: only the first, on the page shown, can say its element is gone.
        expect(html.match(/data-testid="browser-annotate-list-missing"/g)).toHaveLength(1);
        expect(html).toContain("Element no longer found: the mark stays where it was drawn.");
        expect(list()).not.toContain("browser-annotate-list-missing");
    });

    it("is in French too", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        const html = list();
        expect(html).toContain("Commentaires");
        expect(html).toContain("Pas encore de texte");
        expect(html).toContain("Sur localhost:5173/cart");
    });
});

describe("a comment and its field", () => {
    function field(zone: Zone, note = ""): string {
        return renderToStaticMarkup(
            <CommentField
                zone={zone}
                n={1}
                box={{ x: 100, y: 120, w: 200, h: 100 }}
                stage={{ w: 1000, h: 600 }}
                note={note}
                onChange={Noop}
                onCommit={Noop}
                onCancel={Noop}
                onErase={Noop}
                onAttach={Noop}
                onRemoveRef={Noop}
            />
        );
    }

    it("opens beside its mark, taking the pointer the layer lets through, and names itself for the keyboard", () => {
        const html = field(Zone1);
        expect(html).toContain("pointer-events-auto");
        expect(html).toContain('aria-label="Comment 1"');
        expect(html).toContain("left:308px");
        expect(html).toContain("top:120px");
    });

    it("shows the reference images under the comment as thumbnails, each with its remove", () => {
        const html = field({
            ...Zone1,
            refs: [
                { id: 1, dataUrl: Thumb },
                { id: 2, dataUrl: Thumb + "A" },
            ],
        });
        expect(html).toContain('data-testid="browser-annotate-refs"');
        expect(html.match(/data-testid="browser-annotate-ref"/g)).toHaveLength(2);
        expect(html.match(/data-testid="browser-annotate-ref-remove"/g)).toHaveLength(2);
        expect(html).toContain('alt="Reference image 2"');
        expect(html).toContain("Remove this image");
        expect(html).toContain(`src="${Thumb}"`);
        expect(field(Zone1)).not.toContain("browser-annotate-refs");
    });

    it("shows the links of the comment as chips with their host name, and keeps them in the text", () => {
        const html = field({
            ...Zone1,
            comment: "Like https://www.example.test/inspiration/a?b=1 and http://localhost:3000/x",
        });
        expect(html.match(/data-testid="browser-annotate-link"/g)).toHaveLength(2);
        expect(html).toContain("www.example.test");
        expect(html).toContain("localhost:3000");
        expect(html).toContain('title="https://www.example.test/inspiration/a?b=1"');
        expect(html).toContain(
            "Like https://www.example.test/inspiration/a?b=1 and http://localhost:3000/x</textarea>"
        );
    });

    it("makes no chip of an address that is no web link, and none of a comment with no link", () => {
        const html = field({ ...Zone1, comment: "see javascript:alert(1), file:///etc/passwd and data:text/html,x" });
        expect(html).not.toContain("browser-annotate-link");
        expect(field(Zone1)).not.toContain("browser-annotate-links");
    });

    it("says how to attach an image, and why the last one could not be", () => {
        const html = field(Zone1, "Only png, jpeg, webp and gif images can be attached.");
        expect(html).toContain("Paste or drop an image (up to 4)");
        expect(html).toContain('data-testid="browser-annotate-ref-note"');
        expect(html).toContain("Only png, jpeg, webp and gif images can be attached.");
        expect(field(Zone1)).not.toContain("browser-annotate-ref-note");
    });

    it("opens the field with the comment, its hint and a way to erase the comment", () => {
        const html = field(Zone1);
        expect(html).toContain("<textarea");
        expect(html).toContain("The title is cut.");
        expect(html).toContain('maxLength="1000"');
        expect(html).toContain("Enter validates, Shift+Enter adds a line");
        expect(html).toContain("Erase this comment");
        expect(html).toContain("What is wrong here?");
    });
});

const Target: AnnotateTarget = {
    address: Page,
    root: "/w/shop-wt/a",
    dir: "/w/shop",
    branch: "feature/1-a",
    workspaceId: "ws-1",
    recipients: [],
};

function who(name: string, why: Recipient["why"], lead: boolean): Recipient {
    return { blockId: `b-${name.toLowerCase()}`, name, agent: "claude", why, lead };
}

const Taken: Captured = {
    crops: { 1: "data:image/png;base64,CROP1" },
    overview: "data:image/png;base64,OVERVIEW",
    noOverview: "",
    reasons: {},
    missing: [],
};

function review(props: Partial<ReviewViewProps> = {}): string {
    const recipients = props.recipients ?? [who("Camille", "works", false)];
    return renderToStaticMarkup(
        <ReviewView
            target={Target}
            zones={[Zone1]}
            recipients={recipients}
            chosen={recipients[0] ?? null}
            lost=""
            captured={Taken}
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

describe("the review (FR-BRW-017 AC14, AC26)", () => {
    it("shows each comment's reference images and links as they will be sent, and nothing when there are none", () => {
        const zones: Zone[] = [
            Zone1,
            { ...Zone1, id: 2, comment: "Like https://example.test/inspiration", refs: [{ id: 7, dataUrl: Thumb }] },
            { ...Zone1, id: 3, comment: "javascript:alert(1)" },
        ];
        const html = review({
            zones,
            report: { text: "The report's text.", links: [[], ["https://example.test/inspiration"], []] },
        });
        expect(html.match(/data-testid="browser-annotate-review-zone"/g)).toHaveLength(3);
        expect(html.match(/data-testid="browser-annotate-refs"/g)).toHaveLength(1);
        expect(html.match(/data-testid="browser-annotate-links"/g)).toHaveLength(1);
        expect(html).toContain("Comment 2");
        expect(html).toContain(`src="${Thumb}"`);
        expect(html).toContain("example.test");
        expect(html).not.toContain("browser-annotate-ref-remove");
        expect(review()).not.toContain("browser-annotate-refs");
    });

    it("shows the links the brief lists, not the ones the comment seems to hold", () => {
        const zones: Zone[] = [{ ...Zone1, comment: "Like https://typed.test/a" }];
        const listed = review({ zones, report: { text: "x", links: [["https://listed.test/b"]] } });
        expect(listed).toContain("listed.test");
        expect(listed).not.toContain("typed.test/a</p>x");
        expect(listed.match(/data-testid="browser-annotate-link"/g)).toHaveLength(1);
        expect(review({ zones, report: { text: "x" } })).not.toContain("browser-annotate-link");
    });

    it("shows what will be sent: the address, the branch, the overview, each comment's image and the report as wavesrv writes it", () => {
        const html = review();
        expect(html).toContain("What will be sent");
        expect(html).toContain("http://localhost:5173/some/path?x=1");
        expect(html).toContain("feature/1-a");
        expect(html).toContain('src="data:image/png;base64,OVERVIEW"');
        expect(html).toContain('src="data:image/png;base64,CROP1"');
        expect(html).toContain("The title is cut.");
        expect(html).toContain("The report&#x27;s text.");
        expect(html).toContain("MoltenTerm adds its own header");
    });

    it("says why there is no overview, and why a comment has no image", () => {
        const none = (noOverview: Captured["noOverview"]) =>
            review({ captured: { ...Taken, crops: {}, overview: "", noOverview } });
        expect(none("none")).toContain("No overview: none of the comments is on the page shown.");
        expect(none("tall")).toContain("No overview: the page is taller than 12 screens.");
        expect(none("inner")).toContain("No overview: the page scrolls inside one of its areas.");
        expect(none("failed")).toContain("No overview: the page could not be captured whole.");
        expect(none("failed")).toContain("No image: the page gave no picture of it.");
        expect(none("failed")).not.toContain("browser-annotate-overview");
        const elsewhere = review({
            zones: [{ ...Zone1, address: "http://localhost:5173/cart" }],
            captured: { ...Taken, crops: {}, overview: "", noOverview: "none" },
        });
        expect(elsewhere).toContain("No image: its page is no longer shown.");
        expect(elsewhere).toContain("On localhost:5173/cart");
    });

    it("says why a comment's mark has no image when a scrolling area of the page clips it, and when its element is gone", () => {
        const clipped = review({ captured: { ...Taken, crops: {}, reasons: { 1: "clipped" } } });
        expect(clipped).toContain("No image: a scrolling area of the page hides the mark.");
        expect(clipped).not.toContain("the page gave no picture of it");
        const gone = review({ captured: { ...Taken, missing: [1] } });
        expect(gone).toContain('data-testid="browser-annotate-review-missing"');
        expect(gone).toContain("Element no longer found: the mark stays where it was drawn.");
        expect(review()).not.toContain("browser-annotate-review-missing");
    });

    it("does not offer to go back while a send or a copy is under way", () => {
        expect(review({ busy: "send" })).toMatch(/disabled=""[^>]*data-testid="browser-annotate-back"/);
        expect(review({ busy: "copy" })).toMatch(/disabled=""[^>]*data-testid="browser-annotate-back"/);
        expect(review()).not.toMatch(/disabled=""[^>]*data-testid="browser-annotate-back"/);
    });

    it("proposes the agent working on the worktree and says why, with one click to send it", () => {
        const html = review();
        expect(html).toContain("Camille");
        expect(html).toContain("works on feature/1-a");
        expect(html).toContain("Send to Camille");
        expect(html).toContain("molten-btn");
        expect(html).not.toContain("will be asked to hand the comments");
    });

    it("proposes the project's lead otherwise, which is asked to dispatch the comments", () => {
        const html = review({ recipients: [who("Hugo", "project", true)] });
        expect(html).toContain("leads this project");
        expect(html).toContain("Hugo will be asked to hand the comments to the right agents.");
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

    it("holds the send until the report is ready, whatever the images are", () => {
        expect(review({ report: {} })).toMatch(/disabled=""[^>]*data-testid="browser-annotate-send"/);
        expect(review()).not.toMatch(/disabled=""[^>]*data-testid="browser-annotate-send"/);
        expect(review({ captured: { ...Taken, crops: {}, overview: "", noOverview: "tall" } })).not.toMatch(
            /disabled=""[^>]*data-testid="browser-annotate-send"/
        );
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
        "says how it was handed over (%s) and that the images are kept as materials, then offers Done",
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
        expect(review({ outcome: { kind: "copied" } })).toContain("Report copied. The images are kept in this project");
        const failed = review({
            outcome: { kind: "failed", text: { key: "browser.annotate.sendFailed", vars: { error: "boom" } } },
        });
        expect(failed).toContain("Nothing was sent: ");
    });

    it("says the images are too large for one report", () => {
        const failed = review({ outcome: { kind: "failed", text: { key: "browser.annotate.review.tooLarge" } } });
        expect(failed).toContain("The images are too large for one report.");
    });

    it("is in French too, with no platform name", () => {
        I18nModel.getInstance().setLanguageSetting("fr");
        const html = review({ recipients: [who("Hugo", "project", true)] });
        expect(html).toContain("Envoyer à Hugo");
        expect(html).toContain("dirige ce projet");
        expect(html).toContain("Ce qui sera envoyé");
        expect(html).toContain("Copier le rapport");
        expect(html).toContain("Vue d&#x27;ensemble de la page");
        expect(html).not.toMatch(/\b(Mac|macOS|Finder|Windows)\b/);
    });
});
