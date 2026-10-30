// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { channelNetwork, channelRoutes, type ChannelElements, type ChannelsHandle } from "./settings-channels";
import {
    crackLines,
    finishSettingsReveal,
    flowTime,
    MaxRevealCards,
    onClock,
    onFrameGrid,
    RevealFrameMs,
    revealMode,
    RevealMs,
    revealPlan,
    revealTotalMs,
    runSettingsReveal,
    settingsRevealRunning,
    shardPolygons,
} from "./settings-reveal";

// A DOM just large enough for the runner: elements that record their animations, a document and an input target.
type FakeAnim = {
    keyframes: Keyframe[];
    timing: KeyframeAnimationOptions;
    cancelled: boolean;
    finished: Promise<void>;
    resolve: () => void;
    reject: (e: unknown) => void;
    cancel: () => void;
};

type FakeEl = {
    className: string;
    children: FakeEl[];
    style: { props: Record<string, string>; setProperty: (k: string, v: string) => void };
    attrs: Record<string, string>;
    anims: FakeAnim[];
    rect: { left: number; top: number; width: number; height: number };
    ownerDocument?: unknown;
    animate: (k: Keyframe[], t: KeyframeAnimationOptions) => FakeAnim;
    appendChild: (c: FakeEl) => FakeEl;
    append: (...c: FakeEl[]) => void;
    replaceChildren: () => void;
    setAttribute: (k: string, v: string) => void;
    getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
};

function makeAnim(keyframes: Keyframe[], timing: KeyframeAnimationOptions): FakeAnim {
    const a = { keyframes, timing, cancelled: false } as FakeAnim;
    a.finished = new Promise<void>((resolve, reject) => {
        a.resolve = resolve;
        a.reject = reject;
    });
    a.finished.catch(() => {});
    a.cancel = () => {
        a.cancelled = true;
        a.reject(new Error("cancelled"));
    };
    return a;
}

function makeEl(rect = { left: 0, top: 0, width: 0, height: 0 }, all: FakeAnim[] = []): FakeEl {
    const el: FakeEl = {
        className: "",
        children: [],
        style: {
            props: {},
            setProperty(k, v) {
                this.props[k] = v;
            },
        },
        attrs: {},
        anims: [],
        rect,
        animate(k, t) {
            const a = makeAnim(k, t);
            el.anims.push(a);
            all.push(a);
            return a;
        },
        appendChild(c) {
            el.children.push(c);
            return c;
        },
        append(...c) {
            el.children.push(...c);
        },
        replaceChildren() {
            el.children = [];
        },
        setAttribute(k, v) {
            el.attrs[k] = v;
        },
        getBoundingClientRect() {
            return el.rect;
        },
    };
    return el;
}

function makeInput() {
    const listeners = new Map<string, Set<(e: Event) => void>>();
    return {
        listeners,
        addEventListener(type: string, fn: (e: Event) => void) {
            if (!listeners.has(type)) {
                listeners.set(type, new Set());
            }
            listeners.get(type).add(fn);
        },
        removeEventListener(type: string, fn: (e: Event) => void) {
            listeners.get(type)?.delete(fn);
        },
        dispatch(type: string, extra: Record<string, unknown> = {}) {
            for (const fn of [...(listeners.get(type) ?? [])]) {
                fn({ type, ...extra } as unknown as Event);
            }
        },
        count() {
            return [...listeners.values()].reduce((n, s) => n + s.size, 0);
        },
    };
}

function makeScene(cardCount: number) {
    const all: FakeAnim[] = [];
    const doc = {
        createElement: () => makeEl(undefined, all),
        createElementNS: () => makeEl(undefined, all),
        createDocumentFragment: () => makeEl(undefined, all),
        defaultView: null as unknown,
    };
    const stage = makeEl({ left: 100, top: 50, width: 900, height: 1200 }, all);
    stage.ownerDocument = doc;
    const overlay = makeEl(undefined, all);
    const rects = Array.from({ length: cardCount }, (_, i) => ({
        x: 32 + (i % 3) * 300,
        y: 200 + Math.floor(i / 3) * 260,
        w: 280,
        h: 240,
    }));
    const cards = rects.map((r) => makeEl({ left: 100 + r.x, top: 50 + r.y, width: r.w, height: r.h }, all));
    const chrome = [makeEl(undefined, all)];
    const input = makeInput();
    const net = channelNetwork(
        channelRoutes({
            chip: { x: 300, y: 4, w: 100, h: 27 },
            page: { x: 0, y: 51, w: 900, h: 1100 },
            cards: rects.slice(0, MaxRevealCards),
        })
    );
    const els = {
        groove: makeEl(undefined, all),
        molten: makeEl(undefined, all),
        ambient: makeEl(undefined, all),
        ambientAnims: [],
    };
    const channels = {
        net: () => net,
        elements: () => els as unknown as ChannelElements,
        dispose: () => {},
    } as ChannelsHandle;
    return { all, stage, overlay, cards, chrome, input, net, els, channels };
}

