// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The molten reveal of a settings block opened in the library (FR-SHELL-088, DS-SHELL-138, #1407, #1549). The clicked
// chip melts into the channels (settings-channels.ts) and the molten flows along them, a viscous liquid with a bulge
// at its front, slowing as it spreads, to the top edge of each card of the block; there the slab spreads, cools to
// cast iron, cracks and breaks open, and the card appears under it. The farthest card is reached by
// RevealMs.arriveMax and shown RevealMs.afterArrival later, so the whole reveal ends by 700 ms.
//
// Every element has its own keyframes spanning the whole reveal and waits by holding its first keyframe, never with a
// delay; all start together on the 1/30 s grid of the working light (#1388) and step on it. Transform and opacity
// only, the card's layout final from the first frame. At the end the reveal's pieces are cancelled and removed: the
// channels stay with their faint ambient flow. Reduced motion or the setting off: no channel, the cards fade in. The
// look is in library.css (.mt-reveal-*, .mt-ch-*).

import {
    ChannelElements,
    ChannelNetwork,
    ChannelPx,
    ChannelRun,
    ChannelsHandle,
    elbowPath,
    runLength,
    runRect,
} from "./settings-channels";

export const RevealFrameMs = 1000 / 30;

export const RevealMs = {
    // The molten leaves the chip, then reaches the farthest card.
    flowStart: 60,
    arriveMax: 430,
    // From a card's arrival to the card shown.
    afterArrival: 270,
    // The reveal's molten drains into the channels' bed while the ambient flow comes in.
    drain: 160,
    fade: 120,
    source: 220,
    total: 700,
} as const;

// A card's phases, in ms from the arrival of the molten at its top edge.
const Phase = {
    slabStart: -20,
    slabEnd: 70,
    coolStart: 60,
    coolEnd: 150,
    crackStart: 140,
    crackPeak: 165,
    crackEnd: 210,
    breakStart: 160,
    end: RevealMs.afterArrival,
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

function clamp(v: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, v));
}

export function onFrameGrid(ms: number): number {
    return Math.ceil(ms / RevealFrameMs - 1e-6) * RevealFrameMs;
}

// When the front of the molten reaches distance d along the channels, the farthest card being at `reach`. A viscous
// flow: it slows as it spreads (about 1.7 times the mean speed at the chip, 0.7 times at the farthest card), and a small
// fixed wobble (about ±18 %) makes the speed vary from run to run. Monotonic, so the cards are reached in the order of
// their distance along the channels.
export function flowTime(d: number, reach: number): number {
    if (!(reach > 0)) {
        return RevealMs.arriveMax;
    }
    const wobble = (s: number) => s + 16 * (1 - Math.cos(s / 90));
    const u = clamp(wobble(Math.max(0, d)) / wobble(reach), 0, 1);
    // Time per pixel grows from 0.6 to 1.4 times the mean along the way.
    const eased = 0.6 * u + 0.4 * u * u;
    return RevealMs.flowStart + (RevealMs.arriveMax - RevealMs.flowStart) * eased;
}

// The molten's arrival at each card, and the reveal's total length on the frame grid.
export function revealPlan(lengths: number[], reach: number): { arrivals: number[]; total: number } {
    const arrivals = lengths.map((l) => flowTime(l, reach));
    if (arrivals.length === 0) {
        return { arrivals, total: 0 };
    }
    return { arrivals, total: onFrameGrid(Math.max(...arrivals) + RevealMs.afterArrival) };
}

export function revealTotalMs(lengths: number[], reach: number, mode: RevealMode = "molten"): number {
    if (lengths.length === 0) {
        return 0;
    }
    if (mode === "fade") {
        return onFrameGrid(RevealMs.fade);
    }
    return revealPlan(lengths, reach).total;
}

// A small seeded generator (mulberry32): the same card index always breaks the same way.
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

