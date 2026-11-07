// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
    AjarPx,
    BounceMs,
    bounceKeyframes,
    bounceOnNews,
    edgeAttributes,
    EdgeFacePx,
    edgeFaceShiftPx,
    edgeGutterOn,
    EdgeNews,
    edgeNewsAfter,
    EdgePx,
    edgeShapeOf,
    edgeUnfoldsOn,
    NoNews,
    playBounce,
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

describe("how open the collapsed sidebar stays (AC29)", () => {
    it("rests on its strip when nothing waits", () => {
        expect(edgeShapeOf("edge", { visit: false, cue: false })).toBe("rest");
    });

    it("stays half open while a visit is due, or held back for a menu, a dialog or his group", () => {
        expect(edgeShapeOf("edge", { visit: true, cue: false })).toBe("ajar");
        expect(edgeShapeOf("edge", { visit: false, cue: true })).toBe("ajar");
    });

    it("is not a shape of a sidebar that is on screen or absent", () => {
        expect(edgeShapeOf("screen", { visit: true, cue: true })).toBeNull();
        expect(edgeShapeOf("none", { visit: true, cue: true })).toBeNull();
    });

    it("leaves the strip's room to the content while collapsed with Brokk on, unfolded or not", () => {
        expect(edgeGutterOn(true, true)).toBe(true);
        expect(edgeGutterOn(true, false)).toBe(false);
        expect(edgeGutterOn(false, true)).toBe(false);
    });
});

describe("hover and click (AC30)", () => {
    it("unfolds the sidebar over the strip, but not over his face, which stays under the pointer for the click", () => {
        expect(edgeUnfoldsOn("edge", false)).toBe(true);
        expect(edgeUnfoldsOn("edge", true)).toBe(false);
    });

    it("does nothing for a sidebar that is already on screen or absent", () => {
        expect(edgeUnfoldsOn("screen", false)).toBe(false);
        expect(edgeUnfoldsOn("none", false)).toBe(false);
    });
});

describe("the news (AC28)", () => {
    const read = (news: EdgeNews, keys: string[], looking = false, ready = true) =>
        edgeNewsAfter(news, keys, looking, ready);

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

    it("bounces for a new notification even when another one went in the same reading", () => {
        const first = read(baseline([]), ["agent:a"]);
        expect(read(first.news, ["agent:b"]).fresh).toBe(true);
    });
});

describe("the bounce (AC28)", () => {
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

    it("is laid over the sidebar's own transform, not instead of it", () => {
        const animate = vi.fn(() => ({ cancel: vi.fn() }));
        const bounce = playBounce({ animate }, false);
        expect(bounce).not.toBeNull();
        expect(animate).toHaveBeenCalledTimes(1);
        expect(animate).toHaveBeenCalledWith(bounceKeyframes(), expect.objectContaining({ duration: BounceMs, composite: "add" }));
    });

    it("plays nothing under reduced motion: the badge and the face's outline say it", () => {
        const animate = vi.fn();
        expect(playBounce({ animate }, true)).toBeNull();
        expect(animate).not.toHaveBeenCalled();
    });

    it("plays nothing where the page cannot animate", () => {
        expect(playBounce({}, false)).toBeNull();
        expect(playBounce(null, false)).toBeNull();
    });
});