function run(scene: ReturnType<typeof makeScene>, mode: "molten" | "fade") {
    return runSettingsReveal({
        stage: scene.stage as unknown as HTMLElement,
        overlay: scene.overlay as unknown as HTMLElement,
        cards: scene.cards as unknown as HTMLElement[],
        chrome: scene.chrome as unknown as Element[],
        source: { x: 300, y: 4, w: 100, h: 27 },
        mode,
        channels: mode === "molten" ? scene.channels : null,
        inputTarget: scene.input as unknown as EventTarget,
    });
}

describe("settings reveal timeline (DS-SHELL-138, #1549)", () => {
    it("flows slower as it spreads, with a speed that varies, and reaches the farthest card last", () => {
        for (const reach of [300, 900, 2400]) {
            let prev = flowTime(0, reach);
            expect(prev).toBe(RevealMs.flowStart);
            const speeds: number[] = [];
            for (let d = 10; d <= reach; d += 10) {
                const t = flowTime(d, reach);
                expect(t).toBeGreaterThan(prev);
                speeds.push(10 / (t - prev));
                prev = t;
            }
            expect(flowTime(reach, reach)).toBeCloseTo(RevealMs.arriveMax, 6);
            // slower at the end than at the start
            expect(speeds[speeds.length - 1]).toBeLessThan(speeds[0]);
        }
        // the wobble: the speed does not just decrease
        const s = (d: number) => 1 / (flowTime(d + 1, 2400) - flowTime(d, 2400));
        const ups = Array.from({ length: 200 }, (_, k) => k * 10).filter((d) => s(d + 10) > s(d)).length;
        expect(ups).toBeGreaterThan(0);
    });

    it("ends by 700 ms on the frame grid, the cards in the order of their distance along the channels", () => {
        for (const n of [1, 3, 8, 12]) {
            const lengths = Array.from({ length: n }, (_, i) => 200 + ((i * 7919) % 13) * 150);
            const reach = Math.max(...lengths);
            const plan = revealPlan(lengths, reach);
            expect(plan.total).toBeLessThanOrEqual(RevealMs.total + 0.001);
            expect(plan.total / RevealFrameMs).toBeCloseTo(Math.round(plan.total / RevealFrameMs), 6);
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    if (lengths[i] < lengths[j]) {
                        expect(plan.arrivals[i]).toBeLessThan(plan.arrivals[j]);
                    }
                }
            }
        }
        expect(revealTotalMs([], 0)).toBe(0);
        expect(revealTotalMs([100], 100, "fade")).toBe(onFrameGrid(RevealMs.fade));
    });

    it("holds an element in its keyframes instead of a delay", () => {
        const k = onClock(700, [
            [140, { opacity: 0, easing: "ease-in" }],
            [350, { opacity: 1 }],
        ]);
        expect(k).toEqual([
            { opacity: 0, offset: 0 },
            { opacity: 0, easing: "ease-in", offset: 0.2 },
            { opacity: 1, offset: 0.5 },
            { opacity: 1, offset: 1 },
        ]);
    });

    it("breaks the same card the same way every time, and cards differently", () => {
        expect(shardPolygons(2)).toEqual(shardPolygons(2));
        expect(crackLines(0)).not.toEqual(crackLines(1));
        expect(shardPolygons(0)).toHaveLength(3);
        for (const line of crackLines(4)) {
            expect(line[0].y).toBe(0);
            expect(line[line.length - 1].y).toBe(100);
            for (const p of line) {
                expect(p.x).toBeGreaterThan(0);
                expect(p.x).toBeLessThan(100);
            }
        }
        const [a, b] = crackLines(4);
        a.forEach((p, i) => expect(p.x).toBeLessThan(b[i].x));
    });

    it("fades under reduced motion or with the setting off", () => {
        expect(revealMode(false, true)).toBe("molten");
        expect(revealMode(true, true)).toBe("fade");
        expect(revealMode(false, false)).toBe("fade");
    });
});

