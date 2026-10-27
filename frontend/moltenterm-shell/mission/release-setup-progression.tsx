// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The pipeline setup's progression (epic #1149, #1163): the three markers Understand, Adjust and Validate, each a large
// icon tile with its parts as small tiles beside it, in the DiamondForge suite's progression look (the forge stepper of
// DiamondForge's new project wizard): the current marker a filled accent tile, the done ones green with a check badge,
// the next ones grey. The thin connectors between markers fill as the setup moves on and carry a count (the changes
// waiting). Changes go through the app's molten motion: a marker taking the lead gets the glow pass.

import { cn } from "@/util/util";
import {
    BadgeCheck,
    BookOpenText,
    Check,
    GitPullRequest,
    LayoutTemplate,
    type LucideIcon,
    MessagesSquare,
    PencilLine,
    ScanSearch,
    SlidersHorizontal,
    Workflow,
} from "lucide-react";
import { useT } from "../i18n/i18n";
import { useGlowPass } from "../molten-motion";

export type ProgressState = "done" | "current" | "upcoming";

export type ProgressPart = {
    id: string;
    icon: LucideIcon;
    // An i18n key: the part's name, shown as the tile's title.
    labelKey: string;
    state: ProgressState;
};

export type ProgressMarker = {
    id: string;
    icon: LucideIcon;
    labelKey: string;
    subtitleKey: string;
    parts: ProgressPart[];
    // The count the connector before this marker carries (changes waiting), hidden at 0.
    countIn?: number;
    countInKey?: string;
    // Going back to a marker already done; the current and the next ones are reached through the screens' buttons.
    onClick?: () => void;
};

// The setup's own markers, from where the stepper is: step 1 and 2a are Understand, 2b (describing) is Adjust, step 3
// and the template are Validate. The connectors count the proposals waiting and the changes accepted.
export function setupProgress(at: {
    step: "detect" | "understand" | "prepare" | "template";
    path: "analyse" | "describe";
    open: number;
    accepted: number;
    prOpened: boolean;
    templateSaved: boolean;
}): { current: number; markers: Omit<ProgressMarker, "onClick">[] } {
    const current = at.step === "prepare" || at.step === "template" ? 2 : at.path === "describe" ? 1 : 0;
    const part = (id: string, icon: LucideIcon, state: ProgressState): ProgressPart => ({
        id,
        icon,
        labelKey: `mc.setup.progress.part.${id}`,
        state,
    });
    const after = (marker: number): ProgressState => (current > marker ? "done" : "upcoming");
    return {
        current,
        markers: [
            {
                id: "understand",
                icon: BookOpenText,
                labelKey: "mc.setup.progress.understand",
                subtitleKey: "mc.setup.progress.understandSub",
                parts: [
                    part("read", ScanSearch, at.step === "detect" ? "current" : "done"),
                    part("flow", Workflow, at.step === "detect" ? "upcoming" : current === 0 ? "current" : "done"),
                ],
            },
            {
                id: "adjust",
                icon: SlidersHorizontal,
                labelKey: "mc.setup.progress.adjust",
                subtitleKey: "mc.setup.progress.adjustSub",
                countIn: at.open,
                countInKey: "mc.setup.progress.openCount",
                parts: [
                    part("describe", PencilLine, current === 1 ? "current" : after(1)),
                    part(
                        "proposals",
                        MessagesSquare,
                        at.open > 0 ? "current" : at.accepted > 0 ? "done" : current > 1 ? "done" : "upcoming"
                    ),
                ],
            },
            {
                id: "validate",
                icon: BadgeCheck,
                labelKey: "mc.setup.progress.validate",
                subtitleKey: "mc.setup.progress.validateSub",
                countIn: at.accepted,
                countInKey: "mc.setup.progress.acceptedCount",
                parts: [
                    part(
                        "request",
                        GitPullRequest,
                        at.prOpened ? "done" : at.step === "prepare" ? "current" : "upcoming"
                    ),
                    part(
                        "template",
                        LayoutTemplate,
                        at.templateSaved ? "done" : at.step === "template" ? "current" : "upcoming"
                    ),
                ],
            },
        ],
    };
}

export function progressStates(count: number, current: number): ProgressState[] {
    return Array.from({ length: count }, (_, i) => (i < current ? "done" : i === current ? "current" : "upcoming"));
}

