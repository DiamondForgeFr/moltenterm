// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The release setup's flow diagram (DS-MC-030): one inline SVG in the line map's colours (FR-MC-022), the trunk in the
// accent and the release branch in the neutral tone, one node per step in its phase band, the tag a diamond, manual
// steps hollow, the workflows GitHub runs on a lane of their own with their environment approvals.

import { cn } from "@/util/util";
import { useT } from "../i18n/i18n";
import { PhaseTitles } from "./release-run";
import { FlowModel, FlowNode, FlowPhases } from "./release-setup-model";

const LeftW = 92;
const SlotW = 96;
const TopH = 22;
const LaneH = 62;
const LabelChars = 15;

const LaneOrder: FlowNode["lane"][] = ["trunk", "rc", "release", "github"];

function shorten(text: string): string {
    return text.length > LabelChars ? `${text.slice(0, LabelChars - 1)}…` : text;
}

type Placed = FlowNode & { x: number; y: number };

// layout gives every node its own slot, in phase order then declared order, and each phase the band of its slots.
export function layoutFlow(model: FlowModel) {
    const lanes = LaneOrder.filter((lane) => {
        if (lane === "github" || lane === "rc") {
            return model.nodes.some((n) => n.lane === lane);
        }
        return !(model.single && lane === "trunk");
    });
    const laneY = (lane: FlowNode["lane"]) => {
        const real = model.single && lane === "trunk" ? "release" : lane;
        return TopH + LaneH / 2 + lanes.indexOf(real) * LaneH;
    };
    const placed: Placed[] = [];
    const bands: { phase: string; x: number; w: number }[] = [];
    let slot = 0;
    for (const phase of FlowPhases) {
        const inPhase = model.nodes.filter((n) => n.phase === phase);
        const start = slot;
        for (const node of inPhase) {
            placed.push({ ...node, x: LeftW + slot * SlotW + SlotW / 2, y: laneY(node.lane) });
            slot++;
        }
        const width = Math.max(1, inPhase.length);
        if (inPhase.length === 0) {
            slot++;
        }
        bands.push({ phase, x: LeftW + start * SlotW, w: width * SlotW });
    }
    const width = LeftW + slot * SlotW + 8;
    const height = TopH + lanes.length * LaneH + 14;
    return { lanes, laneY, placed, bands, width, height };
}

function NodeMark({ node }: { node: Placed }) {
    const { x, y } = node;
    switch (node.kind) {
        case "tag":
            return (
                <path
                    d={`M ${x} ${y - 8} L ${x + 8} ${y} L ${x} ${y + 8} L ${x - 8} ${y} Z`}
                    style={{ fill: "var(--color-accent)", stroke: "var(--color-accent)" }}
                />
            );
        case "workflow":
        case "dispatch":
        case "deploy":
            return (
                <rect
                    x={x - 9}
                    y={y - 7}
                    width={18}
                    height={14}
                    rx={3}
                    style={{
                        fill: "var(--color-background)",
                        stroke: node.approval ? "var(--color-warning)" : "var(--color-primary)",
                        strokeWidth: 2,
                    }}
                />
            );
        case "manual":
            return (
                <circle
                    cx={x}
                    cy={y}
                    r={6.5}
                    style={{
                        fill: "var(--color-background)",
                        stroke: "var(--color-accent)",
                        strokeWidth: 2,
                        strokeDasharray: "3 2",
                    }}
                />
            );
    }
    return (
        <circle
            cx={x}
            cy={y}
            r={6.5}
            style={{
                fill: node.kind === "notes" ? "var(--color-background)" : "var(--color-accent)",
                stroke: "var(--color-accent)",
                strokeWidth: 2,
            }}
        />
    );
}

