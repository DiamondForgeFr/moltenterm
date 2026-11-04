// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/contextmenu", () => ({ ContextMenuModel: { getInstance: () => ({ showContextMenu: vi.fn() }) } }));
vi.mock("@/util/platformutil", () => ({ isMacOS: () => true }));
vi.mock("../settings/settings-open", () => ({ openSettingsSection: vi.fn() }));
vi.mock("./boss-store", async () => {
    const { atom } = await import("jotai");
    const { DefaultBubbleState } = await import("./boss-place");
    const model = {
        showAtom: atom(true),
        nameAtom: atom("Ferrand"),
        stateAtom: atom(DefaultBubbleState),
        collapsedAtom: atom(false),
        dragAtom: atom(null),
        cueAtom: atom(0),
        peekOpenAtom: atom(false),
        cardOpenAtom: atom(false),
        badgeAtom: atom({ count: 0, text: "", tone: "waiting" }),
        peekAtom: atom({ waiting: [], waitingMore: 0, working: [], workingMore: 0, usage: "", latest: null }),
        attach: vi.fn(() => () => {}),
        setRectSource: vi.fn(),
        collapse: vi.fn(),
        expand: vi.fn(),
        resetPosition: vi.fn(),
        drop: vi.fn(),
        toggleCard: vi.fn(),
        closeCard: vi.fn(),
    };
    return { BossBubbleModel: { getInstance: () => model } };
});
// The card has its own tests (boss-card.test.tsx): here it only stands where the bubble puts it.
vi.mock("./boss-card", () => ({
    BossCard: ({ style }: { style: Record<string, string> }) => <div data-testid="boss-card" style={style} />,
}));

import { globalStore } from "@/app/store/jotaiStore";
import { BossBubbleHost } from "./boss-bubble";
import { DefaultBubbleState } from "./boss-place";
import { BossBubbleModel } from "./boss-store";

const model = BossBubbleModel.getInstance() as any;

function render(): string {
    return renderToStaticMarkup(<BossBubbleHost />);
}

beforeEach(() => {
    globalStore.set(model.showAtom, true);
    globalStore.set(model.nameAtom, "Ferrand");
    globalStore.set(model.stateAtom, DefaultBubbleState);
    globalStore.set(model.collapsedAtom, false);
    globalStore.set(model.dragAtom, null);
    globalStore.set(model.cueAtom, 0);
    globalStore.set(model.peekOpenAtom, false);
    globalStore.set(model.cardOpenAtom, false);
    globalStore.set(model.badgeAtom, { count: 0, text: "", tone: "waiting" });
    globalStore.set(model.peekAtom, {
        waiting: [],
        waitingMore: 0,
        working: [],
        workingMore: 0,
        usage: "",
        latest: null,
    });
});

