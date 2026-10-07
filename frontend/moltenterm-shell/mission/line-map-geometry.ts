// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The line map in pixels (FR-MC-022, DS-MC-014), from the model of line-map-model.ts: time runs left to right over
// the window up to "now", then a short future holds the route to the next public release. main is the top line,
// develop the one below; branches hang under develop in lanes; stations sit on main with their labels slanted above
// it. Pure and tested: the component only draws what this returns.

import { BuildMarker } from "./line-map-builds";
import { LineMapBranch, LineMapCommit, LineMapModel, LineMapStation } from "./line-map-model";
import { formatDay } from "./time-format";

const Day = 86_400_000;

// Room left of the window for the line names.
const Left = 84;
// main sits this far above develop; lanes start below develop and follow each other.
const LineGap = 130;
const FirstLaneGap = 80;
const LaneGap = 40;
// The horizontal room a branch's curve takes to leave or rejoin develop.
const Curve = 26;
const MinBranchWidth = 20;
// Station spacing on main, and between two labels: two slanted lines (tag, date) need about 28 px across their
// slant, which is 28 / sin(55°) ≈ 34 px along main.
export const StationGap = 34;
export const LabelGap = 34;
// Labels are slanted by this angle (degrees, upward to the right).
export const LabelAngle = 55;
const LabelSin = Math.sin((LabelAngle * Math.PI) / 180);
// The terminus is this far right of now.
const TerminusGap = 110;
const TerminusRadius = 16;
// Ticks keep at least this much room between them.
const MinTickSpacing = 120;
const TickSteps = [1, 2, 7, 14, 30, 60, 90];
// Character widths of the map's monospace text, at 11 px (stations) and 10 px (branches, dates).
const Char11 = 6.6;
const Char10 = 6.0;
const MaxStationLabel = 18;
// The terminus's interface type (IBM Plex Sans), measured in the app with room to spare: the SVG lets text overflow,
// and an underestimate makes the map scroll for a few pixels.
const SansBold20 = 13;
const Sans12 = 7.4;
const Sans11 = 6.8;

export const OverviewMinWidth = 800;
export const FullPxPerDay = 28;
export const OverviewMaxLanes = 5;
export const FullMaxLanes = 12;

export type LineMapGeometryOptions = {
    // The width the pane gives; the map keeps its minimum and scrolls beyond.
    width: number;
    full?: boolean;
};

export type Point = { x: number; y: number };

export type GeometryBranch = {
    branch: LineMapBranch;
    path: string;
    lane: number;
    laneY: number;
    x1: number;
    x2: number;
    // Entered from the left edge: it left develop before the window.
    clipped: boolean;
    label: { x: number; y: number; text: string };
    merge: Point;
    tip: Point;
};

export type GeometryStation = {
    station: LineMapStation;
    x: number;
    y: number;
    r: number;
    label: { x: number; y: number; name: string; date: string };
    connector: string;
    source: Point;
};

// A local build's pill: at its commit on a line (a thin tick down to it), or, when the commit is out of the window, a
// chip at the left edge.
export type GeometryBuild = {
    marker: BuildMarker;
    chip: boolean;
    text: string;
    x: number;
    y: number;
    w: number;
    h: number;
    // The tick from the pill to the line it sits on; null for a chip, which sits on no line.
    tick: { x: number; y1: number; y2: number };
};

export type LandedMark = {
    x: number;
    y: number;
    w: number;
    h: number;
    // The day's start in days mode, the commit's time in commits mode.
    at: number;
    commits: LineMapCommit[];
};

// One tick per commit while they keep this much room on average; past it, one mark per day, its height growing with
// the day's count (square root, so one busy day does not flatten the others).
const MinPxPerCommit = 6;
const TickHeight = 10;
const DayMarkMin = 6;
const DayMarkMax = 18;

