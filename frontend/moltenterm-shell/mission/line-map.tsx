// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The line map (FR-MC-022, DS-MC-014): one inline SVG, time left to right, main on top, develop in the molten accent,
// the branches under it, every version tag a station on main, and the route to the next public release. The data
// is line-map-model.ts, the pixels line-map-geometry.ts; this file only draws and explains. Hovering or focusing a
// mark opens its detail (portalled, so no pane edge clips it); clicking opens it on GitHub.
//
// Drawn still: the motion of FR-MC-023 comes on top through the lm-* classes and the data-* attributes (data-ci on
// the root, data-state on branches, data-kind on stations), and must honour prefers-reduced-motion.

import { openLink } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { checkWebUrl } from "../project/project-model";
import { ciVerdictView } from "../status-bar-model";
import { CiBranch } from "./ci-model";
import { plainText } from "./github";
import { GeometryBranch, GeometryStation, layoutLineMap, LineMapGeometry } from "./line-map-geometry";
import {
    buildLineMap,
    commitUrl,
    FullLineMapDayChoices,
    LineMapCommit,
    LineMapDayChoices,
    LineMapModel,
    LineMapStation,
} from "./line-map-model";
import { useLineMapDays } from "./line-map-store";
import { MenuPopover } from "./menu-popover";
import { MissionSnapshot } from "./mission-model";
import { formatDay, formatWhen, timeAgo } from "./time-format";
import { readableSubject } from "./versions";

