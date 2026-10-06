// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The line map (FR-MC-022, DS-MC-014): one inline SVG, time left to right, main on top, develop in the molten accent,
// the branches under it, every version tag a station on main, and the route to the next public release. The data
// is line-map-model.ts, the pixels line-map-geometry.ts; this file only draws and explains. Hovering or focusing a
// mark opens its detail (portalled, so no pane edge clips it); clicking opens it on GitHub.
//
// The motion (FR-MC-023, DS-MC-015) is CSS only, keyed on the frame's data-motion / data-intro / data-paused and on
// the SVG's data-ci, so nothing re-renders while it moves; line-map-motion.ts holds its logic. An infinite animation
// never shares an element with a load-sequence one (the sequence fades a wrapper instead): when the sequence ends and
// its rules stop matching, a glint or a dash must not jump.

import { atoms, openLink } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { checkWebUrl } from "../project/project-model";
import { ciVerdictView } from "../status-bar-model";
import { CiBranch } from "./ci-model";
import { plainText } from "./github";
import { GeometryBranch, GeometryStation, layoutLineMap, LineMapGeometry } from "./line-map-geometry";
import {
    buildLineMap,
    commitUrl,
    FullLineMapDayChoices,
    gitFingerprint,
    LineMapBranch,
    LineMapCommit,
    LineMapDayChoices,
    LineMapModel,
    LineMapStation,
    prsFingerprint,
} from "./line-map-model";
import {
    delayStyle,
    initialIntro,
    introDelay,
    IntroEvent,
    IntroGlints,
    IntroHead,
    IntroLength,
    IntroLineDraw,
    IntroPulse,
    IntroRoute,
    introStep,
    IntroTerminus,
    IntroTerminusText,
    motionAttrs,
} from "./line-map-motion";
import { useLineMapDays } from "./line-map-store";
import { MenuPopover } from "./menu-popover";
import { MissionSnapshot } from "./mission-model";
import { ReleaseSession } from "./release-model";
import { formatDay, formatWhen, timeAgo } from "./time-format";
import { readableSubject } from "./versions";

const HideDelay = 160;
// Every continuous motion moves in steps, by opacity or by an HTML transform. Measured in the app: a smooth animation,
// even a composited opacity one, makes Chromium draw a frame at every display refresh (15 to 20% of a core for one
// blinking dot), and a dashoffset or SVG transform animation restyles and repaints the whole SVG every frame. A stepped
// opacity animation, or a stepped transform on an HTML element, runs on the compositor and draws a frame only when a
// step changes. Every step below falls on one 0.25 s grid, so the whole map wakes at most four times a second while
// CI is idle.
// The glints: a light every GlintPeriod pixels along the line, moved forward in GlintSteps steps of 5 px per cycle.
const GlintPeriod = 160;
const GlintSteps = 32;
// Seconds per glint cycle: 20 px/s, and 80 px/s on develop while CI runs there.
const GlintCycle = 8;
const GlintCycleCi = 2;
// The route's dash pattern (6 on, 8 off) and its march: three copies a third of a period apart, 0.25 s each.
const RouteDash = 14;
const RouteEchoes = [0, 1, 2];
const RouteCycle = 0.75;
// The head's pulse: rings growing outward, each lit for 0.25 s, then a rest.
const PulseRings = [
    { r: 12, opacity: 0.7 },
    { r: 15.5, opacity: 0.45 },
    { r: 19, opacity: 0.25 },
];
const PulseStep = 0.25;
const PulseCycle = 2.5;
const BlinkCycle = 1.5;

// A copy's opacity over one cycle of a chase: on for its share, then off, in one step each (step-end timing), so the
// copies hand the light over one to the next.
function chaseKeyframes(name: string, copies: number): string {
    const share = (100 / copies).toFixed(3);
    return `@keyframes ${name} { 0% { opacity: 1; } ${share}% { opacity: 0; } 100% { opacity: 0; } }`;
}
const CommitsListed = 6;
const EarlierListed = 8;