const TileTone: Record<ProgressState, string> = {
    done: "bg-success/80 text-white",
    current:
        "bg-accent text-(--mt-accent-fg) shadow-[inset_0_0_0_2px_rgb(255_255_255/0.25),0_0_18px_-4px_var(--mt-accent)]",
    upcoming: "bg-surface-2 text-muted",
};

const PartTone: Record<ProgressState, string> = {
    done: "bg-success/70 text-white",
    current: "bg-surface-2 text-accent shadow-[inset_0_0_0_1.5px_var(--mt-accent)]",
    upcoming: "bg-surface-2 text-muted",
};

function MarkerTiles({ marker, state }: { marker: ProgressMarker; state: ProgressState }) {
    const t = useT();
    const Icon = marker.icon;
    const glow = useGlowPass(state);
    return (
        <span className="flex flex-none items-start gap-1">
            <span
                className={cn(
                    "relative grid h-11 w-11 place-items-center rounded-4 transition-colors duration-240",
                    TileTone[state],
                    glow
                )}
                data-state={state}
                data-testid={`progress-tile-${marker.id}`}
            >
                <Icon className="h-5 w-5" strokeWidth={1.75} aria-hidden />
                {state === "done" ? (
                    <span className="absolute -top-1 -right-1 grid h-3.5 w-3.5 place-items-center rounded-full bg-(--df-page) text-success">
                        <Check className="h-2.5 w-2.5" strokeWidth={3} aria-hidden />
                    </span>
                ) : null}
            </span>
            {marker.parts.length > 0 ? (
                <span className="flex flex-col gap-1">
                    {marker.parts.map((part) => {
                        const PartIcon = part.icon;
                        return (
                            <span
                                key={part.id}
                                className={cn(
                                    "grid h-5 w-5 place-items-center rounded-2 transition-colors duration-240",
                                    PartTone[part.state]
                                )}
                                title={t(part.labelKey)}
                                data-state={part.state}
                                data-testid={`progress-part-${part.id}`}
                            >
                                <PartIcon className="h-3 w-3" strokeWidth={1.75} aria-hidden />
                            </span>
                        );
                    })}
                </span>
            ) : null}
        </span>
    );
}

function Connector({ filled, count, countKey }: { filled: boolean; count?: number; countKey?: string }) {
    const t = useT();
    return (
        <span className="relative mx-3 flex flex-none items-center" aria-hidden={!count}>
            <span className="relative block h-0.5 w-12 overflow-hidden rounded-2 bg-border">
                <i
                    className={cn(
                        "absolute inset-y-0 left-0 bg-success transition-[width] duration-240",
                        filled ? "w-full" : "w-0"
                    )}
                />
            </span>
            {count > 0 ? (
                <span
                    className="ml-1.5 rounded-full bg-accent px-1.5 font-mono text-10 leading-4 font-semibold text-(--mt-accent-fg)"
                    title={countKey ? t(countKey, { count }) : undefined}
                    data-testid="progress-count"
                >
                    {count}
                </span>
            ) : null}
        </span>
    );
}

export function SetupProgression({ markers, current }: { markers: ProgressMarker[]; current: number }) {
    const t = useT();
    const states = progressStates(markers.length, current);
    return (
        <ol className="flex flex-wrap items-center gap-y-3 py-1" data-testid="setup-progress">
            {markers.map((marker, i) => {
                const state = states[i];
                const clickable = state === "done" && marker.onClick != null;
                return (
                    <li key={marker.id} className="flex items-center">
                        {i > 0 ? (
                            <Connector filled={i <= current} count={marker.countIn} countKey={marker.countInKey} />
                        ) : null}
                        <button
                            type="button"
                            disabled={!clickable}
                            onClick={marker.onClick}
                            aria-current={state === "current" ? "step" : undefined}
                            className={cn(
                                "flex items-center gap-3 rounded-4 text-left disabled:cursor-default",
                                clickable ? "cursor-pointer" : null
                            )}
                            data-testid={`progress-${marker.id}`}
                        >
                            <MarkerTiles marker={marker} state={state} />
                            <span className="flex min-w-0 flex-col">
                                <span
                                    className={cn(
                                        "text-13 leading-5 font-semibold",
                                        state === "upcoming" ? "text-muted" : "text-primary"
                                    )}
                                >
                                    {t(marker.labelKey)}
                                </span>
                                <span className="text-11 text-muted">{t(marker.subtitleKey)}</span>
                            </span>
                        </button>
                    </li>
                );
            })}
        </ol>
    );
}
