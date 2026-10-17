// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The agent bar under a Reviews tile (#712, FR-REV-022): a slim strip docked under the tile, a shade darker, whose
// left rail carries the agent's state in the states' fixed palette (#212): working's orange dimmed on the shared
// working beat (still under reduced motion, #473), waiting's amber, done's green. The text stays quiet (11 px, muted),
// the first name reads in the main colour, and Go to takes the window to the agent's panel. A background agent (run
// inside another agent) is "probably active", without Go to, with its parent session when one stands out. The
// durations follow one minute clock shared by every bar, so the list itself never renders again for them. A working or
// background agent also shows the suite's falling dominoes next to its state (#739), so the bar visibly works.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget, makeIconClass, NullAtom } from "@/util/util";
import { atom, Atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect, useMemo } from "react";
import { AgentStates } from "../agent-state-store";
import { useT } from "../i18n/i18n";
import { serverText } from "../i18n/server-text";
import { showPanel } from "../review/review-panels";
import { DominoLoader } from "../suite/suite";
import { TabActivity, whileShown } from "../tab-activity";
import { agentGlyph } from "../tab-identity";
import { useWorkingBeat } from "../working-beat";
import { useUpcomingAnswer } from "./reviews-upcoming-client";
import { AgentBarFacts, barStateText, barTimeText, branchAgent, draftIsYours } from "./reviews-upcoming-model";

const MinuteMs = 60_000;

// One clock for every bar: it ticks each minute while a bar is shown and the window is.
export class MinuteClock {
    private static instance: MinuteClock = null;

    nowAtom = atom(Date.now()) as PrimitiveAtom<number>;
    holders = 0;
    stop: () => void = null;

    private constructor() {}

    static getInstance(): MinuteClock {
        if (MinuteClock.instance == null) {
            MinuteClock.instance = new MinuteClock();
        }
        return MinuteClock.instance;
    }

    retain(): () => void {
        this.holders++;
        globalStore.set(this.nowAtom, Date.now());
        if (this.stop == null) {
            this.stop = TabActivity.getInstance().every(
                whileShown(MinuteMs),
                () => globalStore.set(this.nowAtom, Date.now()),
                "reviews-agent-clock"
            );
        }
        return () => {
            this.holders--;
            if (this.holders <= 0 && this.stop != null) {
                this.stop();
                this.stop = null;
            }
        };
    }
}

function useMinuteNow(): number {
    const clock = MinuteClock.getInstance();
    useEffect(() => clock.retain(), [clock]);
    return useAtomValue(clock.nowAtom);
}

// The agent on a branch of the project, live: wavesrv's placement and the windows' agent states.
export function useBranchAgent(dir: string, branch: string): AgentBarFacts {
    const upcoming = useUpcomingAnswer(dir);
    const states = useAtomValue(AgentStates.getInstance().dataAtom);
    return useMemo(() => branchAgent(upcoming, states, branch), [upcoming, states, branch]);
}

// The rail sits on the tile's 1 px border, 1 px to the left (the lists clip at their border edge for it), so the bar
// keeps one left edge (#738). Idle and background draw none: the tile's border alone.
const RailClasses: Record<string, string> = {
    working: "bg-[var(--mt-state-working)] mt-beat-blink",
    waiting: "bg-[var(--mt-state-waiting)]",
    done: "bg-[var(--mt-state-done)]",
};

// The row's own controls keep their click and keys: the tile's click opens the review.
function stop(e: React.SyntheticEvent) {
    e.stopPropagation();
}