// Keyframes on the reveal's own clock: each stop at its time in ms, held from 0 to the first stop and from the last
// stop to the end, so an element waits inside its keyframes rather than with a delay.
export function onClock(total: number, stops: Array<[number, Keyframe]>): Keyframe[] {
    const plain = (k: Keyframe): Keyframe => {
        const { easing: _easing, ...rest } = k;
        return rest;
    };
    const out: Keyframe[] = [];
    let last = 0;
    const push = (offset: number, k: Keyframe) => {
        last = Math.max(last, clamp(offset, 0, 1));
        out.push({ ...k, offset: last });
    };
    if (stops[0][0] > 0) {
        push(0, plain(stops[0][1]));
    }
    for (const [ms, k] of stops) {
        push(ms / total, k);
    }
    if (stops[stops.length - 1][0] < total) {
        push(1, plain(stops[stops.length - 1][1]));
    }
    return out;
}

export type RevealOptions = {
    // The stage: positioned, the origin of every rect.
    stage: HTMLElement;
    // The overlay inside the stage, above the page, that holds the source, the slabs and their crust.
    overlay: HTMLElement;
    // The cards, in order.
    cards: HTMLElement[];
    // The rest of the open block (its header), which fades in.
    chrome?: Element[];
    // The clicked chip's rect relative to the stage, at its place in the row; null when the block was not opened by a
    // click (no chip melts).
    source: RevealRect;
    mode: RevealMode;
    // The channels of the open block (molten mode only): the molten flows in them.
    channels?: ChannelsHandle;
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

function box(r: RevealRect): Record<string, string> {
    return { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` };
}

const SvgNs = "http://www.w3.org/2000/svg";

function crackSvg(doc: Document, index: number): SVGSVGElement {
    const svg = doc.createElementNS(SvgNs, "svg");
    svg.setAttribute("class", "mt-reveal-crack");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.setAttribute("preserveAspectRatio", "none");
    for (const line of crackLines(index)) {
        const path = doc.createElementNS(SvgNs, "polyline");
        path.setAttribute("points", line.map((p) => `${p.x},${p.y}`).join(" "));
        path.setAttribute("vector-effect", "non-scaling-stroke");
        svg.appendChild(path);
    }
    return svg;
}

// The droplet of the front points the way the run flows.
function headTurn(r: ChannelRun): number {
    if (r.axis === "x") {
        return r.dir > 0 ? 0 : 180;
    }
    return r.dir > 0 ? 90 : -90;
}

// The molten of a run: a pre-painted bar slides into its clip box between the front's arrival at either end. The box
// is wider than the bar by the glow on each side.
function runPieces(doc: Document, r: ChannelRun, t: (d: number) => number, total: number, drainAt: number) {
    const clip = piece(doc, `mt-ch-run is-${r.axis}`, box(runRect(r, ChannelPx.molten + 2 * ChannelPx.glow)));
    const fill = piece(doc, "mt-ch-fill");
    const at = (p: RevealPoint) => `translate(${p.x}px, ${p.y}px) rotate(${headTurn(r)}deg)`;
    clip.appendChild(fill);
    const axis = r.axis === "x" ? "X" : "Y";
    const len = runLength(r);
    const t0 = t(r.d0);
    const t1 = Math.max(t0, t(r.d1));
    const out = `translate${axis}(${-r.dir * len}px)`;
    const fillKeys = onClock(total, [
        [t0, { transform: out, opacity: 1 }],
        [t1, { transform: `translate${axis}(0px)`, opacity: 1 }],
        [drainAt, { transform: `translate${axis}(0px)`, opacity: 1 }],
        [total, { transform: `translate${axis}(0px)`, opacity: 0 }],
    ]);
    // The bulge at the front: it leads the bar along the run, then hands over to the next runs, or spreads into the
    // card at the end of a branch.
    const head = piece(doc, "mt-ch-head");
    const gone = r.card != null ? t1 + Phase.slabEnd : t1 + RevealFrameMs;
    const headKeys = onClock(total, [
        [Math.max(0, t0 - RevealFrameMs), { transform: `${at(r.a)} scale(0.8)`, opacity: 0 }],
        [t0, { transform: `${at(r.a)} scale(1)`, opacity: 1 }],
        [t1, { transform: `${at(r.b)} scale(${r.card != null ? 1.3 : 1})`, opacity: 1 }],
        [gone, { transform: `${at(r.b)} scale(${r.card != null ? 2 : 1})`, opacity: 0 }],
    ]);
    return { clip, fill, fillKeys, head, headKeys };
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
    const els: ChannelElements = mode === "molten" ? (opts.channels?.elements() ?? null) : null;

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
        els?.molten.replaceChildren();
        if (current === handle) {
            current = null;
        }
        resolveDone();
    };
    // Cancelling is the final state: the cards' own style is the shown block, the channels' own style their resting
    // look, and the molten pieces go with the overlay.
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

    const queue: Array<[Element, Keyframe[]]> = [];
    let total: number;

    if (mode === "fade") {
        total = onFrameGrid(RevealMs.fade);
        for (const el of [...(opts.chrome ?? []), ...cards]) {
            queue.push([el, [{ opacity: 0 }, { opacity: 1 }]]);
        }
    } else {
        const net: ChannelNetwork = opts.channels?.net() ?? null;
        const stageRect = stage.getBoundingClientRect();
        const rects = cards.map((c) => relativeRect(c.getBoundingClientRect(), stageRect));
        const lengths = net?.lengths.slice(0, cards.length) ?? cards.map(() => 0);
        const reach = net?.reach ?? 0;
        const plan = revealPlan(lengths, reach);
        total = plan.total;
        const T = total;
        const t = (d: number) => flowTime(d, reach);
        const drainAt = T - RevealMs.drain;
        const frag = doc.createDocumentFragment();

        for (const el of opts.chrome ?? []) {
            queue.push([
                el,
                onClock(T, [
                    [0, { opacity: 0 }],
                    [RevealMs.fade, { opacity: 1 }],
                ]),
            ]);
        }

        if (opts.source != null) {
            const ghost = piece(doc, "mt-reveal-source", box(opts.source));
            frag.appendChild(ghost);
            queue.push([
                ghost,
                onClock(T, [
                    [0, { opacity: 1, transform: "scale(1, 1)", easing: "cubic-bezier(0.5, 0, 0.8, 0.4)" }],
                    [RevealMs.source * 0.35, { opacity: 1, transform: "scale(1.02, 0.9)" }],
                    [RevealMs.source, { opacity: 0, transform: "scale(0.7, 0.15)" }],
                ]),
            ]);
        }

        if (els != null && net != null) {
            const molten = doc.createDocumentFragment();
            for (const r of net.runs) {
                const p = runPieces(doc, r, t, T, drainAt);
                molten.append(p.clip, p.head);
                queue.push([p.fill, p.fillKeys], [p.head, p.headKeys]);
            }
            for (const e of net.elbows) {
                const pad = ChannelPx.molten;
                const origin = { x: Math.min(e.p0.x, e.p2.x) - pad, y: Math.min(e.p0.y, e.p2.y) - pad };
                const w = Math.abs(e.p0.x - e.p2.x) + 2 * pad;
                const h = Math.abs(e.p0.y - e.p2.y) + 2 * pad;
                const svg = doc.createElementNS(SvgNs, "svg");
                svg.setAttribute("class", "mt-ch-elbow");
                svg.setAttribute("width", String(w));
                svg.setAttribute("height", String(h));
                svg.setAttribute("style", `left: ${origin.x}px; top: ${origin.y}px`);
                for (const cls of ["mt-ch-elbow-edge", "mt-ch-elbow-core"]) {
                    const path = doc.createElementNS(SvgNs, "path");
                    path.setAttribute("class", cls);
                    path.setAttribute("d", elbowPath(e, origin));
                    svg.appendChild(path);
                }
                molten.appendChild(svg);
                const t0 = t(e.d0);
                queue.push([
                    svg,
                    onClock(T, [
                        [t0, { opacity: 0 }],
                        [Math.max(t0, t(e.d2)), { opacity: 1 }],
                        [drainAt, { opacity: 1 }],
                        [T, { opacity: 0 }],
                    ]),
                ]);
            }
            els.molten.appendChild(molten);
            queue.push(
                [
                    els.groove,
                    onClock(T, [
                        [0, { opacity: 0 }],
                        [RevealMs.fade, { opacity: 1 }],
                    ]),
                ],
                [
                    els.ambient,
                    onClock(T, [
                        [drainAt, { opacity: 0 }],
                        [T, { opacity: 1 }],
                    ]),
                ]
            );
        }

        cards.forEach((card, i) => {
            const r = rects[i];
            const A = plan.arrivals[i];
            const entry = net?.entries[i] ?? { x: r.x + r.w / 2, y: r.y };
            const slab = piece(doc, "mt-reveal-slab", {
                ...box(r),
                "transform-origin": `${entry.x - r.x}px ${entry.y - r.y}px`,
                "--mt-reveal-hot-x": `${entry.x - r.x}px`,
                "--mt-reveal-hot-y": `${entry.y - r.y}px`,
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
            frag.appendChild(slab);

            queue.push([
                slab,
                onClock(T, [
                    [
                        A + Phase.slabStart,
                        { transform: "scale(0.04, 0.03)", opacity: 0, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)" },
                    ],
                    [A + Phase.slabEnd, { transform: "scale(1, 1)", opacity: 1 }],
                ]),
            ]);
            queue.push([
                hot,
                onClock(T, [
                    [A + Phase.coolStart, { opacity: 1 }],
                    [A + Phase.coolEnd, { opacity: 0 }],
                ]),
            ]);
            shards.forEach((shard, k) => {
                const d = ShardDrift[k];
                const still = "translate(0, 0) rotate(0deg)";
                queue.push([
                    shard,
                    onClock(T, [
                        [A + Phase.coolStart, { opacity: 0, transform: still }],
                        [A + Phase.coolEnd, { opacity: 1, transform: still }],
                        [A + Phase.breakStart, { opacity: 1, transform: still, easing: "cubic-bezier(0.4, 0, 1, 1)" }],
                        [
                            A + Phase.end,
                            { opacity: 0, transform: `translate(${d.x}px, ${d.y}px) rotate(${d.r}deg) scale(0.97)` },
                        ],
                    ]),
                ]);
            });
            queue.push([
                crack,
                onClock(T, [
                    [A + Phase.crackStart, { opacity: 0 }],
                    [A + Phase.crackPeak, { opacity: 1 }],
                    [A + Phase.crackEnd, { opacity: 0 }],
                ]),
            ]);
            queue.push([
                card,
                onClock(T, [
                    [
                        A + Phase.breakStart,
                        { opacity: 0, transform: "translateY(6px)", easing: "cubic-bezier(0.2, 0, 0, 1)" },
                    ],
                    [A + Phase.end, { opacity: 1, transform: "translateY(0)" }],
                ]),
            ]);
        });
        overlay.appendChild(frag);
    }

    // One clock for every element: the same duration, started together on the frame grid, stepping on it.
    const steps = Math.max(1, Math.round(total / RevealFrameMs));
    for (const [el, keyframes] of queue) {
        animations.push(
            (el as HTMLElement).animate(keyframes, { duration: total, easing: `steps(${steps}, end)`, fill: "both" })
        );
    }
    const now = doc.timeline?.currentTime;
    if (typeof now === "number") {
        const start = onFrameGrid(now);
        for (const a of animations) {
            a.startTime = start;
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