const Styles = `
.lm-svg { display: block; overflow: visible; font-family: var(--font-mono); }
.lm-svg text { user-select: none; }
.lm-tick { stroke: var(--color-border); stroke-width: 1; }
.lm-ticktxt { font-size: 11px; fill: var(--color-muted); }
.lm-ticktxt-now { fill: var(--color-secondary); }
.lm-line-name { font-family: var(--font-sans); font-weight: 700; font-size: 14px; letter-spacing: .03em; }
.lm-main { fill: none; stroke: var(--color-primary); stroke-opacity: .38; stroke-width: 4; stroke-linecap: round; }
.lm-dev { fill: none; stroke: var(--color-accent); stroke-width: 6; stroke-linecap: round; }
.lm-future { fill: none; stroke: var(--color-primary); stroke-opacity: .35; stroke-width: 3; stroke-dasharray: 4 7; }
.lm-route { fill: none; stroke: var(--color-accent); stroke-width: 3; stroke-dasharray: 6 8; }
.lm-br { fill: none; stroke: color-mix(in srgb, var(--color-muted) 80%, var(--color-background)); stroke-width: 2.5; stroke-linecap: round; }
.lm-br-open { fill: none; stroke: color-mix(in srgb, var(--color-accent) 55%, white); stroke-width: 3; stroke-linecap: round; }
.lm-br-guess { stroke-dasharray: 2 4; }
.lm-hitline { fill: none; stroke: transparent; stroke-width: 14; pointer-events: stroke; }
.lm-hitdot { fill: transparent; }
.lm-merge { fill: color-mix(in srgb, var(--color-muted) 80%, var(--color-background)); }
.lm-landed { fill: color-mix(in srgb, var(--color-accent) 30%, var(--color-primary)); fill-opacity: .55; }
.lm-hit:hover .lm-landed { fill-opacity: 1; }
.lm-rc { fill: none; stroke: var(--color-primary); stroke-opacity: .45; stroke-width: 2; stroke-linecap: round; }
.lm-fork { fill: var(--color-primary); fill-opacity: .6; }
.lm-st { fill: var(--color-background); stroke: var(--color-primary); stroke-width: 2.5; }
.lm-st-public { stroke: var(--color-accent); stroke-width: 3.5; }
.lm-earlier { fill: var(--color-background); stroke: var(--color-muted); stroke-width: 2; stroke-dasharray: 3 2; }
.lm-unread { fill: var(--color-hover); }
.lm-stlabel, .lm-brlabel, .lm-livelabel, .lm-ticktxt { paint-order: stroke; stroke: var(--color-background); stroke-width: 3px; stroke-linejoin: round; }
.lm-stlabel { font-size: 11px; font-weight: 500; fill: var(--color-primary); }
.lm-stlabel-latest { fill: var(--color-accent); }
.lm-stdate { font-size: 10px; font-weight: 400; fill: var(--color-muted); }
.lm-brlabel { font-size: 10px; fill: var(--color-muted); }
.lm-livelabel { font-size: 10px; fill: color-mix(in srgb, var(--color-accent) 55%, white); }
.lm-tip { fill: color-mix(in srgb, var(--color-accent) 55%, white); }
.lm-head { fill: var(--color-accent); }
.lm-term { fill: var(--color-background); stroke: var(--color-accent); stroke-width: 3; }
.lm-termcore { fill: var(--color-accent); }
.lm-termtxt { font-family: var(--font-sans); font-weight: 700; font-size: 20px; fill: var(--color-primary); }
.lm-termsub { font-family: var(--font-sans); font-size: 12px; fill: var(--color-secondary); }
.lm-termstatus { font-family: var(--font-sans); font-size: 11px; fill: var(--color-muted); }
.lm-hit { outline: none; }
.lm-hit:focus-visible .lm-focus { stroke: var(--color-accent); stroke-width: 2; stroke-dasharray: 3 2; fill: none; }
.lm-hit .lm-focus { fill: none; stroke: none; }
.lm-hit:hover .lm-br, .lm-hit:focus-visible .lm-br { stroke: var(--color-secondary); }
.lm-hit:hover .lm-st, .lm-hit:focus-visible .lm-st { fill: color-mix(in srgb, var(--color-accent) 25%, var(--color-background)); }
.lm-plot { position: relative; }
.lm-flows { position: absolute; inset: 0; pointer-events: none; }
.lm-pulse { pointer-events: none; }
.lm-glints { position: absolute; overflow: hidden; border-radius: 3px; }
.lm-glint-band {
    position: absolute; top: 0; bottom: 0; left: -${GlintPeriod}px; right: 0;
    background: repeating-linear-gradient(90deg, transparent 0 ${GlintPeriod - 12}px, color-mix(in srgb, var(--color-accent) 12%, white) ${GlintPeriod - 6}px, transparent ${GlintPeriod}px);
}
.lm-glints-dev { opacity: .55; }
.lm-glints-main { opacity: .32; }
.lm-ring { fill: none; stroke: var(--color-accent); stroke-width: 1.5; opacity: 0; }
.lm-route-echo { display: none; }
.lm-clock { fill: none; }
.lm-cibadge { display: none; pointer-events: none; }
.lm-cibadge rect { fill: var(--color-background); stroke: var(--color-accent); stroke-width: 1.5; }
.lm-cibadge circle { fill: var(--color-accent); }
.lm-cibadge text { font-size: 10px; font-weight: 500; fill: var(--color-accent); }
`;

// The load sequence: only while the frame says so, and only with motion on.
const Intro = `.lm-frame[data-motion="full"][data-intro="play"]`;
// The continuous motion, with motion on.
const Moving = `.lm-frame[data-motion="full"]`;

export const MotionStyles = `
${Intro} .lm-main, ${Intro} .lm-dev { stroke-dasharray: 1; animation: lm-draw ${IntroLineDraw}s cubic-bezier(.45,.05,.55,.95) both; }
${Intro} .lm-rc { stroke-dasharray: 1; animation: lm-draw .45s ease-out var(--lm-d, 0s) both; }
${Intro} .lm-br:not(.lm-br-guess) { stroke-dasharray: 1; animation: lm-draw .6s ease-out var(--lm-d, 0s) both; }
${Intro} .lm-br-guess { animation: lm-fade .6s ease-out var(--lm-d, 0s) both; }
${Intro} .lm-br-open { stroke-dasharray: 1; animation: lm-draw .7s ease-out var(--lm-d, 0s) both; }
${Intro} .lm-st, ${Intro} .lm-merge, ${Intro} .lm-fork, ${Intro} .lm-head, ${Intro} .lm-term {
    transform-box: fill-box; transform-origin: center; animation: lm-pop .35s cubic-bezier(.3,1.6,.5,1) var(--lm-d, 0s) both;
}
${Intro} .lm-landed, ${Intro} .lm-stlabel, ${Intro} .lm-brlabel, ${Intro} .lm-livelabel, ${Intro} .lm-wrap {
    animation: lm-fade .4s ease var(--lm-d, 0s) both;
}
${Intro} .lm-flows { animation: lm-fade 1s ease var(--lm-d, 0s) both; }
${Intro} .lm-clock { animation: lm-clock ${IntroLength}s linear both; }
${Moving} .lm-glint-band { animation: lm-glide ${GlintCycle}s steps(${GlintSteps}) infinite; }
${Moving} .lm-plot[data-ci="running"] .lm-glints-dev { opacity: .9; }
${Moving} .lm-plot[data-ci="running"] .lm-glints-dev .lm-glint-band { animation-duration: ${GlintCycleCi}s; }
${Moving} .lm-route-echo { display: inline; animation: lm-chase ${RouteCycle}s step-end infinite; }
${RouteEchoes.map((k) => `${Moving} .lm-route-echo-${k} { stroke-dashoffset: ${(-(k * RouteDash) / RouteEchoes.length).toFixed(2)}; animation-delay: ${((k * RouteCycle) / RouteEchoes.length - RouteCycle).toFixed(3)}s; }`).join("\n")}
${Moving} .lm-route-base { display: none; }
${Moving} .lm-ring { animation: lm-ripple ${PulseCycle}s step-end calc(var(--lm-k) * ${PulseStep}s) infinite; }
${Moving} .lm-tip { animation: lm-blink ${BlinkCycle}s step-end infinite; }
.lm-frame[data-paused="true"] .lm-plot * { animation-play-state: paused !important; }
.lm-frame[data-motion="reduce"] .lm-flows, .lm-frame[data-motion="reduce"] .lm-pulse { display: none; }
.lm-frame[data-motion="reduce"] .lm-cibadge { display: inline; }
@keyframes lm-draw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
@keyframes lm-fade { from { opacity: 0; } }
@keyframes lm-pop { from { transform: scale(0); } to { transform: scale(1); } }
@keyframes lm-clock { from { opacity: 0; } to { opacity: 0; } }
@keyframes lm-glide { from { transform: translateX(0); } to { transform: translateX(${GlintPeriod}px); } }
${chaseKeyframes("lm-chase", RouteEchoes.length)}
${chaseKeyframes("lm-ripple", PulseCycle / PulseStep)}
@keyframes lm-blink { 50% { opacity: .25; } }
`;

