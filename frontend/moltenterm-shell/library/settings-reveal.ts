// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The molten reveal of a settings block opened in the library (FR-SHELL-088, DS-SHELL-134, #1407). From the clicked
// tile, one molten stream per card of the block pours to the card's place and spreads over it; the slab cools to cast
// iron, cracks and breaks open, and the card appears under it. Each card runs RevealMs.card, staggered in the page's
// order so the whole reveal ends by RevealMs.card + RevealMs.window. One overlay layer holds the molten pieces for the
// reveal only: Web Animations on transform and opacity, the card's layout final from the first frame, and everything
// cancelled and emptied at the end, so nothing runs once the block is shown. Reduced motion or the setting off: the
// cards fade in. The look is in library.css (.mt-reveal-*).

export const RevealMs = {
    card: 420,
    // The starts of the cards spread over this window at most, so the reveal ends by card + window (700 ms).
    window: 280,
    maxStagger: 70,
    fade: 120,
    source: 220,
} as const;

// Fractions of a card's RevealMs.card.
const Phase = {
    pourEnd: 0.36,
    slabStart: 0.26,
    slabEnd: 0.5,
    coolStart: 0.42,
    coolEnd: 0.64,
    crackStart: 0.6,
    crackEnd: 0.82,
    breakStart: 0.68,
} as const;

// Cards beyond this are shown at once: the reveal stays short and light on a long page.
export const MaxRevealCards = 12;

export const SettingsRevealKey = "moltenterm:settingsreveal";

export type RevealMode = "molten" | "fade";

export type RevealRect = { x: number; y: number; w: number; h: number };

export type RevealPoint = { x: number; y: number };

export function revealMode(reducedMotion: boolean, setting: boolean): RevealMode {
    if (reducedMotion || setting === false) {
        return "fade";
    }
    return "molten";
}

export function revealStagger(n: number): number {
    if (n <= 1) {
        return 0;
    }
    return Math.min(RevealMs.maxStagger, RevealMs.window / (n - 1));
}

// When each card starts, in the page's order.
export function revealStarts(n: number): number[] {
    const stagger = revealStagger(n);
    return Array.from({ length: Math.max(0, n) }, (_, i) => Math.round(i * stagger));
}

export function revealTotalMs(n: number, mode: RevealMode = "molten"): number {
    if (n <= 0) {
        return 0;
    }
    if (mode === "fade") {
        return RevealMs.fade;
    }
    const starts = revealStarts(n);
    return starts[starts.length - 1] + RevealMs.card;
}