export function FlowDiagram({ model, className }: { model: FlowModel; className?: string }) {
    const t = useT();
    const { lanes, laneY, placed, bands, width, height } = layoutFlow(model);
    const laneName = (lane: FlowNode["lane"]) =>
        lane === "github"
            ? t("mc.setup.diagram.github")
            : lane === "trunk"
              ? model.trunk
              : lane === "rc"
                ? (model.rcBranch ?? "")
                : model.release;
    const promoteAt = placed.find((n) => n.key.endsWith("/promote"));
    // The pull-request flow: the RC branch leaves the trunk at its first step and joins the release branch where its
    // pull request is merged.
    const branchAt = model.viaPr ? placed.find((n) => n.lane === "rc") : undefined;
    const mergeAt = model.viaPr ? placed.find((n) => n.key.endsWith("/merge-pr")) : undefined;
    const syncAt = placed.find((n) => n.key.endsWith("/sync-back"));
    return (
        <div
            className={cn("overflow-x-auto rounded-6 border border-border bg-black/20", className)}
            data-testid="setup-diagram"
        >
            <svg
                viewBox={`0 0 ${width} ${height}`}
                width={width}
                height={height}
                role="img"
                aria-label={t("mc.setup.diagram.label")}
                className="block"
            >
                {bands.map((band, i) => (
                    <g key={band.phase}>
                        <rect
                            x={band.x}
                            y={0}
                            width={band.w}
                            height={height}
                            style={{ fill: i % 2 === 0 ? "rgba(255,255,255,0.025)" : "transparent" }}
                        />
                        <text x={band.x + 6} y={14} className="text-10" style={{ fill: "var(--color-muted)" }}>
                            {PhaseTitles[band.phase]}
                        </text>
                    </g>
                ))}
                {lanes.map((lane) => (
                    <g key={lane}>
                        <text x={8} y={laneY(lane) + 4} className="text-11" style={{ fill: "var(--color-secondary)" }}>
                            {shorten(laneName(lane))}
                        </text>
                        <line
                            x1={LeftW - 6}
                            x2={width - 4}
                            y1={laneY(lane)}
                            y2={laneY(lane)}
                            style={
                                lane === "github"
                                    ? { stroke: "var(--color-border)", strokeWidth: 1.5, strokeDasharray: "4 5" }
                                    : lane === "trunk" || model.single
                                      ? { stroke: "var(--color-accent)", strokeWidth: 4, strokeLinecap: "round" }
                                      : {
                                            stroke: "var(--color-primary)",
                                            strokeOpacity: 0.38,
                                            strokeWidth: 4,
                                            strokeLinecap: "round",
                                        }
                            }
                        />
                    </g>
                ))}
                {promoteAt && !model.single ? (
                    <path
                        d={`M ${promoteAt.x} ${laneY("trunk")} C ${promoteAt.x + 30} ${laneY("trunk")}, ${promoteAt.x + 18} ${laneY("release")}, ${promoteAt.x + 48} ${laneY("release")}`}
                        style={{ fill: "none", stroke: "var(--color-accent)", strokeWidth: 2.5 }}
                    />
                ) : null}
                {branchAt ? (
                    <path
                        d={`M ${branchAt.x - 48} ${laneY("trunk")} C ${branchAt.x - 18} ${laneY("trunk")}, ${branchAt.x - 30} ${laneY("rc")}, ${branchAt.x} ${laneY("rc")}`}
                        style={{ fill: "none", stroke: "var(--color-accent)", strokeWidth: 2.5 }}
                        data-testid="setup-diagram-branch"
                    />
                ) : null}
                {mergeAt ? (
                    <path
                        d={`M ${mergeAt.x - 48} ${laneY("rc")} C ${mergeAt.x - 18} ${laneY("rc")}, ${mergeAt.x - 30} ${laneY("release")}, ${mergeAt.x} ${laneY("release")}`}
                        style={{ fill: "none", stroke: "var(--color-accent)", strokeWidth: 2.5 }}
                        data-testid="setup-diagram-pr"
                    />
                ) : null}
                {syncAt && !model.single ? (
                    <path
                        d={`M ${syncAt.x - 48} ${laneY("release")} C ${syncAt.x - 18} ${laneY("release")}, ${syncAt.x - 30} ${laneY("trunk")}, ${syncAt.x} ${laneY("trunk")}`}
                        style={{
                            fill: "none",
                            stroke: "var(--color-primary)",
                            strokeOpacity: 0.5,
                            strokeWidth: 2,
                            strokeDasharray: "5 4",
                        }}
                    />
                ) : null}
                {placed.map((node) => (
                    <g key={node.key} data-kind={node.kind}>
                        <title>
                            {node.approval
                                ? `${node.label} · ${t("mc.setup.diagram.approval", { environment: node.approval })}`
                                : node.label}
                        </title>
                        <NodeMark node={node} />
                        <text
                            x={node.x}
                            y={node.y + 21}
                            textAnchor="middle"
                            className="text-10"
                            style={{ fill: "var(--color-secondary)" }}
                        >
                            {shorten(node.label)}
                        </text>
                        {node.approval ? (
                            <text
                                x={node.x}
                                y={node.y - 12}
                                textAnchor="middle"
                                className="text-10"
                                style={{ fill: "var(--color-warning)" }}
                            >
                                {shorten(t("mc.setup.diagram.approvalShort", { environment: node.approval }))}
                            </text>
                        ) : null}
                    </g>
                ))}
            </svg>
            <div className="flex flex-wrap gap-3 border-t border-border px-2 py-1 text-10 text-muted">
                <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full bg-accent" />
                    {t("mc.setup.diagram.legendCommand")}
                </span>
                <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rounded-full border border-dashed border-accent" />
                    {t("mc.setup.diagram.legendManual")}
                </span>
                <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-2 rotate-45 bg-accent" />
                    {t("mc.setup.diagram.legendTag")}
                </span>
                <span className="flex items-center gap-1">
                    <span className="inline-block h-2 w-3 rounded-4 border border-primary/60" />
                    {t("mc.setup.diagram.legendWorkflow")}
                </span>
            </div>
        </div>
    );
}