describe("the bounce, told once to the sidebar that waits (AC28)", () => {
    const sidebar = (edge: string = "rest") => ({
        dataset: { edge },
        animate: vi.fn(() => ({ cancel: vi.fn() })),
    });

    it("plays when a new bounce was told, and not again for the same one", () => {
        const element = sidebar();
        const first = bounceOnNews(1, 0, element, false);
        expect(first.bounce).not.toBeNull();
        expect(first.played).toBe(1);
        expect(bounceOnNews(1, first.played, element, false).bounce).toBeNull();
        expect(element.animate).toHaveBeenCalledTimes(1);
        expect(bounceOnNews(2, first.played, element, false).bounce).not.toBeNull();
        expect(element.animate).toHaveBeenCalledTimes(2);
    });

    it("plays on a sidebar that is already half open for something important too", () => {
        expect(bounceOnNews(1, 0, sidebar("ajar"), false).bounce).not.toBeNull();
    });

    it("does not play on a sidebar that was unfolded meanwhile, and does not keep it for later", () => {
        const unfolded = { animate: vi.fn(() => ({ cancel: vi.fn() })), dataset: {} };
        const step = bounceOnNews(1, 0, unfolded, false);
        expect(step.bounce).toBeNull();
        expect(step.played).toBe(1);
        expect(unfolded.animate).not.toHaveBeenCalled();
    });

    it("does not play under reduced motion", () => {
        const element = sidebar();
        const step = bounceOnNews(1, 0, element, true);
        expect(step.bounce).toBeNull();
        expect(element.animate).not.toHaveBeenCalled();
    });
});

describe("what the sidebar's element says of the edge (AC27, AC29)", () => {
    it("says how open it stays, and leaves the strip's room while it is collapsed with Brokk on", () => {
        expect(edgeAttributes("rest", true, true)).toEqual({ "data-edge": "rest", "data-gutter": "true" });
        expect(edgeAttributes("ajar", true, true)).toEqual({ "data-edge": "ajar", "data-gutter": "true" });
    });

    it("keeps the strip's room while it is unfolded over the content, so that the panels do not move", () => {
        expect(edgeAttributes(null, true, true)).toEqual({ "data-edge": undefined, "data-gutter": "true" });
    });

    it("says nothing when it is docked, or when Brokk is off", () => {
        expect(edgeAttributes(null, false, true)).toEqual({ "data-edge": undefined, "data-gutter": undefined });
        expect(edgeAttributes(null, true, false)).toEqual({ "data-edge": undefined, "data-gutter": undefined });
    });
});

describe("the strip, in the model and in the style sheets (AC27, AC29)", () => {
    const sidebar = css("../sidebar/sidebar.css");
    const avatar = css("brokk-avatar.css");

    it("is 30 px at rest, 190 px half open, and the face is 20 px: the sheets say the same numbers", () => {
        expect(sidebar).toMatch(
            new RegExp(
                `\\.mt-sb-frame\\s*\\{[^}]*--mt-edge-px: ${EdgePx}px;[^}]*--mt-ajar-px: ${AjarPx}px;[^}]*--mt-edge-face: ${EdgeFacePx}px;`
            )
        );
        expect([EdgePx, AjarPx, EdgeFacePx]).toEqual([30, 190, 20]);
    });

    it("moves the sidebar out of the window by all but its strip, and by all but its half", () => {
        const rest = rule(sidebar, '.mt-sb.is-hidden[data-edge="rest"]');
        const ajar = rule(sidebar, '.mt-sb.is-hidden[data-edge="ajar"]');
        expect(rest).toContain("translateX(calc(-100% + var(--mt-edge-px) - var(--mt-frame-gap)))");
        expect(ajar).toContain("translateX(calc(-100% + var(--mt-ajar-px) - var(--mt-frame-gap)))");
    });

    it("gives the strip's room to the content, so that no panel is covered", () => {
        expect(rule(sidebar, ".mt-sb.is-hidden[data-gutter] ~ .mt-frame-content")).toContain(
            "margin-left: var(--mt-edge-px)"
        );
    });

    it("hides all of the sidebar but his face and his banner, out of the keyboard's way", () => {
        const hidden = rule(
            sidebar,
            ".mt-sb[data-edge] > :not(.mt-sb-window-row, .mt-brokk-scene-layer),\n.mt-sb[data-edge] .mt-sb-window-row > :not(.mt-brokk-avatar)"
        );
        expect(hidden).toContain("visibility: hidden");
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