export function landedMarks(
    commits: readonly LineMapCommit[],
    xOf: (t: number) => number,
    pxPerDay: number,
    plotWidth: number,
    y: number
): { mode: "commits" | "days"; marks: LandedMark[] } {
    if (commits.length * MinPxPerCommit <= plotWidth) {
        return {
            mode: "commits",
            marks: commits.map((c) => ({ x: xOf(c.at), y, w: 1.5, h: TickHeight, at: c.at, commits: [c] })),
        };
    }
    const byDay = new Map<number, LineMapCommit[]>();
    for (const c of commits) {
        const day = new Date(c.at).setHours(0, 0, 0, 0);
        byDay.set(day, [...(byDay.get(day) ?? []), c]);
    }
    const busiest = Math.max(1, ...[...byDay.values()].map((list) => list.length));
    const w = Math.max(3, Math.min(14, pxPerDay * 0.6));
    const marks = [...byDay.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([day, list]) => ({
            x: xOf(day + Day / 2),
            y,
            w,
            h: DayMarkMin + (DayMarkMax - DayMarkMin) * Math.sqrt(list.length / busiest),
            at: day,
            commits: list,
        }));
    return { mode: "days", marks };
}

export type LineMapGeometry = {
    width: number;
    height: number;
    left: number;
    nowX: number;
    mainY: number;
    devY: number;
    single: boolean;
    ticks: { x: number; label: string; now: boolean }[];
    tickTop: number;
    tickBottom: number;
    main: { x1: number; x2: number; y: number };
    develop: { x1: number; x2: number; y: number };
    future: string;
    route: string;
    branches: GeometryBranch[];
    lanes: number;
    // Branches past the lane cap: not drawn, counted; a merged one still marks where it landed on develop.
    // Merged branches past the lane cap keep a dot where they landed; open ones past it are counted, with their list.
    landings: Point[];
    hidden: { branches: LineMapBranch[]; text: string; x: number; y: number };
    stations: GeometryStation[];
    builds: GeometryBuild[];
    earlier: { x: number; y: number; count: number; label: { x: number; y: number; text: string } };
    // The work that landed on develop: one tick per commit, or one mark per day when the commits would crowd.
    landed: { mode: "commits" | "days"; marks: LandedMark[] };
    // The part of the window before the history read: shaded, with its date.
    unread: { x1: number; x2: number; label: string };
    head: Point;
    terminus: Point & { r: number; title: string; sub: string; status: string; textX: number };
};

function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function tickStep(pxPerDay: number): number {
    return TickSteps.find((s) => s * pxPerDay >= MinTickSpacing) ?? TickSteps[TickSteps.length - 1];
}

// The terminus reads "v<next> · public release", then where it stands: the Project header's chip ("to decide", the
// bump level, "chosen"), with what waits for it when the number follows from the commits.
export function terminusText(model: LineMapModel): { title: string; sub: string; status: string } {
    const t = model.terminus;
    const title = t.tag ?? "next";
    const sub = "public release";
    if (t.state === "nothing" || !t.tag) {
        return { title, sub, status: "nothing to release yet" };
    }
    if (t.state !== "derived") {
        return { title, sub, status: t.chip };
    }
    const waiting = t.waiting === 0 ? "all on main" : `${t.waiting} change${t.waiting === 1 ? "" : "s"} waiting`;
    return { title, sub, status: t.chip ? `${t.chip} · ${waiting}` : waiting };
}

function labelHeight(name: string, date: string): number {
    const length = Math.max(name.length * Char11, date.length * Char10);
    return length * LabelSin + 14;
}

// Stations along main: each at its date, but never closer than the gap to the previous one; pushed back from the
// right edge as a whole when they overflow, and the gap shrinks when even that does not fit.
export function spreadStations(
    wanted: readonly number[],
    min: number,
    max: number,
    gap: number = StationGap
): number[] {
    const n = wanted.length;
    if (n === 0) {
        return [];
    }
    const g = n > 1 ? Math.min(gap, (max - min) / (n - 1)) : gap;
    const out = wanted.map((x) => Math.min(Math.max(x, min), max));
    for (let i = 1; i < n; i++) {
        out[i] = Math.max(out[i], out[i - 1] + g);
    }
    for (let i = n - 1; i >= 0; i--) {
        const limit = i === n - 1 ? max : out[i + 1] - g;
        out[i] = Math.max(min, Math.min(out[i], limit));
    }
    return out;
}