const HideDelay = 160;
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
.lm-commit { fill: color-mix(in srgb, var(--color-accent) 35%, var(--color-background)); }
.lm-rc { fill: none; stroke: var(--color-primary); stroke-opacity: .45; stroke-width: 2; stroke-linecap: round; }
.lm-fork { fill: var(--color-primary); fill-opacity: .6; }
.lm-st { fill: var(--color-background); stroke: var(--color-primary); stroke-width: 2.5; }
.lm-st-public { stroke: var(--color-accent); stroke-width: 3.5; }
.lm-earlier { fill: var(--color-background); stroke: var(--color-muted); stroke-width: 2; stroke-dasharray: 3 2; }
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
`;

type MapItem =
    | { kind: "station"; station: LineMapStation }
    | { kind: "branch"; g: GeometryBranch }
    | { kind: "commit"; commit: LineMapCommit }
    | { kind: "head" }
    | { kind: "earlier" }
    | { kind: "terminus" };

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
    }
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
                    : "Where it left develop is not known (a squash merge)."}
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
                    <div className="text-secondary">
                        {model.terminus.how === "decision"
                            ? "The number is a decision: choose it when you release."
                            : model.terminus.how === "nothing"
                              ? "Nothing waiting justifies a public release yet."
                              : `${model.terminus.waiting} change${model.terminus.waiting === 1 ? "" : "s"} on ${model.trunk} not yet on ${model.release ?? "a release"}.`}
                    </div>
                    {model.terminus.reason ? <div className="text-muted">{model.terminus.reason}</div> : null}
                </>
            );
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

export type LineMapProps = {
    dir: string;
    snapshot: MissionSnapshot;
    ciBranches?: CiBranch[];
    // The branch the local CI runs on right now, if any.
    ciRunning?: string;
    full?: boolean;
    onFullSize?: () => void;
};

export function LineMap({ dir, snapshot, ciBranches, ciRunning, full = false, onFullSize }: LineMapProps) {
    const [days, setDays] = useLineMapDays(dir, full);
    const box = useRef<HTMLDivElement>(null);
    const width = useWidth(box);
    const [hover, setHover] = useState<{ item: MapItem; anchor: Element }>(null);
    const hideTimer = useRef<number>(null);
    const git = snapshot?.git;
    const github = snapshot?.github;
    // "now" follows each new read of the project, not the clock: the map holds still between refreshes.
    const now = useMemo(() => Date.now(), [git, days]);
    const model = useMemo(
        () =>
            git
                ? buildLineMap({
                      git,
                      prs: github?.prs,
                      ciBranches,
                      releases: github?.releases,
                      now,
                      days,
                  })
                : null,
        [git, github?.prs, github?.releases, ciBranches, now, days]
    );
    const geo = useMemo(
        () => (model && width > 0 ? layoutLineMap(model, { width, full }) : null),
        [model, width, full]
    );
    const trunkCi = (ciBranches ?? []).find((b) => b.name === git?.trunk)?.verdict;

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

    const open = (url: string) => {
        if (!url || !checkWebUrl(url)) {
            return;
        }
        fireAndForget(() => openLink(url));
    };
    const hit = (item: MapItem) => {
        const url = model ? itemUrl(item, model) : null;
        return {
            tabIndex: 0,
            role: url ? "link" : "button",
            "aria-label": model ? itemLabel(item, model) : undefined,
            className: cn("lm-hit", url && "cursor-pointer"),
            onPointerEnter: (e: React.PointerEvent<SVGGElement>) => show(item, e.currentTarget),
            onPointerLeave: hideSoon,
            onFocus: (e: React.FocusEvent<SVGGElement>) => show(item, e.currentTarget),
            onBlur: hideSoon,
            onClick: () => open(url),
            onKeyDown: (e: React.KeyboardEvent<SVGGElement>) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    open(url);
                }
                if (e.key === "Escape") {
                    setHover(null);
                }
            },
        };
    };

    const choices = full ? FullLineMapDayChoices : LineMapDayChoices;
    return (
        <section
            className={cn("flex min-w-0 flex-col gap-2", full && "h-full")}
            aria-label="Line map"
            data-testid="line-map"
        >
            <style>{Styles}</style>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <span className="text-[11px] font-medium tracking-wide text-secondary uppercase">
                    Line · last {days} days
                </span>
                <Legend />
                <span className="flex-1" />
                <WindowChoice days={days} choices={choices} onChange={setDays} />
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
                    "min-h-[220px] overflow-x-auto overflow-y-hidden rounded border border-border",
                    full && "min-h-0 flex-1 overflow-y-auto"
                )}
                data-testid="line-map-scroll"
            >
                {geo && model ? (
                    <MapSvg geo={geo} model={model} ciRunning={ciRunning} hit={hit} />
                ) : (
                    <div
                        className="h-[220px] w-full animate-pulse bg-hover/40 motion-reduce:animate-none"
                        aria-busy="true"
                    />
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

function StationMark({ g, hit }: { g: GeometryStation; hit: HitProps }) {
    const s = g.station;
    return (
        <g {...hit({ kind: "station", station: s })} data-kind={s.kind} data-testid={`line-map-station-${s.name}`}>
            <circle className="lm-hitdot" cx={g.x} cy={g.y} r={g.r + 6} />
            <circle className="lm-focus" cx={g.x} cy={g.y} r={g.r + 4} />
            <circle className={cn("lm-st", s.kind === "public" && "lm-st-public")} cx={g.x} cy={g.y} r={g.r} />
            {g.label ? (
                <text
                    className={cn("lm-stlabel", s.latest && "lm-stlabel-latest")}
                    transform={`translate(${g.label.x} ${g.label.y}) rotate(-55)`}
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

function BranchMark({ g, hit }: { g: GeometryBranch; hit: HitProps }) {
    const b = g.branch;
    const open = b.state === "open";
    return (
        <g {...hit({ kind: "branch", g })} data-state={b.state} data-testid={`line-map-branch-${b.name}`}>
            <path className="lm-hitline" d={g.path} />
            <path className={cn(open ? "lm-br-open" : "lm-br", !b.forkKnown && !open && "lm-br-guess")} d={g.path} />
            {g.tip ? <circle className="lm-tip" cx={g.tip.x} cy={g.tip.y} r={5} /> : null}
            {g.label ? (
                <text className={open ? "lm-livelabel" : "lm-brlabel"} x={g.label.x} y={g.label.y}>
                    {g.label.text}
                </text>
            ) : null}
        </g>
    );
}

function MapSvg({
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
    return (
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

            {geo.single ? null : (
                <path className="lm-main" d={`M ${geo.main.x1} ${geo.main.y} L ${geo.main.x2} ${geo.main.y}`} />
            )}
            {geo.future ? <path className="lm-future" d={geo.future} /> : null}
            <path className="lm-route" d={geo.route} />

            {geo.stations.map((g) =>
                g.connector ? <path key={`c-${g.station.name}`} className="lm-rc" d={g.connector} /> : null
            )}
            {geo.branches.map((g) => (
                <BranchMark key={g.branch.id} g={g} hit={hit} />
            ))}

            <path className="lm-dev" d={`M ${geo.develop.x1} ${geo.develop.y} L ${geo.develop.x2} ${geo.develop.y}`} />

            {/* develop's own commits answer the pointer only: hundreds of them in the tab order would bury the
                stations and branches a keyboard user is after. */}
            {geo.commits.map((c, i) => (
                <g key={c.sha} {...hit({ kind: "commit", commit: model.commits[i] })} tabIndex={-1}>
                    <circle className="lm-hitdot" cx={c.x} cy={c.y} r={6} />
                    <circle className="lm-focus" cx={c.x} cy={c.y} r={5} />
                    <circle className="lm-commit" cx={c.x} cy={c.y} r={1.8} />
                </g>
            ))}
            {geo.branches.map((g) =>
                g.merge ? (
                    <circle key={`m-${g.branch.id}`} className="lm-merge" cx={g.merge.x} cy={g.merge.y} r={3.5} />
                ) : null
            )}
            {geo.stations.map((g) =>
                g.source ? (
                    <circle key={`f-${g.station.name}`} className="lm-fork" cx={g.source.x} cy={g.source.y} r={3} />
                ) : null
            )}

            {geo.earlier ? (
                <g {...hit({ kind: "earlier" })} data-testid="line-map-earlier">
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
            ) : null}
            {geo.stations.map((g) => (
                <StationMark key={g.station.name} g={g} hit={hit} />
            ))}

            <g {...hit({ kind: "head" })} data-testid="line-map-head">
                <circle className="lm-focus" cx={geo.head.x} cy={geo.head.y} r={13} />
                <circle className="lm-head" cx={geo.head.x} cy={geo.head.y} r={9} />
            </g>

            <g {...hit({ kind: "terminus" })} data-testid="line-map-terminus">
                <circle className="lm-focus" cx={geo.terminus.x} cy={geo.terminus.y} r={geo.terminus.r + 4} />
                <circle className="lm-term" cx={geo.terminus.x} cy={geo.terminus.y} r={geo.terminus.r} />
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
        </svg>
    );
}
