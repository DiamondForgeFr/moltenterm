// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
    AjarPx,
    bounceKeyframes,
    BounceMs,
    edgeAttributes,
    EdgeFacePx,
    edgeFaceShiftPx,
    EdgeFadeMs,
    edgeLineOn,
    edgeMotionFrames,
    edgeMotionOf,
    EdgeNews,
    edgeNewsAfter,
    EdgePx,
    EdgeShape,
    edgeShapeOf,
    EdgeSlideMs,
    edgeUnfoldsOn,
    newsToTell,
    NoNews,
    playEdgeMotion,
    sidebarPlaceOf,
} from "./brokk-edge-model";

// A stylesheet without its comments, which explain the rules in words the patterns below would catch.
function css(file: string): string {
    return readFileSync(join(__dirname, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

function rule(sheet: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(sheet)?.[1] ?? "";
}

describe("where the sidebar stands for him (FR-BOSS-009, AC14, AC27, #2070)", () => {
    it("is on screen when docked or unfolded over the content, whatever Brokk's setting", () => {
        expect(sidebarPlaceOf(true, false, false, true)).toBe("screen");
        expect(sidebarPlaceOf(true, true, true, true)).toBe("screen");
        expect(sidebarPlaceOf(true, false, false, false)).toBe("screen");
    });

    it("is the edge when it is collapsed and his face is on: he never goes to the window's top right", () => {
        expect(sidebarPlaceOf(true, true, false, true)).toBe("edge");
    });

    it("is nowhere with the sidebar turned off, or collapsed with Brokk turned off", () => {
        expect(sidebarPlaceOf(false, false, false, true)).toBe("none");
        expect(sidebarPlaceOf(false, true, false, true)).toBe("none");
        expect(sidebarPlaceOf(true, true, false, false)).toBe("none");
    });
});

describe("how far the collapsed sidebar comes out (AC44 to AC46, #2093)", () => {
    it("is out of sight at rest, when nothing waits and nothing is being told", () => {
        expect(edgeShapeOf("edge", { visit: false, cue: false })).toBe("rest");
        expect(edgeShapeOf("edge", { visit: false, cue: false, telling: false })).toBe("rest");
    });

    it("peeks out by its strip only while it tells a new notification", () => {
        expect(edgeShapeOf("edge", { visit: false, cue: false, telling: true })).toBe("peek");
    });

    it("stays half open while a visit is due, or held back for a menu, a dialog or his group, news or not", () => {
        expect(edgeShapeOf("edge", { visit: true, cue: false })).toBe("ajar");
        expect(edgeShapeOf("edge", { visit: false, cue: true })).toBe("ajar");
        expect(edgeShapeOf("edge", { visit: true, cue: false, telling: true })).toBe("ajar");
    });

    it("is not a shape of a sidebar that is on screen or absent", () => {
        expect(edgeShapeOf("screen", { visit: true, cue: true, telling: true })).toBeNull();
        expect(edgeShapeOf("none", { visit: true, cue: true, telling: true })).toBeNull();
    });

    it("says the event's line on the scene wherever Brokk shows, a docked sidebar included (#2155)", () => {
        expect(edgeLineOn(true)).toBe(true);
        expect(edgeLineOn(false)).toBe(false);
    });
});

describe("the news (AC28)", () => {
    const read = (news: EdgeNews, keys: string[], looking = false, ready = true) =>
        edgeNewsAfter(news, keys, keys, looking, ready);

    // The feeds read once, with what was there when the window opened.
    const baseline = (keys: string[]) => read(NoNews, keys).news;

    it("bounces once for a new notification, and not again for the same one", () => {
        const first = read(baseline([]), ["agent:a"]);
        expect(first.fresh).toBe(true);
        const again = read(first.news, ["agent:a"]);
        expect(again.fresh).toBe(false);
    });

    it("bounces once more for a second notification, only for that one", () => {
        const first = read(baseline([]), ["agent:a"]);
        const second = read(first.news, ["agent:a", "agent:b"]);
        expect(second.fresh).toBe(true);
        expect(read(second.news, ["agent:a", "agent:b"]).fresh).toBe(false);
    });

    it("does not bounce for what was there when the window opened", () => {
        const step = read(NoNews, ["agent:a", "download:x"]);
        expect(step.fresh).toBe(false);
        expect(step.unseen).toBe(false);
        expect(read(step.news, ["agent:a", "download:x"]).fresh).toBe(false);
    });

    it("does not bounce before the feeds have been read, and takes the first reading as the baseline", () => {
        const early = read(NoNews, ["agent:a"], false, false);
        expect(early.fresh).toBe(false);
        expect(read(early.news, ["agent:a"], false, true).fresh).toBe(false);
        expect(read(early.news, ["agent:a", "agent:b"], false, true).fresh).toBe(false);
    });

    it("does not bounce for one already seen: the sidebar was unfolded or his group open while it was there", () => {
        const first = read(baseline([]), ["agent:a"]);
        const looked = read(first.news, ["agent:a"], true);
        expect(looked.unseen).toBe(false);
        expect(read(looked.news, ["agent:a"]).fresh).toBe(false);
        expect(read(looked.news, ["agent:a"]).unseen).toBe(false);
    });

    it("sees what arrives while the developer looks, and bounces for nothing then", () => {
        const step = read(baseline([]), ["agent:a"], true);
        expect(step.fresh).toBe(false);
        expect(step.unseen).toBe(false);
        expect(read(step.news, ["agent:a"]).fresh).toBe(false);
    });

    it("keeps an unseen notification unseen after its bounce, for the outline under reduced motion", () => {
        const first = read(baseline([]), ["agent:a"]);
        expect(first.unseen).toBe(true);
        expect(read(first.news, ["agent:a"]).unseen).toBe(true);
        expect(read(first.news, ["agent:a"], true).unseen).toBe(false);
    });

    it("takes a notification that was handled and comes back as a new one", () => {
        const first = read(baseline([]), ["agent:a"]);
        const handled = read(first.news, []);
        expect(handled.fresh).toBe(false);
        expect(handled.unseen).toBe(false);
        const back = read(handled.news, ["agent:a"]);
        expect(back.fresh).toBe(true);
    });

    it("never moves for an event set to Badge: it only counts, and still marks the face unseen (#2155)", () => {
        const before = baseline([]);
        const badgeOnly = edgeNewsAfter(before, ["ci:/p:1"], [], false, true);
        expect(badgeOnly.fresh).toBe(false);
        expect(badgeOnly.unseen).toBe(true);
        const comes = edgeNewsAfter(badgeOnly.news, ["agent:a", "ci:/p:1"], ["agent:a"], false, true);
        expect(comes.fresh).toBe(true);
        // A Badge event already counted never bounces later on.
        expect(edgeNewsAfter(comes.news, ["agent:a", "ci:/p:1"], ["agent:a"], false, true).fresh).toBe(false);
    });

    it("bounces for a new notification even when another one went in the same reading", () => {
        const first = read(baseline([]), ["agent:a"]);
        expect(read(first.news, ["agent:b"]).fresh).toBe(true);
    });
});

describe("a new notification is told once, to the sidebar that waits at the edge (AC45)", () => {
    it("tells when a new bounce was counted, and not again for the same one", () => {
        const first = newsToTell(1, 0, "edge");
        expect(first).toEqual({ played: 1, tell: true });
        expect(newsToTell(1, first.played, "edge").tell).toBe(false);
        expect(newsToTell(2, first.played, "edge").tell).toBe(true);
    });

    it("does not tell a sidebar that is on screen or absent, and does not keep it for later", () => {
        expect(newsToTell(1, 0, "screen")).toEqual({ played: 1, tell: false });
        expect(newsToTell(1, 0, "none")).toEqual({ played: 1, tell: false });
    });
});

// The shapes the collapsed sidebar goes through, and what it plays on each change, as use-brokk-edge.ts drives them.
function walk(steps: { shape: EdgeShape; tell?: boolean }[], reduced = false) {
    let before: EdgeShape = null;
    return steps.map((step) => {
        const motion = edgeMotionOf(before, step.shape, step.tell === true, reduced);
        before = step.shape;
        return motion;
    });
}

describe("the motion as it comes out (AC45 to AC47, #2093)", () => {
    it("bounces once for a notification, then ends fully hidden, playing nothing on the way back", () => {
        const telling = edgeShapeOf("edge", { visit: false, cue: false, telling: true });
        const told = edgeShapeOf("edge", { visit: false, cue: false, telling: false });
        expect([telling, told]).toEqual(["peek", "rest"]);
        expect(walk([{ shape: "rest" }, { shape: telling, tell: true }, { shape: told }])).toEqual([
            null,
            "bounce",
            null,
        ]);
    });

    it("bounces as it comes out for something important, and stays half open", () => {
        expect(walk([{ shape: "rest" }, { shape: "ajar" }, { shape: "ajar" }])).toEqual([null, "bounce", null]);
        expect(walk([{ shape: "rest" }, { shape: "peek", tell: true }, { shape: "ajar" }])).toEqual([
            null,
            "bounce",
            "bounce",
        ]);
    });

    it("bounces again for a new notification while it is half open", () => {
        expect(walk([{ shape: "rest" }, { shape: "ajar" }, { shape: "ajar", tell: true }])).toEqual([
            null,
            "bounce",
            "bounce",
        ]);
    });

    it("plays nothing as it folds back to half open after a hover, or after being docked", () => {
        expect(walk([{ shape: "ajar" }, { shape: null }, { shape: "ajar" }])).toEqual([null, null, null]);
    });

    it("plays nothing as it closes, once the item is handled or put off", () => {
        expect(walk([{ shape: "rest" }, { shape: "ajar" }, { shape: "rest" }])).toEqual([null, "bounce", null]);
    });

    it("has no bounce under reduced motion: the peek fades in and out, the half-open state fades in", () => {
        expect(walk([{ shape: "rest" }, { shape: "peek", tell: true }, { shape: "rest" }], true)).toEqual([
            null,
            "peek-fade",
            null,
        ]);
        expect(walk([{ shape: "rest" }, { shape: "ajar" }], true)).toEqual([null, "fade-in"]);
        expect(walk([{ shape: "rest" }, { shape: "ajar" }, { shape: "ajar", tell: true }], true)).toEqual([
            null,
            "fade-in",
            null,
        ]);
    });
});

describe("the bounce and the fades (AC45, AC46)", () => {
    it("moves out and back twice, the second smaller, and ends where it began", () => {
        const frames = bounceKeyframes();
        const xs = frames.map((frame) => Number(/translateX\((-?\d+)px\)/.exec(frame.transform)[1]));
        expect(xs.filter((x, i) => x > 0 && xs[i - 1] === 0 && xs[i + 1] === 0)).toHaveLength(2);
        expect(Math.max(...xs.slice(0, 3))).toBeGreaterThan(Math.max(...xs.slice(3)));
        expect(xs[0]).toBe(0);
        expect(xs[xs.length - 1]).toBe(0);
        const offsets = frames.map((frame) => frame.offset);
        expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    });

    it("is laid over the sidebar's own transform once it has slid out, not instead of it", () => {
        const animate = vi.fn(() => ({ cancel: vi.fn() }));
        const played = playEdgeMotion({ animate }, "bounce");
        expect(played).not.toBeNull();
        expect(animate).toHaveBeenCalledTimes(1);
        expect(animate).toHaveBeenCalledWith(
            bounceKeyframes(),
            expect.objectContaining({ duration: BounceMs, delay: EdgeSlideMs, composite: "add" })
        );
    });

    it("fades the peek in and out without moving it, and holds it transparent until it is out of sight", () => {
        const { keyframes, options } = edgeMotionFrames("peek-fade");
        expect(keyframes.map((frame) => frame.opacity)).toEqual([0, 1, 1, 0]);
        expect(keyframes.some((frame) => "transform" in frame)).toBe(false);
        expect(options).toMatchObject({ fill: "forwards" });
        expect(options.composite).toBeUndefined();
    });

    it("fades the half-open state in, in the app's fade time", () => {
        const { keyframes, options } = edgeMotionFrames("fade-in");
        expect(keyframes.map((frame) => frame.opacity)).toEqual([0, 1]);
        expect(options).toMatchObject({ duration: EdgeFadeMs });
    });

    it("reports its end, so that the peek hides again", () => {
        const animation: { cancel: () => void; onfinish?: () => void } = { cancel: vi.fn() };
        const done = vi.fn();
        playEdgeMotion({ animate: () => animation }, "bounce", done);
        expect(done).not.toHaveBeenCalled();
        animation.onfinish();
        expect(done).toHaveBeenCalledTimes(1);
    });

    it("ends at once where the page cannot animate, and plays nothing for no motion", () => {
        const done = vi.fn();
        expect(playEdgeMotion({}, "bounce", done)).toBeNull();
        expect(playEdgeMotion(null, "peek-fade", done)).toBeNull();
        expect(done).toHaveBeenCalledTimes(2);
        const animate = vi.fn();
        expect(playEdgeMotion({ animate }, null, done)).toBeNull();
        expect(animate).not.toHaveBeenCalled();
    });

    it("keeps its timings equal to the tokens it follows", () => {
        const tokens = readFileSync(join(__dirname, "../tokens.css"), "utf8");
        expect(tokens).toContain(`--mt-duration-base: ${EdgeSlideMs}ms;`);
        expect(tokens).toContain(`--mt-duration-fade: ${EdgeFadeMs}ms;`);
    });
});

describe("what the sidebar's element says of the edge (AC44 to AC46)", () => {
    it("says how far it is out, and gives the content no margin of its own", () => {
        expect(edgeAttributes("rest")).toEqual({ "data-edge": "rest" });
        expect(edgeAttributes("peek")).toEqual({ "data-edge": "peek" });
        expect(edgeAttributes("ajar")).toEqual({ "data-edge": "ajar" });
        expect(edgeAttributes(null)).toEqual({ "data-edge": undefined });
    });
});

describe("the edge, in the model and in the style sheets (AC40, AC44 to AC46)", () => {
    const sidebar = css("../sidebar/sidebar.css");
    const avatar = css("brokk-avatar.css");

    it("is 30 px while it peeks, 190 px half open, and the face is 20 px: the sheets say the same numbers", () => {
        expect(sidebar).toMatch(
            new RegExp(
                `\\.mt-sb-frame\\s*\\{[^}]*--mt-edge-px: ${EdgePx}px;[^}]*--mt-ajar-px: ${AjarPx}px;[^}]*--mt-edge-face: ${EdgeFacePx}px;`
            )
        );
        expect([EdgePx, AjarPx, EdgeFacePx]).toEqual([30, 190, 20]);
    });

    it("shows nothing at rest: no strip, no face, no badge, and nothing the pointer or the keyboard reaches", () => {
        const rest = rule(sidebar, '.mt-sb.is-hidden[data-edge="rest"]');
        expect(rest).toContain("visibility: hidden");
        expect(rest).not.toMatch(/transform:\s*translateX/);
        expect(rule(sidebar, ".mt-sb.is-hidden")).toContain("transform: translateX(calc(-100% - 24px))");
    });

    it("hides at rest only once the slide that folds it has ended", () => {
        expect(rule(sidebar, '.mt-sb.is-hidden[data-edge="rest"]')).toMatch(
            /visibility 0s linear var\(--mt-duration-base\)/
        );
    });

    it("gives the content no strip's margin: the content keeps its whole width", () => {
        expect(sidebar).not.toMatch(/data-gutter/);
        expect(sidebar).not.toMatch(/\.mt-frame-content\s*\{[^}]*margin-left:\s*var\(--mt-edge-px\)/);
    });

    it("moves the sidebar out of the window by all but its strip while it peeks, and by all but its half", () => {
        const peek = rule(sidebar, '.mt-sb.is-hidden[data-edge="peek"]');
        const ajar = rule(sidebar, '.mt-sb.is-hidden[data-edge="ajar"]');
        expect(peek).toContain("translateX(calc(-100% + var(--mt-edge-px) - var(--mt-frame-gap)))");
        expect(ajar).toContain("translateX(calc(-100% + var(--mt-ajar-px) - var(--mt-frame-gap)))");
    });

    it("hides all of the sidebar but his face and his banner while it is out, out of the keyboard's way", () => {
        const hidden = rule(
            sidebar,
            ".mt-sb[data-edge] > :not(.mt-sb-window-row, .mt-brokk-scene-layer),\n.mt-sb[data-edge] .mt-sb-window-row > :not(.mt-brokk-avatar, .mt-act)"
        );
        expect(hidden).toContain("visibility: hidden");
    });

    it("keeps the activity indicator (FR-BOSS-009 AC85) with his face in the row, hidden with nothing but the sidebar", () => {
        expect(sidebar).toContain(".mt-sb[data-edge] .mt-sb-window-row > :not(.mt-brokk-avatar, .mt-act)");
        expect(sidebar).toContain('.mt-sb.is-hidden[data-edge="rest"]');
    });

    it("puts the face in the middle of the strip: the title row's right end, moved by the model's shift", () => {
        const face = rule(avatar, ".mt-brokk-avatar.is-edge");
        expect(face).toContain("--mt-brokk-size: var(--mt-edge-face, 20px)");
        expect(face).toContain(
            "translateX(calc(var(--mt-peek-inset, 12px) - (var(--mt-edge-px, 30px) - var(--mt-edge-face, 20px)) / 2))"
        );
        expect(edgeFaceShiftPx(12)).toBe(7);
    });

    it("lets the face grow back and slide to its place while the sidebar unfolds", () => {
        const base = rule(avatar, ".mt-brokk-avatar");
        expect(base).toMatch(/transition:[^;]*width[^;]*height[^;]*transform/);
    });

    it("hangs the badge under the face, inside the strip, and lets it move to the corner as the sidebar unfolds", () => {
        const badge = rule(avatar, ".mt-brokk-avatar.is-edge .mt-brokk-badge");
        expect(badge).toContain("top: calc(100% + 3px)");
        expect(badge).toContain("right: 50%");
        expect(badge).toContain("translateX(50%)");
        expect(rule(avatar, ".mt-brokk-badge")).toMatch(/transition:[^;]*top[^;]*right[^;]*transform/);
    });

    it("outlines the face in the action colour for an unseen notification", () => {
        expect(rule(avatar, '.mt-brokk-avatar[data-news="true"]')).toContain("var(--mt-action)");
    });
});

describe("hover and click (AC30, AC47)", () => {
    it("unfolds the sidebar over the visible edge, but not over his face, which stays under the pointer for the click", () => {
        expect(edgeUnfoldsOn("edge", false)).toBe(true);
        expect(edgeUnfoldsOn("edge", true)).toBe(false);
    });

    it("does nothing for a sidebar that is already on screen or absent", () => {
        expect(edgeUnfoldsOn("screen", false)).toBe(false);
        expect(edgeUnfoldsOn("none", false)).toBe(false);
    });

    it("is on screen while unfolded from half open, and half open again once the pointer leaves", () => {
        const view = { visit: true, cue: false };
        expect(edgeShapeOf(sidebarPlaceOf(true, true, false, true), view)).toBe("ajar");
        expect(sidebarPlaceOf(true, true, true, true)).toBe("screen");
        expect(edgeShapeOf(sidebarPlaceOf(true, true, true, true), view)).toBeNull();
        expect(edgeShapeOf(sidebarPlaceOf(true, true, false, true), view)).toBe("ajar");
    });
});
