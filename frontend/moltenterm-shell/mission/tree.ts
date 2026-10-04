// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The branches as a tree (FR-MC-002), ported from Notulia's Dev › Timeline (src/lib/devTree.ts). Time runs upward:
// the bottom is the window's start, the top is now. The trunk branch (where work is merged) is the trunk, tapering as
// it rises; the release branch is a vine along it, carrying the releases; every other branch is a limb from the trunk,
// where it left it, up to its last commit, with a card at the edge. Moltenterm takes both branch names from the
// project instead of fixing them to develop and main.

export const DefaultTagPrefix = "v";

// A release candidate is a version with a suffix (v1.2.0-3), as in Notulia, read after the project's tag prefix (which
// may itself hold a dash, as release-1.2.0).
export function isPrereleaseTag(name: string, prefix: string = DefaultTagPrefix): boolean {
    return (name.startsWith(prefix) ? name.slice(prefix.length) : name).includes("-");
}

export interface RawCommit {
    sha: string;
    date: string;
    subject: string;
}

export interface RawBranch {
    name: string;
    sha: string;
    date: string;
    commits: RawCommit[];
    fork: { sha: string; date: string } | null;
}

export interface RawTag {
    name: string;
    sha: string;
    date: string;
    notes: string | null;
    notesInternal: string | null;
}

export interface TreeData {
    branches: RawBranch[];
    tags: RawTag[];
    /** The branch work is merged into (develop in a git-flow project). */
    trunk: string;
    /** The branch releases are cut from (main); the same as the trunk in a single-branch project. */
    release: string;
    /** The project's release tags start with it (versions.tagprefix). */
    tagPrefix?: string;
    /** versions.firstpublic: tags below its first candidate are not the project's releases. */
    firstPublic?: string;
}

export interface TreeOptions {
    now: Date;
    days: number;
    width: number;
    height: number;
    /** A card's size, to keep them apart. */
    card: { width: number; height: number };
}

export interface TreeNode {
    x: number;
    y: number;
    sha: string;
    subject: string;
    date: string;
}

export interface Limb {
    name: string;
    side: -1 | 1;
    /** The limb itself, an SVG path from the trunk to the tip. */
    path: string;
    tip: { x: number; y: number };
    nodes: TreeNode[];
    /** The card's top-left corner, and where its dashed line lands on it. */
    card: { x: number; y: number; anchorX: number; anchorY: number };
    commits: number;
    last: RawCommit | null;
    /** The order it grows in, for the animation. */
    order: number;
}

export interface Release {
    name: string;
    x: number;
    y: number;
    /** A pre-release (vX.Y.Z-N), shown lighter than a public one. */
    rc: boolean;
    date: string;
    notes: string | null;
}

export interface TreeLayout {
    cx: number;
    top: number;
    bottom: number;
    /** The trunk, a closed shape (it tapers). */
    trunk: string;
    trunkNodes: TreeNode[];
    vine: string;
    releaseNodes: TreeNode[];
    releases: Release[];
    limbs: Limb[];
    /** Faint guides, one per week, with the date. */
    weeks: { y: number; date: Date }[];
    /** A few roots spreading from the trunk's base. */
    roots: string[];
    start: Date;
}

const DAY = 86_400_000;
const TRUNK_BASE = 15;
/** Time is not drawn evenly: the recent days get the room (a power above 1
 *  spreads the top — now — and packs the past toward the base, like wood). */
const TIME_CURVE = 1.7;
const TRUNK_TOP = 3;
const VINE_OFFSET = 26;

/** A point on a cubic Bezier at `t`. */
function bezier(p: number[][], t: number): [number, number] {
    const u = 1 - t;
    const a = u * u * u,
        b = 3 * u * u * t,
        c = 3 * u * t * t,
        d = t * t * t;
    return [
        a * p[0][0] + b * p[1][0] + c * p[2][0] + d * p[3][0],
        a * p[0][1] + b * p[1][1] + c * p[2][1] + d * p[3][1],
    ];
}

/**
 * Cards on one side, top to bottom, never overlapping: each goes to its tip's
 * height, or just below the previous card — and past any `obstacle` (a band
 * something else occupies, like a release's label); if the column runs off
 * the bottom, it is pushed back up as a whole.
 */