type MapItem =
    | { kind: "station"; station: LineMapStation }
    | { kind: "branch"; g: GeometryBranch }
    | { kind: "commit"; commit: LineMapCommit }
    | { kind: "head" }
    | { kind: "earlier" }
    | { kind: "terminus" }
    | { kind: "day"; day: number; commits: LineMapCommit[] }
    | { kind: "hidden"; branches: LineMapBranch[] };

function itemUrl(item: MapItem, model: LineMapModel): string {
    switch (item.kind) {
        case "station":
            return item.station.url;
        case "branch":
            return item.g.branch.url;
        case "commit":
            return commitUrl(model, item.commit.sha);
        case "head":
            return commitUrl(model, model.head?.sha);
    }
    return null;
}

function itemLabel(item: MapItem, model: LineMapModel): string {
    switch (item.kind) {
        case "station":
            return `${item.station.name}, ${item.station.kind === "rc" ? "release candidate" : "public release"}, ${formatDay(item.station.at)}`;
        case "branch":
            return `${item.g.branch.name}, ${item.g.branch.state === "open" ? "in progress" : "merged"}`;
        case "commit":
            return `Commit ${item.commit.sha.slice(0, 7)}: ${item.commit.subject}`;
        case "head":
            return `${model.trunk} now`;
        case "earlier":
            return `${model.earlier.length} earlier versions`;
        case "terminus":
            return "Next public release";
        case "day":
            return `${item.commits.length} commits on ${formatDay(item.day)}`;
        case "hidden":
            return `${item.branches.length} more open branches`;
    }
}

const DayListed = 12;

function DayDetail({ day, commits, model }: { day: number; commits: readonly LineMapCommit[]; model: LineMapModel }) {
    const tickets = new Set(commits.map((c) => readableSubject(c.subject).ticket).filter(Boolean));
    const newestFirst = [...commits].reverse();
    return (
        <>
            <div className="font-semibold text-primary">
                {formatDay(day)}
                <span className="ml-1.5 font-normal text-muted">
                    · {commits.length} commit{commits.length === 1 ? "" : "s"} on {model.trunk}
                    {tickets.size ? `, ${tickets.size} ticket${tickets.size === 1 ? "" : "s"}` : ""}
                </span>
            </div>
            <div className="flex flex-col gap-0.5 border-t border-border pt-1.5">
                {newestFirst.slice(0, DayListed).map((c) => (
                    <div key={c.sha} className="flex min-w-0 items-baseline gap-1.5">
                        <Subject subject={c.subject} />
                    </div>
                ))}
                {commits.length > DayListed ? (
                    <span className="text-muted">and {commits.length - DayListed} more</span>
                ) : null}
            </div>
        </>
    );
}

function HiddenDetail({ branches }: { branches: readonly LineMapBranch[] }) {
    return (
        <>
            <div className="font-semibold text-primary">
                {branches.length} more open branch{branches.length === 1 ? "" : "es"}
            </div>
            <div className="flex flex-col gap-0.5 border-t border-border pt-1.5">
                {branches.slice(0, DayListed).map((b) => (
                    <div key={b.id} className="flex min-w-0 items-baseline gap-2">
                        <span className="min-w-0 truncate font-mono text-[11px] text-primary">{b.name}</span>
                        <span className="ml-auto shrink-0 text-muted">
                            {b.count}
                            {b.countCapped ? "+" : ""} commit{b.count === 1 ? "" : "s"}
                            {b.prNumber ? ` · PR #${b.prNumber}` : ""}
                        </span>
                    </div>
                ))}
                {branches.length > DayListed ? (
                    <span className="text-muted">and {branches.length - DayListed} more</span>
                ) : null}
            </div>
            <div className="pt-1 text-[11px] text-muted">Full size shows them on their own lanes.</div>
        </>
    );
}

