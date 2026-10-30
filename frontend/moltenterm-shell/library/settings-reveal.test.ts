// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import {
    crackLines,
    finishSettingsReveal,
    MaxRevealCards,
    revealMode,
    RevealMs,
    revealStarts,
    revealTotalMs,
    runSettingsReveal,
    settingsRevealRunning,
    shardPolygons,
    streamTarget,
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
    const cards = Array.from({ length: cardCount }, (_, i) =>
        makeEl({ left: 100 + (i % 3) * 300, top: 250 + Math.floor(i / 3) * 260, width: 280, height: 240 }, all)
    );
    const chrome = [makeEl(undefined, all)];
    const input = makeInput();
    return { all, stage, overlay, cards, chrome, input };
}

function run(scene: ReturnType<typeof makeScene>, mode: "molten" | "fade") {
    return runSettingsReveal({
        stage: scene.stage as unknown as HTMLElement,
        overlay: scene.overlay as unknown as HTMLElement,
        cards: scene.cards as unknown as HTMLElement[],
        chrome: scene.chrome as unknown as Element[],
        source: { x: 20, y: 10, w: 200, h: 60 },
        mode,
        inputTarget: scene.input as unknown as EventTarget,
    });
}

function endOf(timing: KeyframeAnimationOptions): number {
    return ((timing.delay as number) ?? 0) + (timing.duration as number);
}

describe("settings reveal timeline (DS-SHELL-134)", () => {
    it("starts the cards in the page's order and ends by 700 ms whatever their number", () => {
        for (let n = 1; n <= 30; n++) {
            const starts = revealStarts(n);
            expect(starts).toHaveLength(n);
            expect(starts[0]).toBe(0);
            for (let i = 1; i < n; i++) {
                expect(starts[i]).toBeGreaterThan(starts[i - 1]);
            }
            expect(revealTotalMs(n)).toBeLessThanOrEqual(RevealMs.card + RevealMs.window);
        }
        expect(revealStarts(3)).toEqual([0, 70, 140]);
        expect(revealTotalMs(0)).toBe(0);
        expect(revealTotalMs(5, "fade")).toBe(RevealMs.fade);
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

    it("pours onto the edge of the card that faces the tile", () => {
        const card = { x: 0, y: 200, w: 300, h: 100 };
        const below = streamTarget({ x: 150, y: 20 }, card, 0);
        expect(below.y).toBe(200);
        expect(below.x).toBeGreaterThanOrEqual(45);
        expect(below.x).toBeLessThanOrEqual(255);
        expect(streamTarget({ x: 150, y: 500 }, card, 0).y).toBe(300);
        expect(streamTarget({ x: 600, y: 250 }, card, 0).x).toBe(300);
        expect(streamTarget({ x: 150, y: 20 }, card, 3)).toEqual(streamTarget({ x: 150, y: 20 }, card, 3));
    });

    it("fades under reduced motion or with the setting off", () => {
        expect(revealMode(false, true)).toBe("molten");
        expect(revealMode(true, true)).toBe("fade");
        expect(revealMode(false, false)).toBe("fade");
    });
});

describe("settings reveal runner", () => {
    it("pours, cools and breaks each card, then leaves nothing running", async () => {
        const scene = makeScene(4);
        const handle = run(scene, "molten");
        expect(settingsRevealRunning()).toBe(true);
        // the ghost of the tile, then a stream, a head and a slab per card
        expect(scene.overlay.children.length).toBe(1);
        expect(scene.overlay.children[0].children.length).toBe(1 + 3 * 4);
        const starts = revealStarts(4);
        scene.cards.forEach((card, i) => {
            expect(card.anims).toHaveLength(1);
            expect(card.anims[0].timing.delay).toBe(starts[i]);
            const first = card.anims[0].keyframes[0];
            const last = card.anims[0].keyframes[card.anims[0].keyframes.length - 1];
            expect(first.opacity).toBe(0);
            expect(last.opacity).toBe(1);
        });
        for (const a of scene.all) {
            expect(endOf(a.timing)).toBeLessThanOrEqual(RevealMs.card + RevealMs.window);
            // compositor-only: nothing but opacity and transform moves
            for (const k of a.keyframes) {
                for (const p of Object.keys(k)) {
                    expect(["opacity", "transform", "offset", "easing"]).toContain(p);
                }
            }
        }
        expect(scene.input.count()).toBe(3);
        scene.all.forEach((a) => a.resolve());
        await handle.done;
        expect(scene.overlay.children).toHaveLength(0);
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

    it("only fades the cards in, without molten pieces, in the fade mode", async () => {
        const scene = makeScene(5);
        const handle = run(scene, "fade");
        expect(scene.overlay.children).toHaveLength(0);
        for (const card of scene.cards) {
            expect(card.anims).toHaveLength(1);
            expect(card.anims[0].timing.duration).toBe(RevealMs.fade);
            expect(card.anims[0].timing.delay ?? 0).toBe(0);
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