export function stackCards(
    wanted: number[],
    height: number,
    gap: number,
    top: number,
    bottom: number,
    obstacles: readonly (readonly [number, number])[] = []
): number[] {
    const order = wanted.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
    const placed: number[] = [];
    let next = top;
    for (const { y } of order) {
        let at = Math.max(y, next);
        for (let moved = true; moved; ) {
            moved = false;
            for (const [from, to] of obstacles) {
                if (at < to && at + height > from) {
                    at = to + gap;
                    moved = true;
                }
            }
        }
        placed.push(at);
        next = at + height + gap;
    }
    const overflow = placed.length ? placed[placed.length - 1] + height - bottom : 0;
    if (overflow > 0) {
        for (let k = placed.length - 1; k >= 0; k--) {
            const limit = k === placed.length - 1 ? bottom - height : placed[k + 1] - height - gap;
            placed[k] = Math.max(top, Math.min(placed[k] - overflow, limit));
        }
    }
    const out = new Array<number>(wanted.length);
    order.forEach(({ i }, k) => (out[i] = placed[k]));
    return out;
}

export function layoutTree(data: TreeData, o: TreeOptions): TreeLayout {
    const top = 70;
    const bottom = o.height - 16;
    const cx = o.width / 2;
    const start = new Date(o.now.getTime() - o.days * DAY);
    const span = o.now.getTime() - start.getTime();
    const yOf = (date: string | Date) => {
        const t = Math.min(Math.max(new Date(date).getTime(), start.getTime()), o.now.getTime());
        return bottom - Math.pow((t - start.getTime()) / span, TIME_CURVE) * (bottom - top);
    };
    const inView = (date: string) => new Date(date) >= start;

    // A trunk that sways a little, tapering from its base to now.
    const sway = (y: number) => Math.sin((y / (bottom - top)) * Math.PI * 1.6) * 5;
    const halfWidth = (y: number) => TRUNK_TOP + ((y - top) / (bottom - top)) * (TRUNK_BASE - TRUNK_TOP);
    const steps = 24;
    const left: string[] = [];
    const right: string[] = [];
    for (let k = 0; k <= steps; k++) {
        const y = bottom - (k / steps) * (bottom - top);
        left.push(`${(cx + sway(y) - halfWidth(y)).toFixed(1)},${y.toFixed(1)}`);
        right.unshift(`${(cx + sway(y) + halfWidth(y)).toFixed(1)},${y.toFixed(1)}`);
    }
    const trunk = `M ${left.join(" L ")} L ${right.join(" L ")} Z`;
    const trunkX = (y: number) => cx + sway(y);

    const find = (name: string) => data.branches.find((b) => b.name === name);
    const trunkNodes = (find(data.trunk)?.commits ?? [])
        .filter((c) => inView(c.date))
        .map((c) => {
            const y = yOf(c.date);
            return { x: trunkX(y), y, sha: c.sha, subject: c.subject, date: c.date };
        });

    // The release branch winds along the trunk's left.
    const vineX = (y: number) => trunkX(y) - VINE_OFFSET + Math.sin(y / 38) * 4;
    const releaseTip = data.release !== data.trunk ? find(data.release) : null;
    const vineTop = releaseTip ? yOf(releaseTip.date) : bottom;
    const vinePoints: string[] = [];
    for (let y = bottom; y >= vineTop; y -= 6) vinePoints.push(`${vineX(y).toFixed(1)},${y.toFixed(1)}`);
    vinePoints.push(`${vineX(vineTop).toFixed(1)},${vineTop.toFixed(1)}`);
    const vine = `M ${vinePoints.join(" L ")}`;
    const releaseNodes = (releaseTip?.commits ?? [])
        .filter((c) => inView(c.date))
        .map((c) => {
            const y = yOf(c.date);
            return { x: vineX(y), y, sha: c.sha, subject: c.subject, date: c.date };
        });
    const releases: Release[] = data.tags
        .filter((t) => inView(t.date))
        .map((t) => {
            const y = yOf(t.date);
            return {
                name: t.name,
                x: vineX(y),
                y,
                rc: isPrereleaseTag(t.name, data.tagPrefix),
                date: t.date,
                notes: t.notes ?? t.notesInternal,
            };
        });

    // Limbs: right first (the release branch already dresses the left), then alternating;
    // each side reaches a little further for each limb, so tips do not stack.
    const others = data.branches
        .filter((b) => b.name !== data.release && b.name !== data.trunk)
        .sort((a, b) => new Date(a.fork?.date ?? a.date).getTime() - new Date(b.fork?.date ?? b.date).getTime());
    const reach = Math.max(60, o.width / 2 - o.card.width - 36);
    const rank = { 1: 0, [-1]: 0 } as Record<number, number>;
    const drafts = others.map((b, i) => {
        const side: -1 | 1 = i % 2 === 0 ? 1 : -1;
        const k = rank[side]++;
        const dx = Math.min(reach, 46 + (k % 4) * ((reach - 46) / 3));
        const forkY = yOf(b.fork?.date ?? start);
        // A limb always rises a little, even when its first commit is minutes
        // after the fork: a limb flat on the trunk reads as nothing.
        const tipY = Math.min(yOf(b.date), forkY - 36);
        const sx = trunkX(forkY) + side * TRUNK_TOP;
        const tipX = cx + side * dx;
        const pts = [
            [sx, forkY],
            [sx + side * dx * 0.35, forkY - 6],
            [tipX - side * dx * 0.15, tipY + (forkY - tipY) * 0.55],
            [tipX, tipY],
        ];
        const t0 = new Date(b.fork?.date ?? b.date).getTime();
        const t1 = Math.max(new Date(b.date).getTime(), t0 + 1);
        const nodes = b.commits
            .filter((c) => inView(c.date))
            .map((c) => {
                const u = Math.min(1, Math.max(0.12, (new Date(c.date).getTime() - t0) / (t1 - t0)));
                const [x, y] = bezier(pts, u);
                return { x, y, sha: c.sha, subject: c.subject, date: c.date };
            });
        const path = `M ${pts[0].join(",")} C ${pts[1].join(",")} ${pts[2].join(",")} ${pts[3].join(",")}`;
        return { b, side, tipX, tipY, nodes, path, order: i };
    });

    const cardYs: Record<number, number[]> = { 1: [], [-1]: [] };
    // The left column shares its side with the release labels: its cards
    // step around them rather than cover them.
    const releaseBands = releases.map((r) => [r.y - 13, r.y + 13] as const);
    for (const side of [1, -1] as const) {
        const mine = drafts.filter((d) => d.side === side);
        const ys = stackCards(
            mine.map((d) => d.tipY - o.card.height / 2),
            o.card.height,
            10,
            top - 40,
            bottom,
            side === -1 ? releaseBands : []
        );
        cardYs[side] = ys;
    }
    const seen = { 1: 0, [-1]: 0 } as Record<number, number>;
    const limbs: Limb[] = drafts.map((d) => {
        const y = cardYs[d.side][seen[d.side]++];
        const x = d.side === 1 ? o.width - o.card.width - 8 : 8;
        return {
            name: d.b.name,
            side: d.side,
            path: d.path,
            tip: { x: d.tipX, y: d.tipY },
            nodes: d.nodes,
            card: { x, y, anchorX: d.side === 1 ? x : x + o.card.width, anchorY: y + o.card.height / 2 },
            commits: d.b.commits.length,
            last: d.b.commits[0] ?? null,
            order: d.order,
        };
    });

    const weeks: TreeLayout["weeks"] = [];
    const monday = new Date(start);
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7));
    for (let d = monday; d <= o.now; d = new Date(d.getTime() + 7 * DAY)) weeks.push({ y: yOf(d), date: d });

    const base = trunkX(bottom);
    const roots = [-1, 1, -0.55, 0.55].map((dir, i) => {
        const reachX = base + dir * (40 + i * 14);
        return `M ${base.toFixed(1)},${(bottom - 18).toFixed(1)} C ${(base + dir * 10).toFixed(1)},${(bottom - 4).toFixed(1)} ${(reachX - dir * 12).toFixed(1)},${(bottom + 2).toFixed(1)} ${reachX.toFixed(1)},${(bottom + 10).toFixed(1)}`;
    });

    return { cx, top, bottom, trunk, trunkNodes, vine, releaseNodes, releases, limbs, weeks, roots, start };
}