function expectOnTheClock(scene: ReturnType<typeof makeScene>, total: number) {
    for (const a of scene.all) {
        // one clock: no delay, the same duration, stepping on the 1/30 s grid
        expect(a.timing.delay ?? 0).toBe(0);
        expect(a.timing.duration).toBe(total);
        expect(a.timing.easing).toBe(`steps(${Math.round(total / RevealFrameMs)}, end)`);
        let last = 0;
        for (const k of a.keyframes) {
            // compositor-only: nothing but opacity and transform moves
            for (const p of Object.keys(k)) {
                expect(["opacity", "transform", "offset", "easing"]).toContain(p);
            }
            if (k.offset != null) {
                expect(k.offset).toBeGreaterThanOrEqual(last);
                expect(k.offset).toBeLessThanOrEqual(1);
                last = k.offset as number;
            }
        }
    }
}

describe("settings reveal runner", () => {
    it("flows along the channels, cools and breaks each card, then leaves only the channels", async () => {
        const scene = makeScene(4);
        const handle = run(scene, "molten");
        expect(settingsRevealRunning()).toBe(true);
        // the melting chip, then a slab per card
        expect(scene.overlay.children.length).toBe(1);
        expect(scene.overlay.children[0].children.length).toBe(1 + 4);
        // the molten in the channels: a clip box and a front per run, and an elbow per turn
        expect(scene.els.molten.children.length).toBe(1);
        expect(scene.els.molten.children[0].children.length).toBe(2 * scene.net.runs.length + scene.net.elbows.length);
        const total = revealPlan(scene.net.lengths, scene.net.reach).total;
        expect(total).toBeLessThanOrEqual(RevealMs.total + 0.001);
        expectOnTheClock(scene, total);
        scene.cards.forEach((card) => {
            expect(card.anims).toHaveLength(1);
            const first = card.anims[0].keyframes[0];
            const last = card.anims[0].keyframes[card.anims[0].keyframes.length - 1];
            expect(first.opacity).toBe(0);
            expect(last.opacity).toBe(1);
        });
        // the nearest card along the channels comes out first
        const shownAt = scene.cards.map(
            (c) => c.anims[0].keyframes.find((k) => k.opacity === 0 && k.easing != null).offset
        );
        const nearest = scene.net.lengths.indexOf(Math.min(...scene.net.lengths));
        expect(Math.min(...(shownAt as number[]))).toBe(shownAt[nearest]);
        // the channels come in with the reveal, the ambient flow at its end
        expect(scene.els.groove.anims[0].keyframes[0].opacity).toBe(0);
        const ambient = scene.els.ambient.anims[0].keyframes;
        expect(ambient[0].opacity).toBe(0);
        expect(ambient[ambient.length - 1].opacity).toBe(1);
        expect(scene.input.count()).toBe(3);
        scene.all.forEach((a) => a.resolve());
        await handle.done;
        expect(scene.overlay.children).toHaveLength(0);
        expect(scene.els.molten.children).toHaveLength(0);
        expect(scene.all.every((a) => a.cancelled)).toBe(true);
        expect(scene.input.count()).toBe(0);
        expect(settingsRevealRunning()).toBe(false);
        expect(finishSettingsReveal()).toBe(false);
    });

    it("ends at once on a click, the wheel or a key, and leaves Escape to the library", async () => {
        for (const type of ["pointerdown", "wheel", "keydown"]) {
            const scene = makeScene(3);
            const handle = run(scene, "molten");
            scene.input.dispatch("keydown", { key: "Escape" });
            expect(handle.running()).toBe(true);
            scene.input.dispatch(type, { key: "a" });
            expect(handle.running()).toBe(false);
            expect(scene.overlay.children).toHaveLength(0);
            expect(scene.els.molten.children).toHaveLength(0);
            expect(scene.all.every((a) => a.cancelled)).toBe(true);
            await handle.done;
        }
        const scene = makeScene(2);
        run(scene, "molten");
        expect(finishSettingsReveal()).toBe(true);
        expect(finishSettingsReveal()).toBe(false);
        expect(scene.overlay.children).toHaveLength(0);
    });

    it("a new reveal ends the one still running", () => {
        const first = makeScene(2);
        const a = run(first, "molten");
        run(makeScene(2), "molten");
        expect(a.running()).toBe(false);
        expect(first.overlay.children).toHaveLength(0);
        finishSettingsReveal();
    });

    it("only fades the cards in, without molten or channels, in the fade mode", async () => {
        const scene = makeScene(5);
        const handle = run(scene, "fade");
        expect(scene.overlay.children).toHaveLength(0);
        expect(scene.els.molten.children).toHaveLength(0);
        expectOnTheClock(scene, onFrameGrid(RevealMs.fade));
        for (const card of scene.cards) {
            expect(card.anims).toHaveLength(1);
            expect(card.anims[0].keyframes.map((k) => Object.keys(k))).toEqual([["opacity"], ["opacity"]]);
        }
        scene.all.forEach((a) => a.resolve());
        await handle.done;
        expect(scene.input.count()).toBe(0);
    });

    it("shows the cards beyond the cap at once", () => {
        const scene = makeScene(MaxRevealCards + 3);
        run(scene, "molten");
        expect(scene.cards.slice(MaxRevealCards).every((c) => c.anims.length === 0)).toBe(true);
        finishSettingsReveal();
    });
});

