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
    const { NoScreenHold } = await import("./boss-screen-model");
    const model = {
        showAtom: atom(true),
        nameAtom: atom("Brokk"),
        stateAtom: atom(DefaultBubbleState),
        collapsedAtom: atom(false),
        dragAtom: atom(null),
        cueAtom: atom(0),
        peekOpenAtom: atom(false),
        screenHoldAtom: atom(NoScreenHold),
        cardOpenAtom: atom(false),
        badgeAtom: atom({ count: 0, text: "", tone: "waiting" }),
        workingCountAtom: atom(0),
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
// His animated portrait has its own tests (brokk-live, use-brokk-live): here the bubble only asks for it.
vi.mock("./brokk-expressions", async () => {
    const { atom } = await import("jotai");
    const askedAtom = atom(null);
    return {
        BrokkExpressionsModel: { getInstance: () => ({ askedAtom, ask: vi.fn(), watch: vi.fn(() => () => {}) }) },
    };
});
// The card has its own tests (boss-card.test.tsx): here it only stands where the bubble puts it.
vi.mock("./boss-card", () => ({
    BossCard: ({ style }: { style: Record<string, string> }) => <div data-testid="boss-card" style={style} />,
}));

import { globalStore } from "@/app/store/jotaiStore";
import { BossBubbleHost } from "./boss-bubble";
import { Corners, DefaultBubbleState } from "./boss-place";
import { holdAfter, NoScreenHold, ScreenSizePx, ScreenSlopPx } from "./boss-screen-model";
import { BossBubbleModel } from "./boss-store";

const model = BossBubbleModel.getInstance() as any;

function render(): string {
    return renderToStaticMarkup(<BossBubbleHost />);
}

// A stylesheet without its comments, which explain the rules in words the patterns below would catch.
function css(file: string = "boss-bubble.css"): string {
    return readFileSync(join(__dirname, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

beforeEach(() => {
    globalStore.set(model.showAtom, true);
    globalStore.set(model.nameAtom, "Brokk");
    globalStore.set(model.stateAtom, DefaultBubbleState);
    globalStore.set(model.collapsedAtom, false);
    globalStore.set(model.dragAtom, null);
    globalStore.set(model.cueAtom, 0);
    globalStore.set(model.peekOpenAtom, false);
    globalStore.set(model.screenHoldAtom, NoScreenHold);
    globalStore.set(model.cardOpenAtom, false);
    globalStore.set(model.badgeAtom, { count: 0, text: "", tone: "waiting" });
    globalStore.set(model.workingCountAtom, 0);
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
        expect(attr(html, "boss-bubble", "aria-label")).toBe("Brokk, 2 waiting");
        expect(html).toMatch(/<img class="mt-boss-portrait-image" src="[^"]*brokk[^"]*\.jpg"/);
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

describe("the cue (AC6; FR-BOSS-007, AC3)", () => {
    it("plays for no rise at the start, and a bubble drawn anew has nothing to play", () => {
        globalStore.set(model.collapsedAtom, true);
        expect(attr(render(), "boss-pennant", "class")).not.toContain("mt-boss-cue");
        // A pennant drawn with a cue already counted (a window starting, an unfold) has nothing to play: the class
        // follows only the rises it saw.
        globalStore.set(model.cueAtom, 1);
        expect(attr(render(), "boss-pennant", "class")).not.toContain("mt-boss-cue");
    });

    it("leaves the round without a motion of its own: it makes the call gesture with his animated portrait", () => {
        const css = readFileSync(join(__dirname, "boss-bubble.css"), "utf8");
        expect(css).not.toMatch(/\.mt-boss-bubble\.mt-boss-cue/);
        expect(css).not.toContain("mt-boss-nudge");
        globalStore.set(model.cueAtom, 1);
        expect(attr(render(), "boss-bubble", "class")).not.toContain("mt-boss-cue");
    });

    it("has two names for the pennant's wave, so the next rise plays it again without drawing the button anew", () => {
        const css = readFileSync(join(__dirname, "boss-bubble.css"), "utf8");
        expect(css).toMatch(/\.mt-boss-pennant\.mt-boss-cue-a \{[^}]*animation: mt-boss-wave-a/);
        expect(css).toMatch(/\.mt-boss-pennant\.mt-boss-cue-b \{[^}]*animation: mt-boss-wave-b/);
    });

    it("is stilled by reduced motion in the stylesheet, which leaves the badge alone", () => {
        const css = readFileSync(join(__dirname, "boss-bubble.css"), "utf8");
        const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
        expect(reduced).toMatch(/\.mt-boss-pennant\.mt-boss-cue-a[\s\S]*animation: none/);
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
        expect(html).toMatch(/class="mt-boss-initial"[^>]*>B</);
        globalStore.set(model.nameAtom, "léa");
        expect(render()).toMatch(/class="mt-boss-initial"[^>]*>L</);
    });

    it("is a button named like the bubble, with its badge", () => {
        globalStore.set(model.badgeAtom, { count: 4, text: "4", tone: "waiting" });
        const html = render();
        expect(attr(html, "boss-pennant", "aria-label")).toBe("Brokk, 4 waiting");
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

    it("sits beside the bubble, on the side of its corner, beyond the comm screen open with it (#1958)", () => {
        globalStore.set(model.cardOpenAtom, true);
        const html = render();
        expect(attr(html, "boss-bubble", "aria-expanded")).toBe("true");
        expect(attr(html, "boss-bubble", "data-screen")).toBe("open");
        const style = attr(html, "boss-card", "style");
        // 44 px of round, 156 px more of screen, and the gap of 8 px.
        const beyond = 44 + (ScreenSizePx - 44) + 8;
        expect(style).toContain("right:max(8px, min(16px, calc(100% - 52px)))");
        expect(style).toContain(`bottom:calc(max(8px, min(16px, calc(100% - 52px))) + ${beyond}px)`);
        expect(style).toContain(
            `max-height:calc(100% - calc(max(8px, min(16px, calc(100% - 52px))) + ${beyond}px) - 8px)`
        );
    });

    it("keeps the comm screen open and beside the card from every corner, never under it", () => {
        for (const corner of Corners) {
            globalStore.set(model.stateAtom, { ...DefaultBubbleState, place: { corner, dx: 16, dy: 16 } });
            globalStore.set(model.cardOpenAtom, true);
            const html = render();
            expect(attr(html, "boss-bubble", "data-screen")).toBe("open");
            const side = corner[0] === "t" ? "top" : "bottom";
            expect(attr(html, "boss-card", "style")).toContain(
                `${side}:calc(max(8px, min(16px, calc(100% - 52px))) + 208px)`
            );
        }
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

describe("the portrait (AC1)", () => {
    const jpg = join(__dirname, "portrait", "brokk", "brokk.jpg");

    it("is Brokk's validated still, a JPG of at most 1024 px and under 600 KB", () => {
        const bytes = readFileSync(jpg);
        expect(bytes.length).toBeLessThan(600_000);
        // The JPEG start-of-frame marker holds the pixel size: height, then width, big endian.
        let side = 0;
        for (let i = 2; i + 9 < bytes.length; ) {
            if (bytes[i] !== 0xff) {
                break;
            }
            const marker = bytes[i + 1];
            if (marker >= 0xc0 && marker <= 0xc3) {
                side = Math.max(bytes.readUInt16BE(i + 5), bytes.readUInt16BE(i + 7));
                break;
            }
            i += 2 + bytes.readUInt16BE(i + 2);
        }
        expect(side).toBeGreaterThan(0);
        expect(side).toBeLessThanOrEqual(1024);
    });

    it("is framed on his head in one place, which the bubble's round and the card's face both use", () => {
        const framing = css("boss-portrait.css");
        expect(framing).toMatch(/--mt-boss-head-scale: [\d.]+;/);
        expect(framing).toMatch(/--mt-boss-head-origin: \d+% \d+%;/);
        // The numbers appear nowhere else.
        for (const file of ["boss-bubble.css", "boss-screen.css"]) {
            expect(css(file)).not.toMatch(/--mt-boss-head-/);
        }
        expect(readFileSync(join(__dirname, "boss-card.tsx"), "utf8")).toContain('from "./boss-portrait"');
    });

    it("shows the whole face: the goggles to the top of the beard, the eyes well clear of the round's edge", () => {
        const framing = css("boss-portrait.css");
        const scale = Number(/--mt-boss-head-scale: ([\d.]+);/.exec(framing)[1]);
        const origin = Number(/--mt-boss-head-origin: \d+% (\d+)%;/.exec(framing)[1]);
        // Where the features sit on brokk.jpg, in % of its height, measured on the file.
        const Goggles = 12;
        const Eyes = 27;
        const TopOfBeard = 45;
        // The window the round shows: the origin keeps its place and the scale takes everything else in.
        const top = origin * (1 - 1 / scale);
        const span = 100 / scale;
        expect(scale).toBeGreaterThanOrEqual(2.2);
        expect(scale).toBeLessThanOrEqual(2.4);
        expect(top).toBeLessThanOrEqual(Goggles - 2);
        expect(top + span).toBeGreaterThanOrEqual(TopOfBeard + 5);
        // The eyes lie on the upper half of the round, where a circle is nearly as wide as the round.
        const eyes = (Eyes - top) / span;
        expect(eyes).toBeGreaterThan(0.25);
        expect(eyes).toBeLessThan(0.5);
        expect(2 * Math.sqrt(0.25 - (eyes - 0.5) ** 2)).toBeGreaterThan(0.95);
    });

    it("is a still image at rest: no video, no animation, no screen layer", () => {
        const html = render();
        expect(html).not.toContain("<video");
        expect(html).not.toContain('data-testid="boss-screen"');
        expect(css("boss-portrait.css")).not.toMatch(/animation|transition/);
    });
});

describe("the comm screen (AC12)", () => {
    const open = () => globalStore.set(model.screenHoldAtom, holdAfter(NoScreenHold, "pointer-enter"));
    const shape = (html: string) =>
        /data-testid="boss-shape"[^>]*>([\s\S]*?)<span class="mt-boss-zone"/.exec(html)?.[1] ?? "";

    it("is the round at rest: 44 px, no screen, and a zone that takes no pointer", () => {
        const html = render();
        expect(attr(html, "boss-bubble", "data-screen")).toBe("rest");
        expect(html).not.toContain('data-testid="boss-screen"');
        expect(html).not.toContain("Online");
        const sheet = css();
        expect(sheet).toMatch(/\.mt-boss-bubble \{[^}]*--mt-boss-round: 44px;/);
        expect(sheet).toMatch(/\.mt-boss-bubble \{[^}]*width: var\(--mt-boss-round\);/);
        expect(sheet).toMatch(/\.mt-boss-shape,\s*\.mt-boss-zone \{[^}]*pointer-events: none;/);
    });

    it("opens on hover: the screen, its marks, his name from the setting and the status line", () => {
        globalStore.set(model.nameAtom, "Léa");
        globalStore.set(model.badgeAtom, { count: 2, text: "2", tone: "waiting" });
        open();
        const html = render();
        expect(attr(html, "boss-bubble", "data-screen")).toBe("open");
        const screen = html.slice(html.indexOf('data-testid="boss-screen"'));
        expect(screen).toContain("Online");
        expect(screen).toMatch(/mt-boss-caption-text">Léa</);
        expect(screen).toContain("2 things to handle");
        for (const layer of ["mt-boss-tint", "mt-boss-scan", "mt-boss-sweep", "mt-boss-vignette", "mt-boss-live"]) {
            expect(screen).toContain(layer);
        }
        expect(screen.match(/mt-boss-corner/g)).toHaveLength(4);
        expect(screen).not.toContain("df-domino-loader");
    });

    it("says who works while he thinks, never that nothing waits alone, and shows the domino (#1958)", () => {
        open();
        globalStore.set(model.workingCountAtom, 1);
        globalStore.set(model.peekAtom, {
            waiting: [],
            waitingMore: 0,
            working: [{ workspace: "Forge", names: ["Arthur"], more: 0 }],
            workingMore: 0,
            usage: "",
            latest: null,
        });
        let screen = render().slice(render().indexOf('data-testid="boss-screen"'));
        expect(screen).toContain("Arthur is working");
        expect(screen).toContain("Nothing for you");
        expect(screen).not.toContain("Nothing to handle");
        expect(screen).toContain("df-domino-loader");
        globalStore.set(model.workingCountAtom, 3);
        screen = render().slice(render().indexOf('data-testid="boss-screen"'));
        expect(screen).toContain("3 agents at work");
        globalStore.set(model.badgeAtom, { count: 2, text: "2", tone: "waiting" });
        screen = render().slice(render().indexOf('data-testid="boss-screen"'));
        expect(screen).toContain("2 things to handle");
        expect(screen).toContain("3 agents at work");
    });

    it("says one thing in the singular, and that nothing waits when nothing does", () => {
        open();
        expect(render()).toContain("Nothing to handle");
        globalStore.set(model.badgeAtom, { count: 1, text: "1", tone: "waiting" });
        expect(render()).toContain("1 thing to handle");
    });

    it('keeps the name and the status line to the left, under the "Online" mark, and clear of the viewfinder corners', () => {
        const sheet = css("boss-screen.css");
        const rule = (selector: string) =>
            new RegExp(`^${selector.replace(/\./g, "\\.")} \\{([^}]*)\\}`, "m").exec(sheet)?.[1] ?? "";
        const px = (text: string, prop: string) => Number(new RegExp(`${prop}: (\\d+)px`).exec(text)?.[1]);
        const corner = rule(".mt-boss-corner");
        const caption = rule(".mt-boss-caption");
        // The button centres its text by default: the caption says left itself.
        expect(caption).toMatch(/text-align: left;/);
        expect(caption).toMatch(/align-items: flex-start;/);
        // A corner is its size and its offset from the edges, at the top left of the screen as at the bottom left.
        const reach = px(corner, "width") + px(sheet.match(/\.mt-boss-corner\[data-at="bl"\] \{[^}]*\}/)![0], "left");
        const padding = /padding: (\d+)px (\d+)px (\d+)px;/.exec(caption)!.slice(1).map(Number);
        const [, side, bottom] = padding;
        // The text starts and ends past the corners, and rests above the bottom ones.
        expect(side).toBeGreaterThan(reach);
        expect(bottom).toBeGreaterThan(reach);
        // The name, the status and the "Online" mark share one left edge.
        expect(px(rule(".mt-boss-live"), "left")).toBe(side);
    });

    it("opens on keyboard focus as well, and stays for the focus when the pointer leaves", () => {
        globalStore.set(model.screenHoldAtom, holdAfter(NoScreenHold, "focus"));
        expect(attr(render(), "boss-bubble", "data-screen")).toBe("open");
        let hold = holdAfter(holdAfter(NoScreenHold, "pointer-enter"), "focus");
        hold = holdAfter(hold, "pointer-leave");
        globalStore.set(model.screenHoldAtom, hold);
        expect(attr(render(), "boss-bubble", "data-screen")).toBe("open");
    });

    it("is the round again at once when the pointer leaves, or the focus goes", () => {
        globalStore.set(model.screenHoldAtom, holdAfter(holdAfter(NoScreenHold, "pointer-enter"), "pointer-leave"));
        expect(attr(render(), "boss-bubble", "data-screen")).toBe("rest");
        globalStore.set(model.screenHoldAtom, holdAfter(holdAfter(NoScreenHold, "focus"), "blur"));
        expect(attr(render(), "boss-bubble", "data-screen")).toBe("rest");
        // Closing has no transition and no delay in the stylesheet: only the open state declares one.
        const sheet = css();
        expect(sheet).toMatch(/\[data-screen="open"\] > \.mt-boss-shape \{[^}]*transition:/);
        expect(sheet).not.toMatch(/^\.mt-boss-shape \{[^}]*transition:/m);
        expect(sheet).not.toMatch(/^\.mt-boss-face \{[^}]*transition:/m);
        expect(sheet).not.toMatch(/transition[^;}]*\bdelay\b/);
    });

    it("stays the round while the bubble is dragged, opens with the card, and Escape hides it", () => {
        open();
        globalStore.set(model.dragAtom, { left: 10, top: 10, width: 44, height: 44 });
        expect(attr(render(), "boss-bubble", "data-screen")).toBe("rest");
        globalStore.set(model.dragAtom, null);
        globalStore.set(model.screenHoldAtom, NoScreenHold);
        globalStore.set(model.cardOpenAtom, true);
        expect(attr(render(), "boss-bubble", "data-screen")).toBe("open");
        globalStore.set(model.cardOpenAtom, false);
        expect(attr(render(), "boss-bubble", "data-screen")).toBe("rest");
        globalStore.set(model.screenHoldAtom, holdAfter(holdAfter(NoScreenHold, "pointer-enter"), "dismiss"));
        expect(attr(render(), "boss-bubble", "data-screen")).toBe("rest");
    });

    it("grows toward the inside of the window from every corner", () => {
        const sheet = css();
        const expected: Record<string, string> = { tl: "tl", tr: "tr", bl: "bl", br: "br" };
        for (const corner of Corners) {
            globalStore.set(model.stateAtom, { ...DefaultBubbleState, place: { corner, dx: 16, dy: 16 } });
            expect(attr(render(), "boss-bubble", "data-corner")).toBe(expected[corner]);
        }
        // The shape and the zone keep the edges of the corner's side: top or bottom, left or right.
        expect(sheet).toMatch(/\[data-corner\^="t"\] > :is\(\.mt-boss-shape, \.mt-boss-zone\) \{\s*top: 0;/);
        expect(sheet).toMatch(/\[data-corner\^="b"\] > :is\(\.mt-boss-shape, \.mt-boss-zone\) \{\s*bottom: 0;/);
        expect(sheet).toMatch(/\[data-corner\$="l"\] > :is\(\.mt-boss-shape, \.mt-boss-zone\) \{\s*left: 0;/);
        expect(sheet).toMatch(/\[data-corner\$="r"\] > :is\(\.mt-boss-shape, \.mt-boss-zone\) \{\s*right: 0;/);
    });

    it("is a square of about 200 px with near-square corners, in the ember of the action", () => {
        const sheet = css();
        expect(sheet).toMatch(new RegExp(`--mt-boss-screen: ${ScreenSizePx}px;`));
        expect(sheet).toMatch(/\[data-screen="open"\] > \.mt-boss-shape \{[^}]*width: var\(--mt-boss-screen\);/);
        expect(sheet).toMatch(
            /\[data-screen="open"\] > \.mt-boss-shape \{[^}]*border-radius: var\(--mt-radius-control\);/
        );
        const screen = css("boss-screen.css");
        expect(screen).toMatch(/--mt-boss-ember: var\(--mt-action-hover\);/);
        expect(screen).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    });

    it("takes the pointer through a zone of its final size, not through the shape that grows", () => {
        const sheet = css();
        // The screen's side plus the margin on both sides, with the negative margin that puts it back on the screen.
        expect(sheet).toMatch(new RegExp(`--mt-boss-slop: ${ScreenSlopPx}px;`));
        expect(sheet).toMatch(
            /\.mt-boss-zone \{[^}]*width: calc\(var\(--mt-boss-screen\) \+ 2 \* var\(--mt-boss-slop\)\);/
        );
        expect(sheet).toMatch(
            /\.mt-boss-zone \{[^}]*height: calc\(var\(--mt-boss-screen\) \+ 2 \* var\(--mt-boss-slop\)\);/
        );
        expect(sheet).toMatch(/\.mt-boss-zone \{[^}]*margin: calc\(-1 \* var\(--mt-boss-slop\)\);/);
        // No animation and no transition on the zone: its size never changes under the pointer.
        expect(sheet).not.toMatch(/^[^{}\n]*\.mt-boss-zone[^{}]*\{[^}]*(?:transition|animation)/m);
        expect(sheet).toMatch(/\[data-screen="open"\] > \.mt-boss-zone \{\s*pointer-events: auto;/);
        // Nothing opens or sizes anything from :hover: the open state is the data-screen attribute.
        for (const file of ["boss-bubble.css", "boss-screen.css", "boss-portrait.css"]) {
            const rules = css(file).replace(/\/\*[\s\S]*?\*\//g, "");
            for (const rule of rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
                if (/:hover/.test(rule[1])) {
                    expect(rule[2]).not.toMatch(/(?:^|[;\s])(?:width|height|transform|transition)\s*:/);
                }
            }
        }
        expect(css("boss-bubble.css")).not.toMatch(/\.mt-boss-(?:shape|zone)[^{]*:hover/);
        const html = render();
        expect(html).toMatch(
            /<span class="mt-boss-zone" data-testid="boss-zone" aria-hidden="true"><\/span><\/button>/
        );
    });

    it("carries the badge on the shape's top right, so that it follows the edge as the round becomes the screen", () => {
        globalStore.set(model.badgeAtom, { count: 2, text: "2", tone: "waiting" });
        for (const corner of Corners) {
            globalStore.set(model.stateAtom, { ...DefaultBubbleState, place: { corner, dx: 16, dy: 16 } });
            for (const hold of [NoScreenHold, holdAfter(NoScreenHold, "pointer-enter")]) {
                globalStore.set(model.screenHoldAtom, hold);
                const inside = shape(render());
                // The badge is in the shape, after the face that clips, so the face never hides it.
                expect(inside.indexOf('class="mt-boss-face"')).toBeGreaterThanOrEqual(0);
                expect(inside.indexOf('data-testid="boss-badge"')).toBeGreaterThan(inside.indexOf("mt-boss-face"));
                expect(inside.lastIndexOf('class="mt-boss-face"')).toBeLessThan(
                    inside.indexOf('data-testid="boss-badge"')
                );
            }
        }
        const sheet = css();
        expect(sheet).toMatch(/\.mt-boss-badge \{[^}]*position: absolute;[^}]*top: -5px;[^}]*right: -5px;/);
        expect(sheet).toMatch(/\.mt-boss-shape,\s*\.mt-boss-zone \{[^}]*position: absolute;/);
        expect(sheet).toMatch(/\.mt-boss-face \{[^}]*overflow: hidden;/);
    });

    it("lets the peek lie beyond the screen, not under it", () => {
        globalStore.set(model.peekOpenAtom, true);
        const rest = attr(render(), "boss-peek", "style");
        expect(rest).toContain("bottom:calc(max(8px, min(16px, calc(100% - 52px))) + 52px)");
        open();
        const beyond = attr(render(), "boss-peek", "style");
        expect(beyond).toContain(`+ ${ScreenSizePx + 8}px)`);
        expect(beyond).toContain("right:max(8px, min(16px, calc(100% - 52px)))");
    });

    it("is for the eyes only: the bubble's name and description say the same to screen readers", () => {
        open();
        const html = render();
        expect(attr(html, "boss-screen", "aria-hidden")).toBe("true");
        expect(attr(html, "boss-bubble", "aria-label")).toBe("Brokk, 0 waiting");
        expect(attr(html, "boss-bubble", "aria-describedby")).toBeTruthy();
    });
});

describe("the comm screen under reduced motion (AC13)", () => {
    const bubble = css();
    const screen = css("boss-screen.css");
    const media = (sheet: string) =>
        /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}\n/.exec(sheet)?.[1] ?? "";

    it("opens without a transition, for the system's preference and for the app's own setting", () => {
        for (const area of [media(bubble), bubble.slice(bubble.indexOf("\n.prefers-reduced-motion .mt-boss-face"))]) {
            expect(area).toMatch(/\[data-screen="open"\] > \.mt-boss-shape,/);
            expect(area).toMatch(/\[data-screen="open"\] > \.mt-boss-shape > \.mt-boss-face/);
            expect(area).toMatch(/\[data-screen="open"\] \.mt-boss-portrait/);
            expect(area).toMatch(/transition: none;/);
        }
    });

    it("breathes, sweeps and blinks no more, and the sweep is not left standing", () => {
        for (const area of [media(screen), screen.slice(screen.indexOf("\n.prefers-reduced-motion "))]) {
            expect(area).toMatch(/\.mt-boss-portrait-image/);
            expect(area).toMatch(/\.mt-boss-sweep/);
            expect(area).toMatch(/\.mt-boss-live > i/);
            expect(area).toMatch(/\.mt-boss-fx/);
            expect(area).toMatch(/animation: none;/);
            expect(area).toMatch(/\.mt-boss-sweep \{\s*display: none;/);
            // The state mark holds a still frame of the fall.
            expect(area).toMatch(
                /\.df-domino-loader > span \{\s*animation: none;\s*transform: rotate\(var\(--df-domino-still/
            );
        }
    });

    it("has its three loops only inside the screen's own stylesheet, and no loop on the round at rest", () => {
        expect(screen.match(/\binfinite\b/g)).toHaveLength(3);
        expect(css()).not.toMatch(/\binfinite\b/);
        expect(css("boss-portrait.css")).not.toMatch(/\binfinite\b/);
    });
});