function Subject({ subject }: { subject: string }) {
    const s = readableSubject(subject);
    return (
        <span className="min-w-0 truncate">
            {s.ticket ? <span className="text-muted">#{s.ticket} </span> : null}
            {s.text}
        </span>
    );
}

function CommitLines({ commits }: { commits: readonly LineMapCommit[] }) {
    if (commits.length === 0) {
        return null;
    }
    return (
        <div className="flex flex-col gap-0.5 border-t border-border pt-1.5">
            {commits.slice(0, CommitsListed).map((c) => (
                <div key={c.sha} className="flex min-w-0 items-baseline gap-1.5">
                    <code className="shrink-0 text-[10px] text-muted">{c.sha.slice(0, 7)}</code>
                    <Subject subject={c.subject} />
                </div>
            ))}
            {commits.length > CommitsListed ? (
                <span className="text-muted">and {commits.length - CommitsListed} more</span>
            ) : null}
        </div>
    );
}

function Hint({ url, what }: { url: string; what: string }) {
    return (
        <div className="pt-1 text-[11px] text-muted">
            {url ? `Click to open ${what} on GitHub.` : "Not on GitHub: the detail comes from git alone."}
        </div>
    );
}

function StationDetail({ s }: { s: LineMapStation }) {
    const notes = s.notes ? plainText(s.notes).trim() : "";
    return (
        <>
            <div className="font-semibold text-primary">
                {s.name}
                <span className="ml-1.5 font-normal text-muted">
                    · {s.kind === "rc" ? "release candidate" : "public release"}
                </span>
            </div>
            <div className="text-secondary">
                Tagged {formatWhen(s.date)} ({timeAgo(s.date)})
            </div>
            {s.source ? (
                <div className="flex min-w-0 items-baseline gap-1.5 text-secondary">
                    <span className="shrink-0 text-muted">from develop</span>
                    <code className="shrink-0 text-[10px] text-muted">{s.source.sha.slice(0, 7)}</code>
                    <Subject subject={s.source.subject} />
                </div>
            ) : null}
            {notes ? (
                <div className="line-clamp-6 border-t border-border pt-1.5 leading-relaxed whitespace-pre-line text-secondary">
                    {notes.slice(0, 600)}
                </div>
            ) : (
                <div className="text-muted">No notes for this version.</div>
            )}
            <Hint url={s.url} what="this version" />
        </>
    );
}

function BranchDetail({ b }: { b: GeometryBranch["branch"] }) {
    const verdict = ciVerdictView(b.ci);
    const count = `${b.count}${b.countCapped ? "+" : ""} commit${b.count === 1 ? "" : "s"}`;
    return (
        <>
            <div className="font-semibold break-all text-primary">
                {b.name}
                <span className="ml-1.5 font-normal text-muted">· {b.state === "open" ? "in progress" : "merged"}</span>
            </div>
            <div className="text-secondary">
                {b.state === "open"
                    ? `${count} ahead of develop`
                    : `${count} · merged ${formatWhen(new Date(b.merge).toISOString())}`}
            </div>
            <div className="text-muted">
                {b.forkKnown
                    ? `Left develop ${formatWhen(new Date(b.fork).toISOString())}`
                    : "Where it left develop is not known: git's history read stops before it."}
            </div>
            {b.pr ? (
                <div className="text-secondary">
                    PR #{b.pr.number}
                    {b.pr.draft ? " (draft)" : ""} · {b.pr.merge.label}
                    {b.pr.checks.passed + b.pr.checks.failed + b.pr.checks.pending > 0
                        ? ` · checks ${b.pr.checks.passed} passed, ${b.pr.checks.failed} failed, ${b.pr.checks.pending} pending`
                        : ""}
                </div>
            ) : b.prNumber ? (
                <div className="text-secondary">PR #{b.prNumber}</div>
            ) : null}
            {verdict ? (
                <div className="flex items-center gap-1.5 text-secondary">
                    <i className={cn("fa fa-solid text-[11px]", verdict.iconClass)} />
                    Local CI: {verdict.label}
                </div>
            ) : null}
            <CommitLines commits={b.commits} />
            <Hint url={b.url} what={b.prNumber ? "its pull request" : b.ticket ? "its ticket" : "it"} />
        </>
    );
}

function Detail({ item, model, trunkCi }: { item: MapItem; model: LineMapModel; trunkCi: string }) {
    switch (item.kind) {
        case "station":
            return <StationDetail s={item.station} />;
        case "branch":
            return <BranchDetail b={item.g.branch} />;
        case "commit":
            return (
                <>
                    <div className="flex min-w-0 items-baseline gap-1.5 font-medium text-primary">
                        <code className="shrink-0 text-[10px] text-muted">{item.commit.sha.slice(0, 7)}</code>
                        <Subject subject={item.commit.subject} />
                    </div>
                    <div className="text-secondary">
                        On {model.trunk} · {formatWhen(item.commit.date)}
                    </div>
                    <Hint url={commitUrl(model, item.commit.sha)} what="this commit" />
                </>
            );
        case "head": {
            const verdict = ciVerdictView(trunkCi);
            return (
                <>
                    <div className="font-semibold text-primary">{model.trunk} · now</div>
                    {model.head ? (
                        <div className="flex min-w-0 items-baseline gap-1.5 text-secondary">
                            <code className="shrink-0 text-[10px] text-muted">{model.head.sha.slice(0, 7)}</code>
                            <Subject subject={model.head.subject} />
                        </div>
                    ) : null}
                    {model.head ? <div className="text-muted">Last commit {timeAgo(model.head.date)}</div> : null}
                    <div className="text-secondary">Local CI: {verdict ? verdict.label : "not known yet"}</div>
                    <div className="text-secondary">
                        {model.terminus.waiting} change{model.terminus.waiting === 1 ? "" : "s"} waiting for{" "}
                        {model.release ?? "a release"}
                    </div>
                </>
            );
        }
        case "earlier":
            return (
                <>
                    <div className="font-semibold text-primary">
                        {model.earlier.length} version{model.earlier.length === 1 ? "" : "s"} before the window
                    </div>
                    {model.earlier.slice(0, EarlierListed).map((s) => (
                        <div key={s.name} className="flex items-baseline gap-2">
                            <span className={cn("font-medium", s.kind === "public" ? "text-accent" : "text-primary")}>
                                {s.name}
                            </span>
                            <span className="text-muted">{formatDay(s.at)}</span>
                        </div>
                    ))}
                    {model.earlier.length > EarlierListed ? (
                        <div className="text-muted">and {model.earlier.length - EarlierListed} more</div>
                    ) : null}
                    <div className="pt-1 text-[11px] text-muted">A longer window shows them on the line.</div>
                </>
            );
        case "terminus":
            return (
                <>
                    <div className="font-semibold text-primary">{model.terminus.tag ?? "Next"} · public release</div>
                    <div className="text-secondary">{model.terminus.note}</div>
                    {model.terminus.state === "nothing" ? null : (
                        <div className="text-muted">
                            {`${model.terminus.waiting} change${model.terminus.waiting === 1 ? "" : "s"} on ${model.trunk} not yet on ${model.release ?? "a release"}.`}
                        </div>
                    )}
                </>
            );
        case "day":
            return <DayDetail day={item.day} commits={item.commits} model={model} />;
        case "hidden":
            return <HiddenDetail branches={item.branches} />;
    }
}

function WindowChoice({
    days,
    choices,
    onChange,
}: {
    days: number;
    choices: readonly number[];
    onChange: (days: number) => void;
}) {
    return (
        <div className="flex overflow-hidden rounded border border-border" role="group" aria-label="Time window">
            {choices.map((d) => (
                <button
                    key={d}
                    type="button"
                    onClick={() => onChange(d)}
                    aria-pressed={d === days}
                    className={cn(
                        "cursor-pointer px-1.5 py-0.5 text-[11px] tabular-nums transition-colors",
                        d === days ? "bg-hover text-primary" : "text-muted hover:bg-hover hover:text-secondary"
                    )}
                    title={`Show the last ${d} days`}
                >
                    {d}d
                </button>
            ))}
        </div>
    );
}

function Legend() {
    const item = "inline-flex items-center gap-1.5";
    return (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
            <span className={item}>
                <span className="h-[5px] w-[18px] rounded-full bg-accent" />
                develop
            </span>
            <span className={item}>
                <span className="h-1 w-[18px] rounded-full bg-primary opacity-40" />
                main
            </span>
            <span className={item}>
                <span className="h-2.5 w-[3px] rounded-sm bg-primary opacity-50" />
                landed on develop
            </span>
            <span className={item}>
                <span className="h-[3px] w-[18px] rounded-full bg-muted" />
                merged branch
            </span>
            <span className={item}>
                <span className="h-[3px] w-[18px] rounded-full bg-accent-200" />
                branch in progress
            </span>
            <span className={item}>
                <span className="h-2.5 w-2.5 rounded-full border-2 border-primary" />
                release candidate
            </span>
            <span className={item}>
                <span className="h-3.5 w-3.5 rounded-full border-[3px] border-accent" />
                public release
            </span>
        </div>
    );
}

function useWidth(ref: React.RefObject<HTMLDivElement>): number {
    const [width, setWidth] = useState(0);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) {
            return;
        }
        const measure = () => setWidth(el.clientWidth);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [ref]);
    return width;
}