// The tests run in a plain Node environment, which has no DOM parser: read the markup with patterns.
function attr(html: string, testId: string, name: string): string {
    const tag = new RegExp(`<[a-z]+ [^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? "";
    return new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
}

describe("the bubble (FR-BOSS-001, AC1, AC10)", () => {
    it("is a button of 44 px with the portrait, named with the name and the count", () => {
        globalStore.set(model.badgeAtom, { count: 2, text: "2", tone: "waiting" });
        const html = render();
        expect(html).toContain('data-testid="boss-bubble"');
        expect(html).toContain('type="button"');
        expect(attr(html, "boss-bubble", "aria-label")).toBe("Ferrand, 2 waiting");
        expect(html).toContain("<svg");
        expect(html).not.toContain('data-testid="boss-pennant"');
    });

    it("is anchored to the bottom right, off the corner, with CSS that keeps it in view", () => {
        const style = attr(render(), "boss-bubble", "style");
        expect(style).toContain("right:max(8px, min(16px, calc(100% - 52px)))");
        expect(style).toContain("bottom:max(8px, min(16px, calc(100% - 52px)))");
    });

    it("uses the name the developer chose in its name", () => {
        globalStore.set(model.nameAtom, "Léa");
        globalStore.set(model.badgeAtom, { count: 1, text: "1", tone: "error" });
        expect(attr(render(), "boss-bubble", "aria-label")).toBe("Léa, 1 waiting");
    });

    it("describes itself with the peek's text, for screen readers", () => {
        globalStore.set(model.badgeAtom, { count: 1, text: "1", tone: "error" });
        globalStore.set(model.peekAtom, {
            waiting: [{ id: "b1", name: "Léa", workspace: "Alpha", state: "error" }],
            waitingMore: 0,
            working: [],
            workingMore: 0,
            usage: "",
            latest: null,
        });
        const html = render();
        const describedBy = attr(html, "boss-bubble", "aria-describedby");
        expect(describedBy).toBeTruthy();
        expect(attr(html, "boss-description", "id")).toBe(describedBy);
        const description = /data-testid="boss-description">([\s\S]*?)<\/div><\/div>(?:<div|$)/.exec(html)?.[1] ?? "";
        expect(description).toContain("Léa");
        expect(description).toContain("Alpha");
    });
});

describe("the badge (AC5)", () => {
    it("is hidden at zero", () => {
        expect(render()).not.toContain('data-testid="boss-badge"');
    });

    it("counts, red when an agent failed and amber otherwise, 9+ beyond nine", () => {
        globalStore.set(model.badgeAtom, { count: 3, text: "3", tone: "waiting" });
        let html = render();
        expect(attr(html, "boss-badge", "data-tone")).toBe("waiting");
        expect(html).toMatch(/data-testid="boss-badge"[^>]*>3</);
        globalStore.set(model.badgeAtom, { count: 12, text: "9+", tone: "error" });
        html = render();
        expect(attr(html, "boss-badge", "data-tone")).toBe("error");
        expect(html).toMatch(/data-testid="boss-badge"[^>]*>9\+</);
    });
});

describe("the cue (AC6)", () => {
    it("plays for no rise at the start, and a bubble drawn anew has nothing to play", () => {
        expect(attr(render(), "boss-bubble", "class")).not.toContain("mt-boss-cue");
        // A bubble drawn with a cue already counted (a window starting, an unfold) has nothing to play: the class
        // follows only the rises it saw.
        globalStore.set(model.cueAtom, 1);
        expect(attr(render(), "boss-bubble", "class")).not.toContain("mt-boss-cue");
    });

    it("has two names for one motion, so the next rise plays it again without drawing the button anew", () => {
        const css = readFileSync(join(__dirname, "boss-bubble.css"), "utf8");
        for (const kind of ["bubble", "pennant"]) {
            expect(css).toMatch(
                new RegExp(`\\.mt-boss-${kind}\\.mt-boss-cue-a \\{[^}]*animation: mt-boss-(nudge|wave)-a`)
            );
            expect(css).toMatch(
                new RegExp(`\\.mt-boss-${kind}\\.mt-boss-cue-b \\{[^}]*animation: mt-boss-(nudge|wave)-b`)
            );
        }
        expect(css).toMatch(/\.mt-boss-bubble\.mt-boss-cue-a \{[^}]* 1;/);
    });

    it("is stilled by reduced motion in the stylesheet, which leaves the badge alone", () => {
        const css = readFileSync(join(__dirname, "boss-bubble.css"), "utf8");
        const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
        expect(reduced).toMatch(/\.mt-boss-bubble\.mt-boss-cue-a[\s\S]*animation: none/);
        expect(css).toMatch(/\.prefers-reduced-motion \.mt-boss-pennant\.mt-boss-cue-b/);
        expect(css).not.toMatch(/animation-iteration-count:\s*infinite/);
        expect(css).not.toMatch(/\binfinite\b/);
    });
});

describe("the pennant (AC3)", () => {
    beforeEach(() => globalStore.set(model.collapsedAtom, true));

    it("shows the first letter of the name instead of the bubble", () => {
        const html = render();
        expect(html).toContain('data-testid="boss-pennant"');
        expect(html).not.toContain('data-testid="boss-bubble"');
        expect(html).toMatch(/class="mt-boss-initial"[^>]*>F</);
        globalStore.set(model.nameAtom, "léa");
        expect(render()).toMatch(/class="mt-boss-initial"[^>]*>L</);
    });

    it("is a button named like the bubble, with its badge", () => {
        globalStore.set(model.badgeAtom, { count: 4, text: "4", tone: "waiting" });
        const html = render();
        expect(attr(html, "boss-pennant", "aria-label")).toBe("Ferrand, 4 waiting");
        expect(html).toMatch(/data-testid="boss-badge"[^>]*>4</);
    });

    it("hangs from the top edge, off the right edge", () => {
        const style = attr(render(), "boss-pennant", "style");
        expect(style).toContain("right:24px");
        const css = readFileSync(join(__dirname, "boss-bubble.css"), "utf8");
        expect(css).toMatch(/\.mt-boss-pennant \{[^}]*top: 0;/);
    });
});

describe("the peek (AC7)", () => {
    const peek = {
        waiting: [
            { id: "b1", name: "Léa", workspace: "Alpha", state: "error" },
            { id: "b2", name: "Max", workspace: "Beta", state: "waiting" },
        ],
        waitingMore: 2,
        working: [{ workspace: "Alpha", names: ["Zoé", "Jo"], more: 0 }],
        workingMore: 0,
        usage: "Claude Code: Week, 61 % used",
        latest: { id: "n1", title: "Léa stopped", message: "A test failed." },
    };

    it("shows nothing until the pointer has stayed", () => {
        globalStore.set(model.peekAtom, peek);
        expect(render()).not.toContain('data-testid="boss-peek"');
    });

    it("lists what waits, who works where, the usage line and the latest notification, read only", () => {
        globalStore.set(model.peekAtom, peek);
        globalStore.set(model.peekOpenAtom, true);
        const html = render();
        const card = html.slice(html.indexOf('data-testid="boss-peek"'));
        expect(card).toContain("Léa");
        expect(card).toContain("Alpha");
        expect(card).toContain("error");
        expect(card).toContain("waiting for you");
        expect(card).toContain("and 2 more");
        expect(card).toContain("Zoé, Jo");
        expect(card).toContain("Claude Code: Week, 61 % used");
        expect(card).toContain("Léa stopped");
        expect(card).toContain("A test failed.");
        expect(card).not.toContain("<button");
        expect(card).not.toContain("<input");
        expect(card).not.toContain("tabindex");
    });

    it("takes neither the pointer nor the focus", () => {
        globalStore.set(model.peekOpenAtom, true);
        const html = render();
        expect(attr(html, "boss-peek", "aria-hidden")).toBe("true");
        const css = readFileSync(join(__dirname, "boss-bubble.css"), "utf8");
        expect(css).toMatch(/\.mt-boss-peek \{[^}]*pointer-events: none;/);
    });

    it("says that nothing waits when nobody does", () => {
        globalStore.set(model.peekOpenAtom, true);
        expect(render()).toContain("Nothing waits for you.");
    });

    it("hangs under the pennant when collapsed", () => {
        globalStore.set(model.collapsedAtom, true);
        globalStore.set(model.peekOpenAtom, true);
        const style = attr(render(), "boss-peek", "style");
        expect(style).toContain("top:22px");
        expect(style).toContain("right:24px");
    });

    it("is gone while the bubble is dragged", () => {
        globalStore.set(model.peekOpenAtom, true);
        globalStore.set(model.dragAtom, { left: 10, top: 10, width: 44, height: 44 });
        expect(render()).not.toContain('data-testid="boss-peek"');
    });
});

describe("the Sessions card (FR-BOSS-002)", () => {
    it("is not drawn until the developer asks, and the buttons say a card hangs off them", () => {
        const html = render();
        expect(html).not.toContain('data-testid="boss-card"');
        expect(attr(html, "boss-bubble", "aria-haspopup")).toBe("dialog");
        expect(attr(html, "boss-bubble", "aria-expanded")).toBe("false");
        globalStore.set(model.collapsedAtom, true);
        expect(attr(render(), "boss-pennant", "aria-haspopup")).toBe("dialog");
        expect(attr(render(), "boss-pennant", "aria-expanded")).toBe("false");
    });

    it("marks the bubble and the pennant as its anchor, so a press on them is the toggle's", () => {
        expect(render()).toMatch(/data-testid="boss-bubble"[^>]*data-boss-anchor=""/);
        globalStore.set(model.collapsedAtom, true);
        expect(render()).toMatch(/data-testid="boss-pennant"[^>]*data-boss-anchor=""/);
    });

    it("sits beside the bubble, on the side of its corner, once opened", () => {
        globalStore.set(model.cardOpenAtom, true);
        const html = render();
        expect(attr(html, "boss-bubble", "aria-expanded")).toBe("true");
        const style = attr(html, "boss-card", "style");
        expect(style).toContain("right:max(8px, min(16px, calc(100% - 52px)))");
        expect(style).toContain("bottom:calc(max(8px, min(16px, calc(100% - 52px))) + 52px)");
        expect(style).toContain("max-height:calc(100% - calc(max(8px, min(16px, calc(100% - 52px))) + 52px) - 8px)");
    });

    it("hangs under the pennant, aligned with its edge, when collapsed", () => {
        globalStore.set(model.collapsedAtom, true);
        globalStore.set(model.cardOpenAtom, true);
        const style = attr(render(), "boss-card", "style");
        expect(style).toContain("top:22px");
        expect(style).toContain("right:24px");
        expect(style).toContain("max-height:calc(100% - 30px)");
    });

    it("takes the peek's place: the peek does not show over an open card", () => {
        globalStore.set(model.peekOpenAtom, true);
        globalStore.set(model.cardOpenAtom, true);
        const html = render();
        expect(html).toContain('data-testid="boss-card"');
        expect(html).not.toContain('data-testid="boss-peek"');
    });

    it("is gone while the bubble is dragged", () => {
        globalStore.set(model.cardOpenAtom, true);
        globalStore.set(model.dragAtom, { left: 10, top: 10, width: 44, height: 44 });
        expect(render()).not.toContain('data-testid="boss-card"');
    });

    it("is drawn in the layer over the content, not in the layout: it takes the pointer and no room", () => {
        const css = readFileSync(join(__dirname, "boss-bubble.css"), "utf8");
        expect(css).toMatch(/\.mt-boss-card \{[^}]*position: absolute;/);
        expect(css).toMatch(/\.mt-boss-card \{[^}]*pointer-events: auto;/);
        expect(css).toMatch(/\.mt-boss-layer \{[^}]*pointer-events: none;/);
    });

    it("is not drawn at all when the bubble is turned off", () => {
        globalStore.set(model.cardOpenAtom, true);
        globalStore.set(model.showAtom, false);
        expect(render()).toBe("");
    });
});

describe("the setting Show the bubble (AC9)", () => {
    it("shows neither the bubble nor the pennant when off", () => {
        globalStore.set(model.showAtom, false);
        expect(render()).toBe("");
        globalStore.set(model.collapsedAtom, true);
        expect(render()).toBe("");
    });
});

describe("the portrait", () => {
    it("is an original SVG asset that carries the AGPL header", () => {
        const svg = readFileSync(join(__dirname, "ferrand.svg"), "utf8");
        expect(svg).toContain("SPDX-License-Identifier: AGPL-3.0-only");
        expect(svg).toContain('viewBox="0 0 96 96"');
    });
});