// Which stations keep a label: public releases first, then the latest tag, then the most recent, as long as no label
// lands closer than the label gap to one already kept. The others show their detail on hover.
export function chooseLabels(stations: readonly { x: number; kind: string; latest: boolean; at: number }[]): boolean[] {
    const order = stations
        .map((s, i) => ({ s, i }))
        .sort(
            (a, b) =>
                Number(b.s.kind === "public") - Number(a.s.kind === "public") ||
                Number(b.s.latest) - Number(a.s.latest) ||
                b.s.at - a.s.at
        );
    const kept: number[] = [];
    const rtn = stations.map(() => false);
    for (const { s, i } of order) {
        if (kept.every((x) => Math.abs(x - s.x) >= LabelGap)) {
            kept.push(s.x);
            rtn[i] = true;
        }
    }
    return rtn;
}

type LaneItem = { start: number; end: number; labelStart: number };

// Greedy first fit: a branch takes the first lane free at its start, its label counted in. Past the lane cap it is
// not drawn (-1): branches piled on shared lanes read as one grey mass, and the hover, a shorter window or the full
// size show them instead.
export function assignLanes(items: readonly LaneItem[], maxLanes: number): number[] {
    const ends: number[] = [];
    return items.map((item) => {
        let lane = ends.findIndex((end) => end <= item.start);
        if (lane < 0 && ends.length < maxLanes) {
            lane = ends.length;
            ends.push(-Infinity);
        }
        if (lane < 0) {
            return -1;
        }
        ends[lane] = item.end;
        return lane;
    });
}

function branchPath(x1: number, x2: number, devY: number, laneY: number, clipped: boolean, open: boolean): string {
    const c = Math.min(Curve, (x2 - x1) / 2);
    const leave = clipped
        ? `M ${x1} ${laneY}`
        : `M ${x1} ${devY} C ${x1 + c * 0.7} ${devY} ${x1 + c * 0.25} ${laneY} ${x1 + c} ${laneY}`;
    if (open) {
        return `${leave} L ${x2} ${laneY}`;
    }
    return `${leave} L ${x2 - c} ${laneY} C ${x2 - c * 0.25} ${laneY} ${x2 - c * 0.7} ${devY} ${x2} ${devY}`;
}

function connectorPath(sx: number, x: number, devY: number, mainY: number): string {
    const dx = x - sx;
    if (dx >= 24) {
        const k = Math.min(20, dx * 0.6);
        return `M ${sx} ${devY} C ${sx + k} ${devY} ${x - k} ${mainY} ${x} ${mainY}`;
    }
    const h = (devY - mainY) / 2;
    return `M ${sx} ${devY} C ${sx} ${devY - h} ${x} ${mainY + h} ${x} ${mainY}`;
}

const BuildPillHeight = 16;
const BuildPillGap = 18;
const BuildPillPad = 14;
// Between a pill and the line it sits on, room for the tick.
const BuildTickLength = 14;

export function buildText(m: BuildMarker): string {
    switch (m.place) {
        case "develop":
        case "main":
            return m.label;
        case "unknown":
            return `${m.label} · commit not found`;
    }
    if (m.behind == null) {
        return `${m.label} ← before the window`;
    }
    const count = `${m.behind}${m.behindCapped ? "+" : ""}`;
    return `${m.label} ← ${count} commit${m.behind === 1 && !m.behindCapped ? "" : "s"} behind`;
}

// The builds' pills and chips. Those on develop (and the chips) stand above it, those on main under it; a pill that
// would overlap one beside it goes one row further from its line.
export function layoutBuilds(
    markers: readonly BuildMarker[],
    o: { xOf: (t: number) => number; left: number; mainY: number; devY: number; single: boolean }
): GeometryBuild[] {
    const drafts = markers.map((marker) => {
        const text = buildText(marker);
        const w = Math.round(text.length * Char10 + BuildPillPad);
        const chip = marker.place !== "develop" && marker.place !== "main";
        const x = Math.max(chip ? 0 : o.xOf(marker.at), o.left + 4 + w / 2);
        return { marker, chip, text, x, w, onMain: marker.place === "main" };
    });
    const rows = new Map<boolean, number[]>();
    return drafts
        .sort((a, b) => a.x - b.x)
        .map((d) => {
            const ends = rows.get(d.onMain) ?? [];
            const left = d.x - d.w / 2;
            let row = ends.findIndex((end) => end + 6 <= left);
            if (row < 0) {
                row = ends.length;
            }
            ends[row] = left + d.w;
            rows.set(d.onMain, ends);
            // With no main above develop, the pills hang under it, where nothing is written.
            const below = d.onMain || o.single;
            const lineY = d.onMain ? o.mainY : o.devY;
            const y = below
                ? lineY + BuildTickLength + row * BuildPillGap
                : lineY - BuildTickLength - BuildPillHeight - row * BuildPillGap;
            return {
                marker: d.marker,
                chip: d.chip,
                text: d.text,
                x: left,
                y,
                w: d.w,
                h: BuildPillHeight,
                tick: d.chip ? null : { x: o.xOf(d.marker.at), y1: below ? y : y + BuildPillHeight, y2: lineY },
            };
        });
}