// Hidden under reduced motion: there is no sequence to replay (AC6).
export function ReplayButton({ reduced, onReplay }: { reduced: boolean; onReplay: () => void }) {
    if (reduced) {
        return null;
    }
    return (
        <button
            type="button"
            onClick={onReplay}
            className="flex cursor-pointer items-center gap-1.5 rounded border border-border px-2 py-0.5 text-[11px] text-secondary transition-colors hover:bg-hover hover:text-primary"
            title="Play the map's drawing again"
            data-testid="line-map-replay"
        >
            <i className="fa fa-solid fa-rotate-left text-[9px]" />
            Replay
        </button>
    );
}

// Paused while the page is hidden or the map is out of view: nobody sees it, so nothing should run.
function usePaused(ref: React.RefObject<HTMLDivElement>): boolean {
    const [hidden, setHidden] = useState(() => document.hidden);
    const [outOfView, setOutOfView] = useState(false);
    useEffect(() => {
        const onVisibility = () => setHidden(document.hidden);
        document.addEventListener("visibilitychange", onVisibility);
        return () => document.removeEventListener("visibilitychange", onVisibility);
    }, []);
    useEffect(() => {
        const el = ref.current;
        if (!el || typeof IntersectionObserver === "undefined") {
            return;
        }
        const observer = new IntersectionObserver((entries) => {
            const last = entries[entries.length - 1];
            setOutOfView(!last.isIntersecting);
        });
        observer.observe(el);
        return () => observer.disconnect();
    }, [ref]);
    return hidden || outOfView;
}

type IntroAction = { event: IntroEvent; reduced: boolean };

export type LineMapProps = {
    dir: string;
    snapshot: MissionSnapshot;
    ciBranches?: CiBranch[];
    // The branch the local CI runs on right now, if any.
    ciRunning?: string;
    // The release under way, if any: the terminus shows the number a public one carries.
    session?: ReleaseSession;
    full?: boolean;
    onFullSize?: () => void;
};

// The same value as last render when its key did not change: every snapshot event decodes new objects, and the map
// should only be rebuilt when what it draws changed.
function useStable<T>(value: T, key: string): T {
    const last = useRef<{ key: string; value: T }>(null);
    if (last.current == null || last.current.key !== key) {
        last.current = { key, value };
    }
    return last.current.value;
}