describe("settings blocks stay on screen (#1548)", () => {
    const library = readFileSync("frontend/moltenterm-shell/library/library.tsx", "utf8");
    const css = readFileSync("frontend/moltenterm-shell/library/library.css", "utf8");

    it("keeps the blocks mounted and marks the open one, with no step back to the blocks", () => {
        expect(library).toContain('aria-current={s.id === block ? "true" : undefined}');
        expect(library).not.toContain("library-settings-back");
        expect(library).not.toContain("library.settings.back");
        expect(css).not.toContain(".mt-lib-setback");
    });

    it("turns the blocks into a sticky row that scrolls sideways while one is open", () => {
        const row = css.match(/\.mt-lib-setstage\[data-state="open"\] > \.mt-lib-setgrid \{[^}]*\}/)?.[0] ?? "";
        expect(row).toContain("position: sticky");
        expect(row).toContain("top: 0");
        expect(row).toContain("overflow-x: auto");
        expect(row).not.toContain("display: none");
    });

    it("starts the reveal from the clicked chip of the row, whichever state it is clicked in", () => {
        expect(library).toContain("onClick={(e) => openFromTile(s.id, e.currentTarget)}");
    });
});

describe("settings channels wiring (#1549)", () => {
    const library = readFileSync("frontend/moltenterm-shell/library/library.tsx", "utf8");
    const css = readFileSync("frontend/moltenterm-shell/library/library.css", "utf8");

    it("lays the channels behind the page, and the melting chip above the sticky row", () => {
        expect(library).toContain('className="mt-ch-layer"');
        expect(css).toMatch(/\.mt-lib-setstage \{[^}]*isolation: isolate;/);
        expect(css).toMatch(/\.mt-ch-layer \{[^}]*z-index: -1;/);
        expect(css).toMatch(/\.mt-reveal-layer \{[^}]*z-index: 4;/);
    });

    it("removes or brings back the channels when reduced motion or the setting changes", () => {
        const effect = library.slice(library.indexOf("useEffect(() => {\n        if (block == null)"));
        expect(effect).toContain('if (mode !== "molten")');
        expect(effect).toContain("channelsRef.current?.dispose()");
        expect(effect).toContain("channelsRef.current ??= openChannels()");
        expect(effect.indexOf("}, [mode]);")).toBeGreaterThan(0);
    });
});

describe("settings reveal wiring", () => {
    it("the library's Escape asks the reveal first, and the setting is in Preferences", () => {
        const library = readFileSync("frontend/moltenterm-shell/library/library.tsx", "utf8");
        const escape = library.indexOf("finishSettingsReveal()");
        expect(escape).toBeGreaterThan(0);
        expect(escape).toBeLessThan(library.indexOf("libraryEscapeStep(suggest"));
        const meta = readFileSync("pkg/molten/settingsmeta/settingsmeta.go", "utf8");
        expect(meta).toMatch(/Key: "moltenterm:settingsreveal", Section: SectionAppearance, .*Default: true/);
    });
});
