// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The channels of the molten reveal (FR-SHELL-088, DS-SHELL-138, #1549): tidy pipework, as if dug by dwarves, from
// the open block's chip in the row to the top edge of each card of the block. Straight runs, right angles and rounded
// elbows: a lane under the row, a spine down the page's left margin, a manifold above the first cards, a gutter down
// each column and a short drop into each card. The routes share their common parts, so the network is a tree, split
// at every junction and drawn once.
//
// The channels are engraved grooves of cast iron behind the page (the cards cover them, never text). Once the block is
// shown, a faint molten flow keeps running in them: one pre-painted tile per straight run, moved along the flow by
// exactly one tile per whole-second cycle on the 1/15 s grid of the sidebar's heat (#1388, #1399, #1457), transform
// only, and paused whenever the view stands still (data-mt-motion). The reveal itself (settings-reveal.ts) pours the
// molten along the same network.

export const ChannelPx = {
    groove: 12,
    molten: 8,
    // Room for the molten's glow on each side, inside its clip box.
    glow: 4,
    core: 2,
    elbow: 8,
    // Above the cards: the manifold, and the lane of a lower card in the gap above it.
    aboveCard: 16,
    // The source's drop starts under the row, hidden by it.
    sourceDrop: 20,
    // Runs shorter than this carry no ambient flow (an elbow's stub, a T's stub).
    minAmbientRun: 24,
} as const;

// The ambient flow: a tile of faint streaks moved by exactly one tile per cycle, in steps of 1/15 s.
export const AmbientFlow = {
    tile: 56,
    cycleMs: 4000,
    stepsPerSecond: 15,
} as const;

export type ChannelPoint = { x: number; y: number };
export type ChannelRect = { x: number; y: number; w: number; h: number };

export type ChannelLayout = {
    // The open block's chip in the row (its horizontal centre is the source).
    chip: ChannelRect;
    // The settings page under the row: its top is the lane under the row, its left the margin.
    page: ChannelRect;
    // The cards to reach, in the page's order.
    cards: ChannelRect[];
};

// A straight piece of the network between two junctions (or an elbow's end), in the direction of the flow. d0 and d1
// are the distances along the pipework from the source.
export type ChannelRun = {
    a: ChannelPoint;
    b: ChannelPoint;
    axis: "x" | "y";
    dir: 1 | -1;
    d0: number;
    d1: number;
    // The run ends at a card's top edge: the index of that card.
    card?: number;
};

// A rounded turn: a quadratic curve from p0 to p2 around the corner p1, at distance d1 at its corner.
export type ChannelElbow = {
    p0: ChannelPoint;
    p1: ChannelPoint;
    p2: ChannelPoint;
    d0: number;
    d2: number;
};

export type ChannelNetwork = {
    runs: ChannelRun[];
    elbows: ChannelElbow[];
    // Per card: the route's points from the source to the card's entry, and its length.
    routes: ChannelPoint[][];
    lengths: number[];
    entries: ChannelPoint[];
    // The longest route.
    reach: number;
};

function same(a: ChannelPoint, b: ChannelPoint): boolean {
    return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
}