export function LineMap({ dir, snapshot, ciBranches, ciRunning, session, full = false, onFullSize }: LineMapProps) {
    const [days, setDays] = useLineMapDays(dir, full);
    const box = useRef<HTMLDivElement>(null);
    const width = useWidth(box);
    const [hover, setHover] = useState<{ item: MapItem; anchor: Element }>(null);
    const hideTimer = useRef<number>(null);
    const reduced = useAtomValue(atoms.prefersReducedMotionAtom);
    const paused = usePaused(box);
    const [intro, dispatchIntro] = useReducer(
        (state: ReturnType<typeof initialIntro>, action: IntroAction) => introStep(state, action.event, action.reduced),
        reduced,
        initialIntro
    );
    const git = useStable(snapshot?.git, gitFingerprint(snapshot?.git));
    const prs = useStable(snapshot?.github?.prs, prsFingerprint(snapshot?.github?.prs));
    const releases = useStable(
        snapshot?.github?.releases,
        (snapshot?.github?.releases ?? []).map((r) => `${r.tagName}:${r.isDraft}`).join(",")
    );
    const ci = useStable(ciBranches, (ciBranches ?? []).map((b) => `${b.name}:${b.verdict}`).join(","));
    const release = useStable(session, session ? `${session.channel}:${session.version}:${session.tag}` : "");
    // "now" follows each new read of the project, not the clock: the map holds still between refreshes.
    const now = useMemo(() => Date.now(), [git, days]);
    const model = useMemo(
        () => (git ? buildLineMap({ git, prs, ciBranches: ci, releases, session: release, now, days }) : null),
        [git, prs, releases, ci, release, now, days]
    );
    // A detail opened on a mark the new data no longer has would float detached, with old figures.
    useEffect(() => setHover(null), [model]);
    useEffect(
        () => () => {
            if (hideTimer.current != null) {
                window.clearTimeout(hideTimer.current);
            }
        },
        []
    );
    const geo = useMemo(
        () => (model && width > 0 ? layoutLineMap(model, { width, full }) : null),
        [model, width, full]
    );
    const trunkCi = (ciBranches ?? []).find((b) => b.name === git?.trunk)?.verdict;
    useEffect(() => {
        if (reduced) {
            dispatchIntro({ event: "reduce", reduced });
        }
    }, [reduced]);
    const onAnimationEnd = useCallback(
        (e: React.AnimationEvent<HTMLDivElement>) => {
            if (e.animationName === "lm-clock") {
                dispatchIntro({ event: "end", reduced });
            }
        },
        [reduced]
    );

    // A map wider than its pane opens on "now": the recent part is what one looks for first. Only a new width or
    // window scrolls back; a refresh leaves the user where they scrolled.
    const geoWidth = geo?.width;
    useLayoutEffect(() => {
        const el = box.current;
        if (el == null || geoWidth == null) {
            return;
        }
        el.scrollLeft = el.scrollWidth;
    }, [geoWidth, days]);

    const keep = useCallback(() => {
        if (hideTimer.current != null) {
            window.clearTimeout(hideTimer.current);
            hideTimer.current = null;
        }
    }, []);
    const hideSoon = useCallback(() => {
        keep();
        hideTimer.current = window.setTimeout(() => setHover(null), HideDelay);
    }, [keep]);
    const show = useCallback(
        (item: MapItem, anchor: Element) => {
            keep();
            setHover({ item, anchor });
        },
        [keep]
    );

    // Stable while the model is: hovering re-renders the frame and the detail, never the map itself.
    const hit = useCallback(
        (item: MapItem): React.SVGProps<SVGGElement> => {
            const url = model ? itemUrl(item, model) : null;
            const open = () => {
                if (!url || !checkWebUrl(url)) {
                    return;
                }
                fireAndForget(() => openLink(url));
            };
            return {
                tabIndex: 0,
                role: url ? "link" : "button",
                "aria-label": model ? itemLabel(item, model) : undefined,
                className: cn("lm-hit", url && "cursor-pointer"),
                onPointerEnter: (e: React.PointerEvent<SVGGElement>) => show(item, e.currentTarget),
                onPointerLeave: hideSoon,
                onFocus: (e: React.FocusEvent<SVGGElement>) => show(item, e.currentTarget),
                onBlur: hideSoon,
                onClick: open,
                onKeyDown: (e: React.KeyboardEvent<SVGGElement>) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        open();
                    }
                    if (e.key === "Escape") {
                        setHover(null);
                    }
                },
            };
        },
        [model, show, hideSoon]
    );

    const choices = full ? FullLineMapDayChoices : LineMapDayChoices;
    return (
        <section
            className={cn("flex min-w-0 flex-col gap-2", full && "h-full")}
            aria-label="Line map"
            data-testid="line-map"
        >
            <style>{Styles + MotionStyles}</style>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <span className="text-[11px] font-medium tracking-wide text-secondary uppercase">
                    Line · last {days} days
                </span>
                <Legend />
                <span className="flex-1" />
                <WindowChoice days={days} choices={choices} onChange={setDays} />
                <ReplayButton reduced={reduced} onReplay={() => dispatchIntro({ event: "replay", reduced })} />
                {onFullSize ? (
                    <button
                        type="button"
                        onClick={onFullSize}
                        className="flex cursor-pointer items-center gap-1.5 rounded border border-border px-2 py-0.5 text-[11px] text-secondary transition-colors hover:bg-hover hover:text-primary"
                        title="Open the line map in its own block, over a wider window"
                    >
                        <i className="fa fa-solid fa-up-right-and-down-left-from-center text-[9px]" />
                        Full size
                    </button>
                ) : null}
            </div>
            <div
                ref={box}
                className={cn(
                    "lm-frame min-h-[220px] overflow-x-auto overflow-y-hidden rounded border border-border",
                    full && "min-h-0 flex-1 overflow-y-auto"
                )}
                data-testid="line-map-scroll"
                {...motionAttrs({ reduced, paused, intro: intro.phase })}
                onAnimationEnd={onAnimationEnd}
            >
                {geo && model ? (
                    <MapSvg key={intro.run} geo={geo} model={model} ciRunning={ciRunning} hit={hit} />
                ) : (
                    <div className="h-[220px] w-full mt-step-blink bg-hover/40" aria-busy="true" />
                )}
            </div>
            {hover && model ? (
                <MenuPopover
                    anchor={hover.anchor}
                    onClose={() => setHover(null)}
                    placement="top-start"
                    onPointerEnter={keep}
                    onPointerLeave={hideSoon}
                    className="flex w-80 flex-col gap-1 p-2.5 text-xs"
                >
                    <Detail item={hover.item} model={model} trunkCi={trunkCi} />
                </MenuPopover>
            ) : null}
        </section>
    );
}

type HitProps = (item: MapItem) => React.SVGProps<SVGGElement>;

function StationMark({ g, hit, geo }: { g: GeometryStation; hit: HitProps; geo: LineMapGeometry }) {
    const s = g.station;
    return (
        <g {...hit({ kind: "station", station: s })} data-kind={s.kind} data-testid={`line-map-station-${s.name}`}>
            <circle className="lm-hitdot" cx={g.x} cy={g.y} r={g.r + 6} />
            <circle className="lm-focus" cx={g.x} cy={g.y} r={g.r + 4} />
            <circle
                className={cn("lm-st", s.kind === "public" && "lm-st-public")}
                cx={g.x}
                cy={g.y}
                r={g.r}
                style={delayStyle(introDelay(geo, "station", g.x))}
            />
            {g.label ? (
                <text
                    className={cn("lm-stlabel", s.latest && "lm-stlabel-latest")}
                    transform={`translate(${g.label.x} ${g.label.y}) rotate(-55)`}
                    style={delayStyle(introDelay(geo, "label", g.x))}
                >
                    {g.label.name}
                    <tspan className="lm-stdate" x="0" dy="12">
                        {g.label.date}
                    </tspan>
                </text>
            ) : null}
        </g>
    );
}

// A branch's start in the load sequence, from where it leaves develop.
function branchDelay(geo: LineMapGeometry, g: GeometryBranch): number {
    return introDelay(geo, g.branch.state === "open" ? "open" : "branch", g.x1);
}

