// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The branches as a tree (FR-MC-002), ported from Notulia's Dev › Timeline (src/components/dev/BranchTree.tsx): the
// trunk branch rises from the bottom of the panel, the release branch is a vine along it carrying the releases, every
// other branch is a limb up to its last commit with a card at the edge. It grows on arrival and holds still for anyone
// who asked the system for less motion. Geometry in tree.ts, pure and tested. Colours follow the workspace accent.

import { openLink } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { plainText } from "./github";
import { layoutTree, Release, TreeData } from "./tree";
import { readableSubject } from "./versions";

const Card = { width: 204, height: 70 };

export function timeAgo(iso: string, now = Date.now()): string {
    const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
    const hours = Math.round((new Date(iso).getTime() - now) / 3_600_000);
    return Math.abs(hours) < 48 ? rtf.format(hours, "hour") : rtf.format(Math.round(hours / 24), "day");
}

export function formatWhen(iso: string): string {
    return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

const Styles = `
@keyframes mt-grow { from { transform: scaleY(0); opacity: .2 } to { transform: scaleY(1); opacity: 1 } }
@keyframes mt-draw { from { stroke-dashoffset: 1 } to { stroke-dashoffset: 0 } }
@keyframes mt-pop { 0% { transform: scale(0) } 70% { transform: scale(1.35) } 100% { transform: scale(1) } }
@keyframes mt-fade { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
@keyframes mt-glow { 0%, 100% { opacity: .55 } 50% { opacity: 1 } }
.mt-tree .mt-trunk { transform-box: fill-box; transform-origin: 50% 100%; animation: mt-grow 1.1s cubic-bezier(.2,.8,.2,1) both }
.mt-tree .mt-draw { stroke-dasharray: 1; animation: mt-draw .9s cubic-bezier(.3,.7,.2,1) both }
.mt-tree .mt-pop { transform-box: fill-box; transform-origin: center; animation: mt-pop .45s ease-out both }
.mt-tree .mt-fade { animation: mt-fade .5s ease-out both }
.mt-tree .mt-glow { animation: mt-glow 2.6s ease-in-out infinite }
@media (prefers-reduced-motion: reduce) {
  .mt-tree .mt-trunk, .mt-tree .mt-draw, .mt-tree .mt-pop, .mt-tree .mt-fade, .mt-tree .mt-glow { animation: none; stroke-dashoffset: 0 }
}
`;

const Accent = "var(--color-accent)";
const AccentSoft = "color-mix(in srgb, var(--color-accent) 55%, white)";
const AccentPale = "color-mix(in srgb, var(--color-accent) 25%, white)";
const AccentDeep = "color-mix(in srgb, var(--color-accent) 45%, black)";

export function BranchTree({
    data,
    days,
    prs,
}: {
    data: TreeData;
    days: number;
    prs: Map<string, { number: number; url: string }>;
}) {
    const box = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const [release, setRelease] = useState<{ r: Release; x: number; y: number }>(null);

    useLayoutEffect(() => {
        const el = box.current;
        if (!el) {
            return;
        }
        const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const tree = useMemo(
        () =>
            size.width > 0 && size.height > 0
                ? layoutTree(data, { now: new Date(), days, width: size.width, height: size.height, card: Card })
                : null,
        [data, days, size]
    );
    const delay = (s: number) => ({ animationDelay: `${s}s` });
    const limbDelay = (order: number) => 0.7 + order * 0.12;
    const open = (url: string) => fireAndForget(() => openLink(url));

    return (
        <div ref={box} className="mt-tree relative h-full w-full overflow-hidden" data-testid="branch-tree">
            <style>{Styles}</style>
            {tree ? (
                // Keyed on the window: the growth replays when it changes, not on every resize.
                <div key={days} className="absolute inset-0">
                    <svg width={size.width} height={size.height} className="absolute inset-0">
                        <defs>
                            <linearGradient id="mt-trunk-fill" x1="0" y1="1" x2="0" y2="0">
                                <stop offset="0%" stopColor={AccentDeep} />
                                <stop offset="70%" stopColor={Accent} />
                                <stop offset="100%" stopColor={AccentSoft} />
                            </linearGradient>
                            <radialGradient id="mt-halo">
                                <stop offset="0%" stopColor={Accent} stopOpacity="0.55" />
                                <stop offset="100%" stopColor={Accent} stopOpacity="0" />
                            </radialGradient>
                            <filter id="mt-soft" x="-50%" y="-50%" width="200%" height="200%">
                                <feGaussianBlur stdDeviation="2.2" />
                            </filter>
                        </defs>

                        {tree.weeks.map((w) => (
                            <g key={w.date.toISOString()} opacity={0.5}>
                                <line
                                    x1={0}
                                    x2={size.width}
                                    y1={w.y}
                                    y2={w.y}
                                    stroke="var(--color-border)"
                                    strokeDasharray="2 6"
                                />
                                <text x={6} y={w.y - 4} fontSize={10} fill="var(--color-muted)">
                                    {w.date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                                </text>
                            </g>
                        ))}

                        {tree.roots.map((d, i) => (
                            <path
                                key={i}
                                d={d}
                                fill="none"
                                stroke={AccentDeep}
                                strokeWidth={3 - i * 0.4}
                                strokeLinecap="round"
                                pathLength={1}
                                className="mt-draw"
                                style={delay(0.05 * i)}
                            />
                        ))}
                        {data.release !== data.trunk ? (
                            <path
                                d={tree.vine}
                                fill="none"
                                stroke="var(--color-primary)"
                                strokeOpacity={0.8}
                                strokeWidth={2.2}
                                strokeLinecap="round"
                                pathLength={1}
                                className="mt-draw"
                                style={delay(0.25)}
                            />
                        ) : null}

                        <path d={tree.trunk} fill={Accent} opacity={0.35} filter="url(#mt-soft)" className="mt-trunk" />
                        <path d={tree.trunk} fill="url(#mt-trunk-fill)" className="mt-trunk" data-testid="tree-trunk" />

                        {tree.limbs.map((limb) => (
                            <g key={limb.name}>
                                <path
                                    d={limb.path}
                                    fill="none"
                                    stroke={prs.has(limb.name) ? "var(--color-primary)" : AccentSoft}
                                    strokeOpacity={0.85}
                                    strokeWidth={2}
                                    strokeLinecap="round"
                                    pathLength={1}
                                    className="mt-draw"
                                    style={delay(limbDelay(limb.order))}
                                />
                                <line
                                    x1={limb.tip.x}
                                    y1={limb.tip.y}
                                    x2={limb.card.anchorX}
                                    y2={limb.card.anchorY}
                                    stroke="var(--color-muted)"
                                    strokeOpacity={0.6}
                                    strokeDasharray="3 4"
                                    className="mt-fade"
                                    style={delay(limbDelay(limb.order) + 0.6)}
                                />
                                {limb.nodes.map((n, i) => (
                                    <circle
                                        key={n.sha}
                                        cx={n.x}
                                        cy={n.y}
                                        r={i === 0 ? 4.2 : 2.8}
                                        fill={i === 0 ? AccentPale : Accent}
                                        className="mt-pop"
                                        style={delay(limbDelay(limb.order) + 0.5 + i * 0.04)}
                                    >
                                        <title>{`${n.sha.slice(0, 7)} · ${formatWhen(n.date)}\n${n.subject}`}</title>
                                    </circle>
                                ))}
                            </g>
                        ))}

                        {tree.trunkNodes.map((n, i) => (
                            <circle
                                key={n.sha}
                                cx={n.x}
                                cy={n.y}
                                r={2.4}
                                fill={AccentPale}
                                className="mt-pop"
                                style={delay(0.9 + i * 0.015)}
                            >
                                <title>{`${data.trunk} · ${n.sha.slice(0, 7)} · ${formatWhen(n.date)}\n${n.subject}`}</title>
                            </circle>
                        ))}

                        {tree.releaseNodes.map((n) => (
                            <circle
                                key={n.sha}
                                cx={n.x}
                                cy={n.y}
                                r={2.4}
                                fill="var(--color-primary)"
                                className="mt-pop"
                                style={delay(0.8)}
                            >
                                <title>{`${data.release} · ${n.sha.slice(0, 7)} · ${formatWhen(n.date)}\n${n.subject}`}</title>
                            </circle>
                        ))}
                        {tree.releases.map((r) => (
                            <g
                                key={r.name}
                                data-testid={`tree-release-${r.name}`}
                                className="mt-pop"
                                style={delay(1.1)}
                                onMouseEnter={(e) => setRelease({ r, x: e.clientX, y: e.clientY })}
                                onMouseLeave={() => setRelease(null)}
                            >
                                <circle cx={r.x} cy={r.y} r={11} fill={Accent} opacity={0.18} className="mt-glow" />
                                <rect
                                    x={r.x - 5}
                                    y={r.y - 5}
                                    width={10}
                                    height={10}
                                    transform={`rotate(45 ${r.x} ${r.y})`}
                                    fill={r.rc ? "var(--color-background)" : Accent}
                                    stroke={Accent}
                                    strokeWidth={2}
                                />
                                <rect
                                    x={r.x - 12 - r.name.length * 6.1 - 12}
                                    y={r.y - 9}
                                    width={r.name.length * 6.1 + 12}
                                    height={18}
                                    rx={3}
                                    fill={Accent}
                                    opacity={r.rc ? 0.75 : 1}
                                />
                                <text
                                    x={r.x - 12 - r.name.length * 6.1 - 6}
                                    y={r.y + 4}
                                    fontSize={10.5}
                                    fontWeight={600}
                                    fill="var(--color-background)"
                                >
                                    {r.name}
                                </text>
                            </g>
                        ))}

                        <circle cx={tree.cx} cy={tree.top} r={22} fill="url(#mt-halo)" className="mt-glow" />
                        <circle
                            cx={tree.cx}
                            cy={tree.top}
                            r={5}
                            fill={AccentPale}
                            className="mt-pop"
                            style={delay(1)}
                        />
                    </svg>

                    <div
                        className="mt-fade pointer-events-none absolute text-center"
                        style={{ left: tree.cx - 90, top: tree.top - 58, width: 180, ...delay(1.1) }}
                    >
                        <div className="text-xs font-semibold text-accent">{data.trunk}</div>
                        <div className="text-[10px] text-muted">now</div>
                    </div>

                    {tree.limbs.map((limb) => {
                        const pr = prs.get(limb.name);
                        const last = limb.last ? readableSubject(limb.last.subject) : null;
                        return (
                            <div
                                key={limb.name}
                                data-testid={`tree-card-${limb.name}`}
                                className={cn(
                                    "mt-fade absolute flex flex-col justify-center gap-0.5 rounded border bg-modalbg/90 px-2.5 py-1.5 text-xs shadow-md",
                                    pr ? "border-accent/60" : "border-border"
                                )}
                                style={{
                                    left: limb.card.x,
                                    top: limb.card.y,
                                    width: Card.width,
                                    height: Card.height,
                                    ...delay(limbDelay(limb.order) + 0.7),
                                }}
                            >
                                <div className="flex items-center gap-1.5">
                                    <i
                                        className={cn(
                                            "fa fa-solid fa-code-branch text-[10px]",
                                            pr ? "text-primary" : "text-accent"
                                        )}
                                    />
                                    <span className="truncate font-mono font-medium" title={limb.name}>
                                        {limb.name}
                                    </span>
                                </div>
                                <div className="flex items-center gap-1.5 overflow-hidden text-[10.5px] whitespace-nowrap text-muted">
                                    {pr ? (
                                        <button
                                            type="button"
                                            onClick={() => open(pr.url)}
                                            className="shrink-0 cursor-pointer rounded bg-accent/20 px-1 font-medium text-primary hover:bg-accent/35"
                                        >
                                            PR #{pr.number}
                                        </button>
                                    ) : (
                                        <span className="shrink-0 rounded bg-hover px-1">local</span>
                                    )}
                                    <span className="shrink-0">
                                        {limb.commits} commit{limb.commits === 1 ? "" : "s"}
                                    </span>
                                    {limb.last ? <span className="truncate">· {timeAgo(limb.last.date)}</span> : null}
                                </div>
                                {last ? (
                                    <div className="truncate text-[10.5px]" title={limb.last?.subject}>
                                        {last.ticket ? <span className="text-muted">#{last.ticket} </span> : null}
                                        {last.text}
                                    </div>
                                ) : null}
                            </div>
                        );
                    })}
                    {tree.limbs.length === 0 ? (
                        <div
                            className="mt-fade absolute top-24 right-6 flex items-center gap-1.5 text-xs text-muted"
                            style={delay(1)}
                        >
                            <i className="fa fa-solid fa-seedling" /> No branch in progress: everything is on{" "}
                            {data.trunk}.
                        </div>
                    ) : null}
                </div>
            ) : null}
            {release ? (
                <div
                    className="pointer-events-none fixed z-50 max-h-[60vh] w-96 overflow-hidden rounded border border-border bg-modalbg p-3 text-xs shadow-lg"
                    style={{
                        left: Math.min(Math.max(8, release.x + 16), window.innerWidth - 392),
                        top: release.y - 20,
                    }}
                >
                    <div className="mb-1 font-semibold">
                        {release.r.name}
                        <span className="ml-1.5 font-normal text-muted">
                            · {release.r.rc ? "release candidate" : "public"} · {formatWhen(release.r.date)}
                        </span>
                    </div>
                    <div className="leading-relaxed whitespace-pre-line text-secondary">
                        {release.r.notes ? plainText(release.r.notes).slice(0, 1200) : "No notes for this version."}
                    </div>
                </div>
            ) : null}
        </div>
    );
}