export function branchLabel(branch: LineMapBranch, full: boolean): string {
    const name = truncate(branch.name, full ? 32 : 24);
    if (branch.state !== "open") {
        return name;
    }
    const count = `${branch.count}${branch.countCapped ? "+" : ""} commit${branch.count === 1 ? "" : "s"}`;
    return [name, count, branch.prNumber ? `PR #${branch.prNumber}` : null].filter(Boolean).join(" · ");
}

export function layoutLineMap(model: LineMapModel, o: LineMapGeometryOptions): LineMapGeometry {
    const single = model.release == null;
    const { title, sub, status } = terminusText(model);
    const right =
        TerminusGap +
        TerminusRadius +
        10 +
        Math.max(title.length * SansBold20, sub.length * Sans12, status.length * Sans11) +
        20;
    const minWidth = o.full ? Left + model.days * FullPxPerDay + right : OverviewMinWidth;
    const width = Math.round(Math.max(o.width || 0, minWidth));
    const nowX = Math.round(width - right);
    const span = Math.max(1, model.now - model.start);
    const xOf = (t: number) =>
        Left + ((Math.min(Math.max(t, model.start), model.now) - model.start) / span) * (nowX - Left);
    const maxLanes = o.full ? FullMaxLanes : OverviewMaxLanes;

    // Stations and their labels decide how much room main needs above it.
    const earlierCount = model.earlier.length;
    const minStationX = Left + (earlierCount ? StationGap : 0);
    const xs = spreadStations(
        model.stations.map((s) => xOf(s.at)),
        minStationX,
        nowX
    );
    const placed = model.stations.map((s, i) => ({ s, x: xs[i] }));
    const labelled = chooseLabels(placed.map(({ s, x }) => ({ x, kind: s.kind, latest: s.latest, at: s.at })));
    const labelTexts = placed.map(({ s }) => ({ name: truncate(s.name, MaxStationLabel), date: formatDay(s.at) }));
    const earlierText = earlierCount ? `${earlierCount} earlier` : "";
    const tallest = Math.max(
        40,
        ...labelTexts.filter((_, i) => labelled[i]).map((t) => labelHeight(t.name, t.date)),
        earlierCount ? labelHeight(earlierText, "") : 0
    );
    const mainY = Math.round(Math.min(150, tallest + 24));
    const devY = single ? mainY : mainY + LineGap;

    // Branches, in lanes under develop.
    const drafts = model.branches.map((b) => {
        const open = b.state === "open";
        const clipped = b.fork < model.start;
        let x2 = open ? nowX : xOf(b.merge);
        let x1 = clipped ? Left : xOf(b.fork);
        if (x2 - x1 < MinBranchWidth) {
            x1 = Math.max(Left, x2 - MinBranchWidth);
            x2 = Math.max(x2, x1 + MinBranchWidth);
        }
        const labelStart = open ? nowX + 12 : x1 + Curve + 4;
        // An open branch's label runs into the future, up to the map's right edge.
        const fits = Math.max(8, Math.floor((width - labelStart - 8) / Char10));
        const text = open ? truncate(branchLabel(b, !!o.full), fits) : branchLabel(b, !!o.full);
        const end = open ? Infinity : Math.max(x2, labelStart + text.length * Char10) + 10;
        return { b, open, clipped, x1, x2, text, labelStart, end };
    });
    const lanes = assignLanes(
        drafts.map((d) => ({ start: d.x1, end: d.end, labelStart: d.labelStart })),
        maxLanes
    );
    const laneY = (k: number) => devY + FirstLaneGap + k * LaneGap;
    const branches: GeometryBranch[] = [];
    const hidden: LineMapBranch[] = [];
    drafts.forEach((d, i) => {
        const lane = lanes[i];
        if (lane < 0) {
            hidden.push(d.b);
            return;
        }
        const y = laneY(lane);
        branches.push({
            branch: d.b,
            path: branchPath(d.x1, d.x2, devY, y, d.clipped, d.open),
            lane,
            laneY: y,
            x1: d.x1,
            x2: d.x2,
            clipped: d.clipped,
            label: d.open ? { x: d.labelStart, y: y + 4, text: d.text } : { x: d.labelStart, y: y + 18, text: d.text },
            merge: d.open ? null : { x: d.x2, y: devY },
            tip: d.open ? { x: d.x2, y } : null,
        });
    });
    const laneCount = branches.length ? Math.max(...branches.map((b) => b.lane)) + 1 : 0;
    const hiddenOpen = hidden.filter((b) => b.state === "open");
    // The open branches past the cap are counted on the row under the last lane, beside the open tips at now.
    const hiddenY = laneY(laneCount);
    const builds = layoutBuilds(model.builds ?? [], { xOf, left: Left, mainY, devY, single });
    const underDevelop = builds.filter((b) => b.y > devY).map((b) => b.y + b.h);
    const lowest = Math.max(
        hiddenOpen.length ? hiddenY + 12 : laneCount ? laneY(laneCount - 1) + 26 : devY + 30,
        ...underDevelop
    );
    const tickBottom = Math.round(lowest + 8);
    const height = tickBottom + 22;

    const stations: GeometryStation[] = placed.map(({ s, x }, i) => {
        const r = s.kind === "public" ? 9 : 6;
        const sourceX = s.source ? xOf(s.source.at) : x;
        return {
            station: s,
            x,
            y: mainY,
            r,
            label: labelled[i] ? { x: x + 3, y: mainY - r - 8, ...labelTexts[i] } : null,
            connector: single ? null : connectorPath(sourceX, x, devY, mainY),
            source: single ? null : { x: sourceX, y: devY },
        };
    });

    const pxPerDay = (nowX - Left) / Math.max(1, model.days);
    const step = tickStep(pxPerDay);
    const ticks: LineMapGeometry["ticks"] = [{ x: nowX, label: "now", now: true }];
    for (let k = 1; model.now - k * step * Day >= model.start - 60_000; k++) {
        const t = model.now - k * step * Day;
        ticks.push({ x: xOf(t), label: formatDay(t), now: false });
    }
    ticks.reverse();

    const termX = nowX + TerminusGap;
    const route = single
        ? `M ${nowX} ${devY} L ${termX - TerminusRadius} ${devY}`
        : `M ${nowX} ${devY} C ${nowX + 90} ${devY} ${termX - 84} ${mainY} ${termX - TerminusRadius} ${mainY}`;

    return {
        width,
        height,
        left: Left,
        nowX,
        mainY,
        devY,
        single,
        ticks,
        tickTop: Math.max(8, mainY - 40),
        tickBottom,
        main: { x1: Left, x2: nowX, y: mainY },
        develop: { x1: Left, x2: nowX, y: devY },
        future: single ? null : `M ${nowX} ${mainY} L ${termX - TerminusRadius} ${mainY}`,
        route,
        branches,
        lanes: laneCount,
        landings: hidden.filter((b) => b.state === "merged").map((b) => ({ x: xOf(b.merge), y: devY })),
        hidden: hiddenOpen.length
            ? {
                  branches: hiddenOpen,
                  text: `+${hiddenOpen.length} open branch${hiddenOpen.length === 1 ? "" : "es"}`,
                  x: nowX + 12,
                  y: hiddenY + 4,
              }
            : null,
        stations,
        builds,
        earlier: earlierCount
            ? {
                  x: Left,
                  y: mainY,
                  count: earlierCount,
                  label: { x: Left + 3, y: mainY - 14, text: earlierText },
              }
            : null,
        landed: landedMarks(model.commits, xOf, pxPerDay, nowX - Left, devY),
        unread:
            model.historyFrom != null
                ? { x1: Left, x2: xOf(model.historyFrom), label: `history read from ${formatDay(model.historyFrom)}` }
                : null,
        head: { x: nowX, y: devY },
        terminus: {
            x: termX,
            y: mainY,
            r: TerminusRadius,
            title,
            sub,
            status,
            textX: termX + TerminusRadius + 10,
        },
    };
}