function BranchMark({ g, hit, geo }: { g: GeometryBranch; hit: HitProps; geo: LineMapGeometry }) {
    const b = g.branch;
    const open = b.state === "open";
    const guess = !b.forkKnown && !open;
    const start = branchDelay(geo, g);
    return (
        <g {...hit({ kind: "branch", g })} data-state={b.state} data-testid={`line-map-branch-${b.name}`}>
            <path className="lm-hitline" d={g.path} />
            {/* pathLength lets the load sequence draw a solid branch; a dashed one keeps its dashes in pixels. */}
            <path
                className={cn(open ? "lm-br-open" : "lm-br", guess && "lm-br-guess")}
                d={g.path}
                pathLength={guess ? undefined : 1}
                style={delayStyle(start)}
            />
            {g.tip ? (
                <g className="lm-wrap" style={delayStyle(start + 0.7)}>
                    <circle className="lm-tip" cx={g.tip.x} cy={g.tip.y} r={5} />
                </g>
            ) : null}
        </g>
    );
}

// The running CI as a static badge by develop's head: under reduced motion the glints cannot say it (AC6).
function CiBadge({ geo }: { geo: LineMapGeometry }) {
    // "CI running" at 10 px monospace, after the dot, with room on both sides.
    const w = 90;
    const h = 18;
    const x = geo.head.x - 14 - w;
    const y = geo.head.y - 30;
    return (
        <g className="lm-cibadge" data-testid="line-map-ci-badge">
            <rect x={x} y={y} width={w} height={h} rx={h / 2} />
            <circle cx={x + 10} cy={y + h / 2} r={3} />
            <text x={x + 18} y={y + h / 2 + 3.5}>
                CI running
            </text>
        </g>
    );
}