export function AgentBar({ facts }: { facts: AgentBarFacts }) {
    const t = useT();
    const now = useMinuteNow();
    const fullConfig = useAtomValue(atoms?.fullConfigAtom ?? (NullAtom as Atom<FullConfigType>));
    useWorkingBeat(facts?.state === "working");
    if (facts == null) {
        return null;
    }
    const presets = fullConfig?.presets as Record<string, Record<string, unknown>>;
    const background = facts.kind === "background";
    const name = background ? t("reviewsAgents.background") : facts.name || t("reviewsAgents.agent");
    const stateText =
        facts.held != null ? serverText(facts.held.text, facts.held.english) : barStateText(t, facts.state);
    const timeText = barTimeText(t, facts, now);
    const goTo = (e: React.MouseEvent, blockId: string) => {
        e.stopPropagation();
        fireAndForget(() => showPanel(blockId));
    };
    return (
        <div
            className="relative -mx-3 -mb-2.5 mt-1 flex min-w-0 items-center gap-2 border-t border-border/50 bg-black/20 py-1 pr-2 pl-3.5 text-11 leading-5 text-muted"
            data-testid="reviews-agent-bar"
            data-state={facts.state}
            data-kind={facts.kind}
            aria-label={[name, stateText, timeText].filter((s) => !!s).join(", ")}
            role="group"
        >
            {RailClasses[facts.state] ? (
                <span
                    className={cn("absolute inset-y-0 -left-px w-0.5", RailClasses[facts.state])}
                    data-testid="reviews-agent-rail"
                    aria-hidden
                />
            ) : null}
            <i
                className={cn(
                    makeIconClass(agentGlyph(facts.agent, presets), true, { defaultIcon: "robot" }),
                    "w-3 shrink-0 text-center text-secondary"
                )}
                aria-hidden
            />
            <span
                className={cn("shrink-0 truncate", background ? "text-secondary italic" : "font-medium text-primary")}
                data-testid="reviews-agent-name"
            >
                {name}
            </span>
            <span
                className={cn(
                    facts.held != null ? "min-w-0 truncate" : "shrink-0",
                    facts.state === "waiting" ? "font-semibold text-[var(--mt-state-waiting)]" : "text-secondary"
                )}
                title={facts.held != null ? stateText : undefined}
                data-testid="reviews-agent-state"
            >
                {stateText}
            </span>
            {facts.state === "working" || facts.state === "background" ? (
                <DominoLoader
                    className={facts.state === "working" ? "text-[var(--mt-state-working)]" : "text-secondary"}
                />
            ) : null}
            {timeText ? (
                <span className="min-w-0 truncate" data-testid="reviews-agent-time">
                    <span className="mr-2 opacity-50" aria-hidden>
                        ·
                    </span>
                    {timeText}
                </span>
            ) : null}
            {!background && facts.blockId ? (
                <button
                    type="button"
                    onClick={(e) => goTo(e, facts.blockId)}
                    onKeyDown={stop}
                    className="ml-auto flex h-5 shrink-0 cursor-pointer items-center gap-1.5 rounded-3 border border-transparent px-1.5 text-secondary hover:border-border hover:bg-hover hover:text-primary focus-visible:border-border"
                    title={t("reviewsAgents.goToTitle", { name })}
                    data-testid="reviews-agent-goto"
                >
                    {t("reviewsAgents.goTo")}
                    <i className="fa fa-solid fa-arrow-right text-10" aria-hidden />
                </button>
            ) : null}
            {background && facts.parentBlockId ? (
                <button
                    type="button"
                    onClick={(e) => goTo(e, facts.parentBlockId)}
                    onKeyDown={stop}
                    className="ml-auto flex h-5 min-w-0 shrink cursor-pointer items-center gap-1.5 rounded-3 border border-transparent px-1.5 text-secondary hover:border-border hover:bg-hover hover:text-primary"
                    title={t("reviewsAgents.parentTitle", { name: facts.parentName || t("reviewsAgents.agent") })}
                    data-testid="reviews-agent-parent"
                >
                    <span className="truncate">
                        {t("reviewsAgents.parent", { name: facts.parentName || t("reviewsAgents.agent") })}
                    </span>
                    <i className="fa fa-solid fa-arrow-right text-10" aria-hidden />
                </button>
            ) : null}
        </div>
    );
}

// The mount point in a Reviews tile: the bar of the agent on the PR's branch, nothing without one.
export function RowAgentBar({ dir, branch }: { dir: string; branch: string }) {
    const facts = useBranchAgent(dir, branch);
    if (facts == null) {
        return null;
    }
    return <AgentBar facts={facts} />;
}

// A draft no agent works on is the developer's (AC3).
export function YoursMarker({ dir, branch, draft }: { dir: string; branch: string; draft: boolean }) {
    const t = useT();
    const facts = useBranchAgent(dir, branch);
    const upcoming = useUpcomingAnswer(dir);
    // Before wavesrv answered, nobody knows whose the draft is.
    if (upcoming == null || !draftIsYours(draft, facts)) {
        return null;
    }
    return (
        <span
            className="ml-1.5 inline-flex h-4 items-center rounded-3 border border-border px-1 align-[1px] text-10 font-semibold tracking-[0.08em] text-secondary uppercase"
            title={t("reviewsAgents.yoursTitle")}
            data-testid="reviews-yours"
        >
            {t("reviewsAgents.yours")}
        </span>
    );
}