// A small seeded generator (mulberry32): the same card index always pours and breaks the same way.
export function seededRandom(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function cardRandom(index: number): () => number {
    return seededRandom(index * 7919 + 1407);
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}

export function rectCenter(r: RevealRect): RevealPoint {
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

// Where the stream reaches the card: on the edge facing the source (the top edge for a card below it, the bottom one
// for a card above it, the near side for a card beside it), a little off centre so the streams fan out.
export function streamTarget(source: RevealPoint, card: RevealRect, index: number): RevealPoint {
    const rnd = cardRandom(index);
    const along = 0.3 + 0.4 * rnd();
    const x = clamp((source.x + card.x + card.w * along) / 2, card.x + card.w * 0.15, card.x + card.w * 0.85);
    if (source.y < card.y) {
        return { x, y: card.y };
    }
    if (source.y > card.y + card.h) {
        return { x, y: card.y + card.h };
    }
    return { x: source.x < card.x ? card.x : card.x + card.w, y: card.y + card.h * along };
}

export type StreamGeometry = { from: RevealPoint; to: RevealPoint; length: number; angle: number };

export function streamGeometry(source: RevealPoint, card: RevealRect, index: number): StreamGeometry {
    const to = streamTarget(source, card, index);
    const dx = to.x - source.x;
    const dy = to.y - source.y;
    return { from: source, to, length: Math.hypot(dx, dy), angle: (Math.atan2(dy, dx) * 180) / Math.PI };
}

// The two cracks of a card's crust, in percent of the card (x across, y down), each from the top edge to the bottom
// one, jagged. They split the crust into the three shards of shardPolygons.
export function crackLines(index: number): RevealPoint[][] {
    const rnd = cardRandom(index + 101);
    return [33, 67].map((base) =>
        [0, 25, 50, 75, 100].map((y) => ({ x: Math.round((base + (rnd() - 0.5) * 14) * 10) / 10, y }))
    );
}

function pct(p: RevealPoint): string {
    return `${p.x}% ${p.y}%`;
}

// The crust's shards as clip-path polygons: left of the first crack, between the two, right of the second.
export function shardPolygons(index: number): string[] {
    const [a, b] = crackLines(index);
    const left = [{ x: 0, y: 0 }, ...a, { x: 0, y: 100 }];
    const middle = [...a, ...[...b].reverse()];
    const right = [...b, { x: 100, y: 100 }, { x: 100, y: 0 }];
    return [left, middle, right].map((pts) => `polygon(${pts.map(pct).join(", ")})`);
}

// How each shard leaves when the crust breaks: outwards from the cracks, tilting a little.
export const ShardDrift = [
    { x: -9, y: 5, r: -3 },
    { x: 0, y: 9, r: 1.5 },
    { x: 9, y: 5, r: 3 },
] as const;

// The cards to reveal: the block's top-level settings blocks, in the page's order.
export function revealTargets(page: Element): HTMLElement[] {
    if (page == null) {
        return [];
    }
    return Array.from(page.querySelectorAll<HTMLElement>(".df-block")).filter(
        (el) => el.parentElement?.closest(".df-block") == null
    );
}

export function relativeRect(r: DOMRect | RevealRect, origin: DOMRect | RevealRect): RevealRect {
    const ox = "left" in origin ? origin.left : origin.x;
    const oy = "top" in origin ? origin.top : origin.y;
    const x = "left" in r ? r.left : r.x;
    const y = "top" in r ? r.top : r.y;
    const w = "width" in r ? r.width : r.w;
    const h = "height" in r ? r.height : r.h;
    return { x: x - ox, y: y - oy, w, h };
}

export type RevealOptions = {
    // The stage: positioned, the origin of every rect.
    stage: HTMLElement;
    // The overlay inside the stage that holds the molten pieces while the reveal runs.
    overlay: HTMLElement;
    // The cards, in order.
    cards: HTMLElement[];
    // The rest of the open block (its back action and header), which fades in.
    chrome?: Element[];
    // The clicked tile's rect relative to the stage, read before it was hidden; null pours from the top centre.
    source: RevealRect;
    mode: RevealMode;
    // Ends the reveal on the developer's input (pointer, wheel, a key other than Escape: the library's own Escape
    // handler asks finishSettingsReveal first). Tests pass their own target.
    inputTarget?: EventTarget;
};

export type RevealHandle = {
    // Ends the reveal now, everything in its final state. False when it had already ended.
    finish: () => boolean;
    done: Promise<void>;
    running: () => boolean;
};

let current: RevealHandle = null;

// The library's Escape: a running reveal ends first, and that Escape goes no further.
export function finishSettingsReveal(): boolean {
    return current?.finish() ?? false;
}

export function settingsRevealRunning(): boolean {
    return current?.running() ?? false;
}

function canAnimate(el: Element): boolean {
    return typeof (el as HTMLElement)?.animate === "function";
}

function piece(doc: Document, className: string, style: Partial<Record<string, string>> = {}): HTMLElement {
    const el = doc.createElement("div");
    el.className = className;
    for (const [k, v] of Object.entries(style)) {
        el.style.setProperty(k, v);
    }
    return el;
}

function crackSvg(doc: Document, index: number): SVGSVGElement {
    const ns = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(ns, "svg");
    svg.setAttribute("class", "mt-reveal-crack");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    for (const line of crackLines(index)) {
        const path = doc.createElementNS(ns, "polyline");
        path.setAttribute("points", line.map((p) => `${p.x},${p.y}`).join(" "));
        path.setAttribute("vector-effect", "non-scaling-stroke");
        svg.appendChild(path);
    }
    return svg;
}

export function runSettingsReveal(opts: RevealOptions): RevealHandle {
    current?.finish();
    const { stage, overlay, mode } = opts;
    const cards = (opts.cards ?? []).slice(0, MaxRevealCards);
    const doc = stage.ownerDocument;
    const animations: Animation[] = [];
    let ended = false;
    let resolveDone: () => void;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    const input = opts.inputTarget ?? doc.defaultView;

    const onInput = (e: Event) => {
        if (e.type === "keydown" && (e as KeyboardEvent).key === "Escape") {
            return;
        }
        finish();
    };
    const cleanup = () => {
        if (ended) {
            return;
        }
        ended = true;
        input?.removeEventListener("pointerdown", onInput, true);
        input?.removeEventListener("wheel", onInput, true);
        input?.removeEventListener("keydown", onInput, true);
        for (const a of animations) {
            a.cancel();
        }
        animations.length = 0;
        overlay.replaceChildren();
        if (current === handle) {
            current = null;
        }
        resolveDone();
    };
    // Cancelling is the final state: the cards' own style is the shown block, and the molten pieces go with the overlay.
    const finish = (): boolean => {
        if (ended) {
            return false;
        }
        cleanup();
        return true;
    };
    const handle: RevealHandle = { finish, done, running: () => !ended };
    current = handle;

    if (cards.length === 0 || !canAnimate(stage)) {
        cleanup();
        return handle;
    }

    const play = (el: Element, keyframes: Keyframe[], timing: KeyframeAnimationOptions) => {
        animations.push((el as HTMLElement).animate(keyframes, { fill: "both", ...timing }));
    };

    for (const el of opts.chrome ?? []) {
        play(el, [{ opacity: 0 }, { opacity: 1 }], { duration: RevealMs.fade, easing: "linear" });
    }

    if (mode === "fade") {
        for (const card of cards) {
            play(card, [{ opacity: 0 }, { opacity: 1 }], { duration: RevealMs.fade, easing: "linear" });
        }
    } else {
        const stageRect = stage.getBoundingClientRect();
        const rects = cards.map((c) => relativeRect(c.getBoundingClientRect(), stageRect));
        const src: RevealPoint =
            opts.source != null
                ? { x: opts.source.x + opts.source.w / 2, y: opts.source.y + opts.source.h / 2 }
                : { x: stageRect.width / 2, y: 0 };
        const starts = revealStarts(cards.length);
        const D = RevealMs.card;
        const frag = doc.createDocumentFragment();
        const queue: Array<() => void> = [];

        if (opts.source != null) {
            const s = opts.source;
            const ghost = piece(doc, "mt-reveal-source", {
                left: `${s.x}px`,
                top: `${s.y}px`,
                width: `${s.w}px`,
                height: `${s.h}px`,
            });
            frag.appendChild(ghost);
            queue.push(() =>
                play(
                    ghost,
                    [
                        { opacity: 1, transform: "scale(1, 1)" },
                        { opacity: 1, transform: "scale(1.02, 0.9)", offset: 0.35 },
                        { opacity: 0, transform: "scale(0.7, 0.15)" },
                    ],
                    { duration: RevealMs.source, easing: "cubic-bezier(0.5, 0, 0.8, 0.4)" }
                )
            );
        }

        cards.forEach((card, i) => {
            const r = rects[i];
            const g = streamGeometry(src, r, i);
            const delay = starts[i];

            const stream = piece(doc, "mt-reveal-stream", {
                left: `${g.from.x}px`,
                top: `${g.from.y}px`,
                width: `${Math.max(1, g.length)}px`,
            });
            const head = piece(doc, "mt-reveal-head");
            const slab = piece(doc, "mt-reveal-slab", {
                left: `${r.x}px`,
                top: `${r.y}px`,
                width: `${r.w}px`,
                height: `${r.h}px`,
                "transform-origin": `${g.to.x - r.x}px ${g.to.y - r.y}px`,
                "--mt-reveal-hot-x": `${g.to.x - r.x}px`,
                "--mt-reveal-hot-y": `${g.to.y - r.y}px`,
            });
            const hot = piece(doc, "mt-reveal-hot");
            slab.appendChild(hot);
            const shards = shardPolygons(i).map((clip) => {
                const shard = piece(doc, "mt-reveal-shard", { "clip-path": clip });
                slab.appendChild(shard);
                return shard;
            });
            const crack = crackSvg(doc, i);
            slab.appendChild(crack);
            frag.append(stream, head, slab);

            const rot = `rotate(${g.angle}deg)`;
            queue.push(() => {
                play(
                    stream,
                    [
                        { transform: `${rot} scaleX(0)`, opacity: 1 },
                        { transform: `${rot} scaleX(1)`, opacity: 1, offset: Phase.pourEnd },
                        { transform: `${rot} scaleX(1)`, opacity: 0, offset: Phase.coolEnd },
                        { transform: `${rot} scaleX(1)`, opacity: 0 },
                    ],
                    { duration: D, delay, easing: "linear" }
                );
                const hx = (p: RevealPoint) => `translate(${p.x}px, ${p.y}px)`;
                play(
                    head,
                    [
                        { transform: `${hx(g.from)} scale(0.6)`, opacity: 1, easing: "cubic-bezier(0.4, 0, 1, 1)" },
                        { transform: `${hx(g.to)} scale(1.5)`, opacity: 1, offset: Phase.pourEnd },
                        { transform: `${hx(g.to)} scale(2.2)`, opacity: 0, offset: Phase.slabEnd },
                        { transform: `${hx(g.to)} scale(2.2)`, opacity: 0 },
                    ],
                    { duration: D, delay }
                );
                play(
                    slab,
                    [
                        { transform: "scale(0.04, 0.03)", opacity: 0 },
                        { transform: "scale(0.04, 0.03)", opacity: 0, offset: Phase.slabStart },
                        {
                            transform: "scale(1, 1)",
                            opacity: 1,
                            offset: Phase.slabEnd,
                            easing: "linear",
                        },
                        { transform: "scale(1, 1)", opacity: 1 },
                    ],
                    { duration: D, delay, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)" }
                );
                play(
                    hot,
                    [
                        { opacity: 1 },
                        { opacity: 1, offset: Phase.coolStart },
                        { opacity: 0, offset: Phase.coolEnd },
                        { opacity: 0 },
                    ],
                    { duration: D, delay, easing: "linear" }
                );
                shards.forEach((shard, k) => {
                    const d = ShardDrift[k];
                    play(
                        shard,
                        [
                            { opacity: 0, transform: "translate(0, 0) rotate(0deg)" },
                            { opacity: 0, transform: "translate(0, 0) rotate(0deg)", offset: Phase.coolStart },
                            { opacity: 1, transform: "translate(0, 0) rotate(0deg)", offset: Phase.coolEnd },
                            {
                                opacity: 1,
                                transform: "translate(0, 0) rotate(0deg)",
                                offset: Phase.breakStart,
                                easing: "cubic-bezier(0.4, 0, 1, 1)",
                            },
                            { opacity: 0, transform: `translate(${d.x}px, ${d.y}px) rotate(${d.r}deg) scale(0.97)` },
                        ],
                        { duration: D, delay, easing: "linear" }
                    );
                });
                play(
                    crack,
                    [
                        { opacity: 0 },
                        { opacity: 0, offset: Phase.crackStart },
                        { opacity: 1, offset: Phase.breakStart },
                        { opacity: 0, offset: Phase.crackEnd },
                        { opacity: 0 },
                    ],
                    { duration: D, delay, easing: "linear" }
                );
                play(
                    card,
                    [
                        { opacity: 0, transform: "translateY(6px)" },
                        { opacity: 0, transform: "translateY(6px)", offset: Phase.breakStart },
                        { opacity: 1, transform: "translateY(0)" },
                    ],
                    { duration: D, delay, easing: "cubic-bezier(0.2, 0, 0, 1)" }
                );
            });
        });
        overlay.appendChild(frag);
        for (const start of queue) {
            start();
        }
    }

    input?.addEventListener("pointerdown", onInput, true);
    input?.addEventListener("wheel", onInput, { capture: true, passive: true });
    input?.addEventListener("keydown", onInput, true);
    Promise.all(animations.map((a) => a.finished)).then(
        () => cleanup(),
        () => cleanup()
    );
    return handle;
}