export const MapSvg = memo(function MapSvg({
    geo,
    model,
    ciRunning,
    hit,
}: {
    geo: LineMapGeometry;
    model: LineMapModel;
    ciRunning: string;
    hit: HitProps;
}) {
    const trunkCi = ciRunning && ciRunning === model.trunk ? "running" : "idle";
    const dev = `M ${geo.develop.x1} ${geo.develop.y} L ${geo.develop.x2} ${geo.develop.y}`;
    const main = `M ${geo.main.x1} ${geo.main.y} L ${geo.main.x2} ${geo.main.y}`;
    const at = (x: number) => delayStyle(introDelay(geo, "line", x));
    return (
        <div className="lm-plot" style={{ width: geo.width, height: geo.height }} data-ci={trunkCi}>
            <svg
                className="lm-svg"
                width={geo.width}
                height={geo.height}
                viewBox={`0 0 ${geo.width} ${geo.height}`}
                role="group"
                aria-label={`Line map of the last ${model.days} days`}
                data-ci={trunkCi}
                data-single={geo.single ? "true" : undefined}
            >
                {/* Times the load sequence: its end tells the map the sequence played. */}
                <rect className="lm-clock" width={0} height={0} />
                {geo.unread ? (
                    <g data-testid="line-map-unread">
                        <rect
                            className="lm-unread"
                            x={geo.unread.x1}
                            y={geo.tickTop}
                            width={Math.max(0, geo.unread.x2 - geo.unread.x1)}
                            height={geo.tickBottom - geo.tickTop}
                        />
                        <text className="lm-ticktxt" x={geo.unread.x1 + 6} y={geo.tickTop + 12}>
                            {geo.unread.label}
                        </text>
                    </g>
                ) : null}
                {geo.ticks.map((t) => (
                    <g key={`${t.x}-${t.label}`}>
                        <line className="lm-tick" x1={t.x} x2={t.x} y1={geo.tickTop} y2={geo.tickBottom} />
                        <text
                            className={cn("lm-ticktxt", t.now && "lm-ticktxt-now")}
                            x={t.x}
                            y={geo.height - 6}
                            textAnchor="middle"
                        >
                            {t.label}
                        </text>
                    </g>
                ))}

                {geo.single ? null : (
                    <text className="lm-line-name" x={10} y={geo.mainY + 5} fill="var(--color-secondary)">
                        {(model.release ?? "").slice(0, 9)}
                    </text>
                )}
                <text className="lm-line-name" x={10} y={geo.devY + 5} fill="var(--color-accent)">
                    {model.trunk.slice(0, 9)}
                </text>

                {geo.single ? null : <path className="lm-main" d={main} pathLength={1} />}
                <g className="lm-wrap" style={delayStyle(IntroRoute)}>
                    {geo.future ? <path className="lm-future" d={geo.future} /> : null}
                    <path className="lm-route lm-route-base" d={geo.route} />
                    {RouteEchoes.map((k) => (
                        <path key={k} className={`lm-route lm-route-echo lm-route-echo-${k}`} d={geo.route} />
                    ))}
                </g>

                {geo.stations.map((g) =>
                    g.connector ? (
                        <path
                            key={`c-${g.station.name}`}
                            className="lm-rc"
                            d={g.connector}
                            pathLength={1}
                            style={at(g.source?.x ?? g.x)}
                        />
                    ) : null
                )}
                {geo.branches.map((g) => (
                    <BranchMark key={g.branch.id} g={g} hit={hit} geo={geo} />
                ))}
                {/* Labels above every branch: a deeper lane's curve passes through the lanes above it. */}
                <g className="pointer-events-none">
                    {geo.branches.map((g) =>
                        g.label ? (
                            <text
                                key={`l-${g.branch.id}`}
                                className={g.branch.state === "open" ? "lm-livelabel" : "lm-brlabel"}
                                x={g.label.x}
                                y={g.label.y}
                                style={delayStyle(branchDelay(geo, g) + 0.5)}
                            >
                                {g.label.text}
                            </text>
                        ) : null
                    )}
                </g>

                <path className="lm-dev" d={dev} pathLength={1} />
                {/* The glints: light flowing along the lines, spaced in pixels so they keep their spacing and speed at
                every width; not a vehicle (FR-MC-023 rules out a train). */}

                {/* The work that landed on develop answers the pointer only: hundreds of marks in the tab order would
                bury the stations and branches a keyboard user is after. */}
                <g data-testid="line-map-landed" data-mode={geo.landed.mode}>
                    {geo.landed.marks.map((m) => (
                        <g
                            key={`${m.at}-${m.commits[0].sha}`}
                            {...hit(
                                geo.landed.mode === "commits"
                                    ? { kind: "commit", commit: m.commits[0] }
                                    : { kind: "day", day: m.at, commits: m.commits }
                            )}
                            tabIndex={-1}
                        >
                            <rect
                                className="lm-hitdot"
                                x={m.x - Math.max(4, m.w)}
                                y={m.y - 10}
                                width={Math.max(8, m.w * 2)}
                                height={20}
                            />
                            <rect
                                className="lm-landed"
                                x={m.x - m.w / 2}
                                y={m.y - m.h / 2}
                                width={m.w}
                                height={m.h}
                                rx={Math.min(1.5, m.w / 2)}
                                style={at(m.x)}
                            />
                        </g>
                    ))}
                </g>
                {geo.branches.map((g) =>
                    g.merge ? (
                        <circle
                            key={`m-${g.branch.id}`}
                            className="lm-merge"
                            cx={g.merge.x}
                            cy={g.merge.y}
                            r={3.5}
                            style={delayStyle(branchDelay(geo, g) + 0.55)}
                        />
                    ) : null
                )}
                {geo.landings.map((p, i) => (
                    <circle key={`h-${i}`} className="lm-merge" cx={p.x} cy={p.y} r={2.5} style={at(p.x)} />
                ))}
                {geo.hidden ? (
                    <g {...hit({ kind: "hidden", branches: geo.hidden.branches })} data-testid="line-map-hidden">
                        <text
                            className="lm-livelabel"
                            x={geo.hidden.x}
                            y={geo.hidden.y}
                            style={delayStyle(introDelay(geo, "open", geo.hidden.x) + 0.5)}
                        >
                            {geo.hidden.text}
                        </text>
                    </g>
                ) : null}
                {geo.stations.map((g) =>
                    g.source ? (
                        <circle
                            key={`f-${g.station.name}`}
                            className="lm-fork"
                            cx={g.source.x}
                            cy={g.source.y}
                            r={3}
                            style={at(g.source.x)}
                        />
                    ) : null
                )}

                {geo.earlier ? (
                    <g {...hit({ kind: "earlier" })} data-testid="line-map-earlier">
                        <g className="lm-wrap" style={delayStyle(introDelay(geo, "station", geo.earlier.x))}>
                            <circle className="lm-hitdot" cx={geo.earlier.x} cy={geo.earlier.y} r={12} />
                            <circle className="lm-focus" cx={geo.earlier.x} cy={geo.earlier.y} r={10} />
                            <circle className="lm-earlier" cx={geo.earlier.x} cy={geo.earlier.y} r={6} />
                            <text
                                className="lm-stdate"
                                transform={`translate(${geo.earlier.label.x} ${geo.earlier.label.y}) rotate(-55)`}
                            >
                                {geo.earlier.label.text}
                            </text>
                        </g>
                    </g>
                ) : null}
                {geo.stations.map((g) => (
                    <StationMark key={g.station.name} g={g} hit={hit} geo={geo} />
                ))}

                <g className="lm-pulse lm-wrap" style={delayStyle(IntroPulse)} aria-hidden="true">
                    {PulseRings.map((ring, k) => (
                        <circle
                            key={ring.r}
                            className="lm-ring"
                            cx={geo.head.x}
                            cy={geo.head.y}
                            r={ring.r}
                            strokeOpacity={ring.opacity}
                            style={{ ["--lm-k" as string]: k } as React.CSSProperties}
                        />
                    ))}
                </g>
                <g {...hit({ kind: "head" })} data-testid="line-map-head">
                    <circle className="lm-focus" cx={geo.head.x} cy={geo.head.y} r={13} />
                    <circle className="lm-head" cx={geo.head.x} cy={geo.head.y} r={9} style={delayStyle(IntroHead)} />
                </g>
                {trunkCi === "running" ? <CiBadge geo={geo} /> : null}

                <g {...hit({ kind: "terminus" })} data-testid="line-map-terminus">
                    <circle className="lm-focus" cx={geo.terminus.x} cy={geo.terminus.y} r={geo.terminus.r + 4} />
                    <circle
                        className="lm-term"
                        cx={geo.terminus.x}
                        cy={geo.terminus.y}
                        r={geo.terminus.r}
                        style={delayStyle(IntroTerminus)}
                    />
                    <g className="lm-wrap" style={delayStyle(IntroTerminusText)}>
                        <circle className="lm-termcore" cx={geo.terminus.x} cy={geo.terminus.y} r={7} />
                        <text className="lm-termtxt" x={geo.terminus.textX} y={geo.terminus.y - 4}>
                            {geo.terminus.title}
                        </text>
                        <text className="lm-termsub" x={geo.terminus.textX} y={geo.terminus.y + 13}>
                            {geo.terminus.sub}
                        </text>
                        <text className="lm-termstatus" x={geo.terminus.textX} y={geo.terminus.y + 28}>
                            {geo.terminus.status}
                        </text>
                    </g>
                </g>
            </svg>
            {/* The glints: light flowing along the lines, spaced in pixels so they keep their spacing and speed at
                every width; not a vehicle (FR-MC-023 rules out a train). HTML over the SVG, so their stepped
                transform stays on the compositor. */}
            <div className="lm-flows" style={delayStyle(IntroGlints)} aria-hidden="true">
                {geo.single ? null : <Glints line={geo.main} thickness={4} kind="main" />}
                <Glints line={geo.develop} thickness={6} kind="dev" />
            </div>
        </div>
    );
});
MapSvg.displayName = "MapSvg";

function Glints({
    line,
    thickness,
    kind,
}: {
    line: { x1: number; x2: number; y: number };
    thickness: number;
    kind: "dev" | "main";
}) {
    return (
        <div
            className={`lm-glints lm-glints-${kind}`}
            style={{
                left: line.x1,
                top: line.y - thickness / 2,
                width: Math.max(0, line.x2 - line.x1),
                height: thickness,
            }}
        >
            <div className="lm-glint-band" />
        </div>
    );
}