function dist(a: ChannelPoint, b: ChannelPoint): number {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function key(p: ChannelPoint): string {
    return `${Math.round(p.x)},${Math.round(p.y)}`;
}

// Drops repeated points and the middle of straight lines: a route is its turns only.
export function simplifyRoute(points: ChannelPoint[]): ChannelPoint[] {
    const out: ChannelPoint[] = [];
    for (const p of points) {
        const q = { x: Math.round(p.x), y: Math.round(p.y) };
        if (out.length > 0 && same(out[out.length - 1], q)) {
            continue;
        }
        if (out.length >= 2) {
            const a = out[out.length - 2];
            const b = out[out.length - 1];
            if ((a.x === b.x && b.x === q.x) || (a.y === b.y && b.y === q.y)) {
                out[out.length - 1] = q;
                continue;
            }
        }
        out.push(q);
    }
    return out;
}

// The gap between two columns of cards (the masonry's), 32 px when there is a single column.
function columnGap(cards: ChannelRect[]): number {
    let gap = Infinity;
    for (const a of cards) {
        for (const b of cards) {
            const g = b.x - (a.x + a.w);
            if (g > 0 && g < gap) {
                gap = g;
            }
        }
    }
    return Number.isFinite(gap) ? gap : 32;
}

// The routes, one per card: from under the chip, along the lane under the row to the left margin, down the spine to
// the manifold above the first cards, along it to the card's column, down the column's gutter to the gap above the
// card, along that gap to the card's middle, and down into its top edge. A card of the first row branches off the
// manifold directly. Nothing crosses the page's header: the spine runs in the margin, left of it.
export function channelRoutes(layout: ChannelLayout): ChannelPoint[][] {
    const { chip, page, cards } = layout;
    if (cards.length === 0) {
        return [];
    }
    const left = Math.min(...cards.map((c) => c.x));
    const top = Math.min(...cards.map((c) => c.y));
    const half = Math.min(ChannelPx.aboveCard, (left - page.x) / 2);
    const spineX = left - half;
    const gutter = Math.min(ChannelPx.aboveCard, columnGap(cards) / 2);
    const laneY = page.y;
    const manifoldY = top - ChannelPx.aboveCard;
    const sourceX = chip.x + chip.w / 2;
    return cards.map((card) => {
        const x = card.x + card.w / 2;
        const firstRow = card.y <= top + 2;
        const columnX = card.x <= left + 2 ? spineX : card.x - gutter;
        // The nearest card above in the same column bounds the gap the lane runs in.
        const above = cards
            .filter((c) => c !== card && c.y + c.h <= card.y && c.x < card.x + card.w && card.x < c.x + c.w)
            .reduce((m, c) => Math.max(m, c.y + c.h), -Infinity);
        const gapAbove = Number.isFinite(above) ? card.y - above : 2 * ChannelPx.aboveCard;
        const laneAbove = firstRow ? manifoldY : card.y - Math.min(ChannelPx.aboveCard, gapAbove / 2);
        return simplifyRoute([
            { x: sourceX, y: laneY - ChannelPx.sourceDrop },
            { x: sourceX, y: laneY },
            { x: spineX, y: laneY },
            { x: spineX, y: manifoldY },
            { x: columnX, y: manifoldY },
            { x: columnX, y: laneAbove },
            { x, y: laneAbove },
            { x, y: card.y },
        ]);
    });
}

function onSegment(p: ChannelPoint, a: ChannelPoint, b: ChannelPoint): boolean {
    if (a.x === b.x) {
        return p.x === a.x && p.y > Math.min(a.y, b.y) && p.y < Math.max(a.y, b.y);
    }
    return p.y === a.y && p.x > Math.min(a.x, b.x) && p.x < Math.max(a.x, b.x);
}

// The network: the routes split at every point where another route turns or ends, each piece kept once, then the
// pure turns (one way in, one way out) rounded with an elbow and the runs next to them shortened by its radius. A
// junction where the pipe also goes straight on is a tee, not rounded.
export function channelNetwork(routes: ChannelPoint[][]): ChannelNetwork {
    const vertices = routes.flat();
    const pieces = new Map<string, ChannelRun>();
    const order: string[] = [];
    const lengths: number[] = [];
    routes.forEach((route, card) => {
        let d = 0;
        for (let i = 0; i + 1 < route.length; i++) {
            const a = route[i];
            const b = route[i + 1];
            const cuts = vertices
                .filter((v) => onSegment(v, a, b))
                .sort((p, q) => dist(a, p) - dist(a, q))
                .filter((v, k, all) => k === 0 || !same(v, all[k - 1]));
            const points = [a, ...cuts, b];
            for (let k = 0; k + 1 < points.length; k++) {
                const p = points[k];
                const q = points[k + 1];
                const len = dist(p, q);
                const id = `${key(p)}>${key(q)}`;
                const last = i + 2 === route.length && k + 2 === points.length;
                const existing = pieces.get(id);
                if (existing == null) {
                    const axis = p.y === q.y ? "x" : "y";
                    const dir = (axis === "x" ? q.x - p.x : q.y - p.y) > 0 ? 1 : -1;
                    pieces.set(id, { a: p, b: q, axis, dir, d0: d, d1: d + len, card: last ? card : undefined });
                    order.push(id);
                } else if (d < existing.d0) {
                    existing.d0 = d;
                    existing.d1 = d + len;
                }
                d += len;
            }
        }
        lengths.push(d);
    });
    const runs = order.map((id) => pieces.get(id));
    const into = new Map<string, ChannelRun[]>();
    const outOf = new Map<string, ChannelRun[]>();
    for (const r of runs) {
        into.set(key(r.b), [...(into.get(key(r.b)) ?? []), r]);
        outOf.set(key(r.a), [...(outOf.get(key(r.a)) ?? []), r]);
    }
    const elbows: ChannelElbow[] = [];
    for (const [k, ins] of into) {
        const outs = outOf.get(k) ?? [];
        if (ins.length !== 1 || outs.length !== 1 || ins[0].axis === outs[0].axis) {
            continue;
        }
        const r1 = ins[0];
        const r2 = outs[0];
        const radius = Math.min(ChannelPx.elbow, (r1.d1 - r1.d0) / 2, (r2.d1 - r2.d0) / 2);
        if (radius < 1) {
            continue;
        }
        const corner = r1.b;
        const p0 =
            r1.axis === "x"
                ? { x: corner.x - r1.dir * radius, y: corner.y }
                : { x: corner.x, y: corner.y - r1.dir * radius };
        const p2 =
            r2.axis === "x"
                ? { x: corner.x + r2.dir * radius, y: corner.y }
                : { x: corner.x, y: corner.y + r2.dir * radius };
        r1.b = p0;
        r1.d1 -= radius;
        r2.a = p2;
        r2.d0 += radius;
        elbows.push({ p0, p1: corner, p2, d0: r1.d1, d2: r2.d0 });
    }
    return {
        runs,
        elbows,
        routes,
        lengths,
        entries: routes.map((r) => r[r.length - 1]),
        reach: lengths.length > 0 ? Math.max(...lengths) : 0,
    };
}

export function runLength(r: ChannelRun): number {
    return dist(r.a, r.b);
}

// The rect of a run drawn `thickness` wide around its centre line.
export function runRect(r: ChannelRun, thickness: number): ChannelRect {
    const x = Math.min(r.a.x, r.b.x);
    const y = Math.min(r.a.y, r.b.y);
    if (r.axis === "x") {
        return { x, y: r.a.y - thickness / 2, w: runLength(r), h: thickness };
    }
    return { x: r.a.x - thickness / 2, y, w: thickness, h: runLength(r) };
}

function fmt(n: number): string {
    return String(Math.round(n * 10) / 10);
}

// The whole network as one SVG path: a run is a line, an elbow a quadratic curve. Stroked once, so a shared part is
// never drawn twice.
export function networkPath(net: ChannelNetwork): string {
    const parts = net.runs.map((r) => `M${fmt(r.a.x)} ${fmt(r.a.y)}L${fmt(r.b.x)} ${fmt(r.b.y)}`);
    for (const e of net.elbows) {
        parts.push(`M${fmt(e.p0.x)} ${fmt(e.p0.y)}Q${fmt(e.p1.x)} ${fmt(e.p1.y)} ${fmt(e.p2.x)} ${fmt(e.p2.y)}`);
    }
    return parts.join("");
}

export function elbowPath(e: ChannelElbow, origin: ChannelPoint): string {
    const p = (q: ChannelPoint) => `${fmt(q.x - origin.x)} ${fmt(q.y - origin.y)}`;
    return `M${p(e.p0)}Q${p(e.p1)} ${p(e.p2)}`;
}

// ---------- The ambient flow ----------

export function ambientKeyframes(r: ChannelRun): Keyframe[] {
    const axis = r.axis === "x" ? "X" : "Y";
    return [{ transform: `translate${axis}(0px)` }, { transform: `translate${axis}(${r.dir * AmbientFlow.tile}px)` }];
}

export function ambientTiming(): KeyframeAnimationOptions {
    return {
        duration: AmbientFlow.cycleMs,
        iterations: Infinity,
        easing: `steps(${(AmbientFlow.cycleMs / 1000) * AmbientFlow.stepsPerSecond})`,
    };
}

// A loop starts on a whole cycle of the document timeline, so its steps fall on the shared 1/15 s grid; it was not on
// screen before, so the jump cannot show.
export function snappedStart(now: number, cycleMs: number = AmbientFlow.cycleMs): number {
    return Math.floor(now / cycleMs) * cycleMs;
}

type AmbientAnimation = Pick<Animation, "startTime" | "pause" | "cancel" | "playState">;

export function setAmbientMotion(anims: AmbientAnimation[], live: boolean, now: number) {
    for (const a of anims) {
        if (!live) {
            if (a.playState !== "paused") {
                a.pause();
            }
            continue;
        }
        // Setting the start time of a paused animation plays it from there.
        if (a.playState === "paused" || a.startTime == null) {
            a.startTime = snappedStart(now);
        }
    }
}

// ---------- The channel layer ----------

const SvgNs = "http://www.w3.org/2000/svg";

function div(doc: Document, className: string, rect?: ChannelRect): HTMLElement {
    const el = doc.createElement("div");
    el.className = className;
    if (rect != null) {
        el.style.setProperty("left", `${rect.x}px`);
        el.style.setProperty("top", `${rect.y}px`);
        el.style.setProperty("width", `${rect.w}px`);
        el.style.setProperty("height", `${rect.h}px`);
    }
    return el;
}

function svgPaths(doc: Document, className: string, size: { w: number; h: number }, paths: [string, string][]) {
    const svg = doc.createElementNS(SvgNs, "svg");
    svg.setAttribute("class", className);
    svg.setAttribute("width", fmt(size.w));
    svg.setAttribute("height", fmt(size.h));
    for (const [cls, d] of paths) {
        const path = doc.createElementNS(SvgNs, "path");
        path.setAttribute("class", cls);
        path.setAttribute("d", d);
        svg.appendChild(path);
    }
    return svg;
}

export type ChannelElements = {
    groove: Element;
    // The reveal's molten pieces go here; emptied when the reveal ends.
    molten: HTMLElement;
    ambient: HTMLElement;
    ambientAnims: Animation[];
};

function stageNow(doc: Document): number {
    const t = doc.timeline?.currentTime;
    return typeof t === "number" ? t : Number(t ?? 0);
}

export function motionLive(doc: Document): boolean {
    return doc.documentElement?.dataset?.mtMotion !== "still";
}

// Draws the network into the (emptied) layer: the static groove, a container for the reveal's molten, and the ambient
// flow (the bed, still, and a moving tile per long enough run), started on the grid or paused with the view.
export function drawChannels(layer: HTMLElement, net: ChannelNetwork, size: { w: number; h: number }): ChannelElements {
    const doc = layer.ownerDocument;
    layer.replaceChildren();
    const path = networkPath(net);
    const groove = svgPaths(doc, "mt-ch-groove", size, [
        ["mt-ch-lip", path],
        ["mt-ch-cut", path],
    ]);
    const molten = div(doc, "mt-ch-molten");
    const ambient = div(doc, "mt-ch-ambient");
    ambient.appendChild(svgPaths(doc, "mt-ch-bed", size, [["mt-ch-bed-line", path]]));
    const ambientAnims: Animation[] = [];
    const now = stageNow(doc);
    const live = motionLive(doc);
    for (const r of net.runs) {
        if (runLength(r) < ChannelPx.minAmbientRun) {
            continue;
        }
        const len = runLength(r);
        const clip = div(doc, `mt-ch-flow is-${r.axis}${r.dir < 0 ? " is-rev" : ""}`, runRect(r, ChannelPx.core));
        const strip = div(doc, "mt-ch-flow-tile");
        // One tile longer than the run, on the side the flow comes from, so moving by a tile leaves it covered.
        const lead = r.dir > 0 ? -AmbientFlow.tile : 0;
        if (r.axis === "x") {
            strip.style.setProperty("left", `${lead}px`);
            strip.style.setProperty("width", `${len + AmbientFlow.tile}px`);
        } else {
            strip.style.setProperty("top", `${lead}px`);
            strip.style.setProperty("height", `${len + AmbientFlow.tile}px`);
        }
        clip.appendChild(strip);
        ambient.appendChild(clip);
        if (typeof strip.animate === "function") {
            const anim = strip.animate(ambientKeyframes(r), ambientTiming());
            ambientAnims.push(anim);
        }
    }
    layer.append(groove, molten, ambient);
    for (const a of ambientAnims) {
        a.startTime = snappedStart(now);
    }
    setAmbientMotion(ambientAnims, live, now);
    return { groove, molten, ambient, ambientAnims };
}

export function relRect(r: DOMRect, origin: DOMRect): ChannelRect {
    return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
}

export type ChannelsOptions = {
    stage: HTMLElement;
    layer: HTMLElement;
    page: HTMLElement;
    // Re-read at each layout: the open block's chip and the cards.
    chip: () => HTMLElement;
    cards: () => HTMLElement[];
    // Called when the stage changes size, before the network is laid out again (the reveal ends there).
    onRelayout?: () => void;
};

export type ChannelsHandle = {
    net: () => ChannelNetwork;
    elements: () => ChannelElements;
    dispose: () => void;
};

export function readLayout(opts: Pick<ChannelsOptions, "stage" | "page" | "chip" | "cards">): ChannelLayout {
    const origin = opts.stage.getBoundingClientRect();
    const chip = opts.chip();
    const page = relRect(opts.page.getBoundingClientRect(), origin);
    return {
        chip: chip != null ? relRect(chip.getBoundingClientRect(), origin) : { x: page.x + 40, y: 0, w: 0, h: 0 },
        page,
        cards: opts.cards().map((c) => relRect(c.getBoundingClientRect(), origin)),
    };
}

// The channels while a block is open: laid out now, again when the stage changes size, the ambient flow paused while
// the view stands still. dispose() removes everything (block or section changed, library closed, reduced motion or
// the setting off).
export function mountChannels(opts: ChannelsOptions): ChannelsHandle {
    const { stage, layer } = opts;
    const doc = stage.ownerDocument;
    let net: ChannelNetwork = null;
    let els: ChannelElements = null;
    let size = { w: 0, h: 0 };
    let disposed = false;
    const layout = () => {
        const rect = stage.getBoundingClientRect();
        size = { w: rect.width, h: rect.height };
        net = channelNetwork(channelRoutes(readLayout(opts)));
        if (els != null) {
            for (const a of els.ambientAnims) {
                a.cancel();
            }
        }
        els = drawChannels(layer, net, size);
    };
    layout();
    const view = doc.defaultView as Window & typeof globalThis;
    const resize =
        typeof view?.ResizeObserver === "function"
            ? new view.ResizeObserver(() => {
                  const rect = stage.getBoundingClientRect();
                  if (disposed || (Math.abs(rect.width - size.w) < 1 && Math.abs(rect.height - size.h) < 1)) {
                      return;
                  }
                  opts.onRelayout?.();
                  layout();
              })
            : null;
    resize?.observe(stage);
    const motion =
        typeof view?.MutationObserver === "function"
            ? new view.MutationObserver(() => setAmbientMotion(els?.ambientAnims ?? [], motionLive(doc), stageNow(doc)))
            : null;
    motion?.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-mt-motion"] });
    return {
        net: () => net,
        elements: () => els,
        dispose: () => {
            if (disposed) {
                return;
            }
            disposed = true;
            resize?.disconnect();
            motion?.disconnect();
            for (const a of els?.ambientAnims ?? []) {
                a.cancel();
            }
            layer.replaceChildren();
        },
    };
}
