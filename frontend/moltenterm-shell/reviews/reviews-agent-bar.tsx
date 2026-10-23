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
import { useEffect, useMemo, useState } from "react";
import { AgentStates } from "../agent-state-store";
import { TFunction, useT } from "../i18n/i18n";
import { serverText } from "../i18n/server-text";
import { reviewProjectCommands, useTrustAsk } from "../mission/trust-approval";
import { MoltenWave } from "../molten-button";
import { showPanel } from "../review/review-panels";
import { DominoLoader } from "../suite/suite";
import { TabActivity, whileShown } from "../tab-activity";
import { agentGlyph } from "../tab-identity";
import { useWorkingBeat } from "../working-beat";
import { pathBaseName } from "../workspace-project";
import { PrSignature, signatureLine } from "./pr-signature";
import type { AgentSignature, RebaseAsk, ReviewPr } from "./reviews-model";
import { PrTask, PrTaskState, prTaskState, taskAgentLive, taskStateText } from "./reviews-task-model";
import { useUpcomingAnswer } from "./reviews-upcoming-client";
import {
    AgentBarFacts,
    barStateText,
    barTimeText,
    boardStatusText,
    branchAgent,
    DraftTurn,
    draftTurn,
} from "./reviews-upcoming-model";

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

// A task the line follows (#954): stuck or done, in its own words; name: the agent that took it, for a gone one.
export type BarTask = { state: PrTaskState; text: string; name?: string };

// The commit signers after the live agent (#954, FR-REV-029 AC4): the last one's first name, "+N" for the others, all
// on hover. Nothing when the live agent is the only signer.
function signersSuffix(t: TFunction, signers: AgentSignature[], liveName: string): { text: string; title: string } {
    if (!signers?.length) {
        return null;
    }
    const names = [...new Set(signers.map((s) => s.firstname || s.agent).filter((n) => !!n))];
    const others = names.filter((n) => n !== liveName);
    if (others.length === 0) {
        return null;
    }
    const who =
        others.length > 1 ? t("reviewsAgents.signedMore", { name: others[0], count: others.length - 1 }) : others[0];
    return {
        text: t("reviewsAgents.signedBy", { who }),
        title: t("reviews.signature.title", { list: signers.map(signatureLine).join("\n") }),
    };
}

const BarClasses =
    "relative -mx-3 -mb-2.5 mt-1 flex min-w-0 flex-wrap items-center gap-x-2 border-t border-border/50 bg-black/20 py-1 pr-2 pl-3.5 text-11 leading-5 text-muted";

export function AgentBar({
    facts,
    signers,
    task,
    actions,
}: {
    facts: AgentBarFacts;
    signers?: AgentSignature[];
    task?: BarTask;
    actions?: React.ReactNode;
}) {
    const t = useT();
    const now = useMinuteNow();
    const fullConfig = useAtomValue(atoms?.fullConfigAtom ?? (NullAtom as Atom<FullConfigType>));
    const trustDir = useTrustAsk(facts?.blockId);
    useWorkingBeat(facts?.state === "working");
    if (facts == null) {
        return task != null ? <GoneAgentBar task={task} actions={actions} /> : null;
    }
    const presets = fullConfig?.presets as Record<string, Record<string, unknown>>;
    const background = facts.kind === "background";
    const name = background ? t("reviewsAgents.background") : facts.name || t("reviewsAgents.agent");
    const taskShown = task != null && task.state !== "running" && !!task.text;
    const stuck = taskShown && task.state === "stuck";
    const stateText = taskShown
        ? task.text
        : facts.held != null
          ? serverText(facts.held.text, facts.held.english)
          : barStateText(t, facts.state);
    const timeText = barTimeText(t, facts, now);
    const signed = signersSuffix(t, signers, facts.name);
    const rail = stuck ? "waiting" : facts.state;
    const goTo = (e: React.MouseEvent, blockId: string) => {
        e.stopPropagation();
        fireAndForget(() => showPanel(blockId));
    };
    return (
        <div
            className={BarClasses}
            data-testid="reviews-agent-bar"
            data-state={facts.state}
            data-task={taskShown ? task.state : undefined}
            data-kind={facts.kind}
            aria-label={[name, stateText, timeText, signed?.text].filter((s) => !!s).join(", ")}
            role="group"
        >
            {RailClasses[rail] ? (
                <span
                    className={cn("absolute inset-y-0 -left-px w-0.5", RailClasses[rail])}
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
                    facts.held != null || taskShown ? "min-w-0 truncate" : "shrink-0",
                    facts.state === "waiting" || stuck
                        ? "font-semibold text-[var(--mt-state-waiting)]"
                        : taskShown
                          ? "text-[var(--mt-state-done)]"
                          : "text-secondary"
                )}
                title={facts.held != null || taskShown ? stateText : undefined}
                data-testid="reviews-agent-state"
            >
                {stateText}
            </span>
            {!stuck && (facts.state === "working" || facts.state === "background") ? (
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
            {signed != null ? (
                <span className="min-w-0 truncate" title={signed.title} data-testid="reviews-agent-signers">
                    <span className="mr-2 opacity-50" aria-hidden>
                        ·
                    </span>
                    {signed.text}
                </span>
            ) : null}
            <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1">
                {trustDir ? (
                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            fireAndForget(() => reviewProjectCommands(trustDir));
                        }}
                        onKeyDown={stop}
                        className="molten-btn h-5 cursor-pointer rounded-3 px-1.5 text-11"
                        title={t("reviewsAgents.trustReviewTitle", { name, project: pathBaseName(trustDir) })}
                        data-testid="reviews-agent-trust"
                    >
                        {t("reviewsAgents.trustReview")}
                        <MoltenWave />
                    </button>
                ) : null}
                {actions}
                {!background && facts.blockId ? (
                    <button
                        type="button"
                        onClick={(e) => goTo(e, facts.blockId)}
                        onKeyDown={stop}
                        className={BarButton}
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
                        className={cn(BarButton, "min-w-0 shrink")}
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
        </div>
    );
}

export const BarButton =
    "flex h-5 shrink-0 cursor-pointer items-center gap-1.5 rounded-3 border border-transparent px-1.5 text-secondary hover:border-border hover:bg-hover hover:text-primary focus-visible:border-border";

// The line of a task whose agent's session is gone (#954): its name, what it left, and Retry.
function GoneAgentBar({ task, actions }: { task: BarTask; actions?: React.ReactNode }) {
    const t = useT();
    const stuck = task.state === "stuck";
    if (!task.text) {
        return null;
    }
    return (
        <div
            className={BarClasses}
            data-testid="reviews-agent-bar"
            data-state="gone"
            data-task={task.state}
            aria-label={[task.name, task.text].filter((s) => !!s).join(", ")}
            role="group"
        >
            {stuck ? (
                <span
                    className={cn("absolute inset-y-0 -left-px w-0.5", RailClasses.waiting)}
                    data-testid="reviews-agent-rail"
                    aria-hidden
                />
            ) : null}
            <i className="fa fa-solid fa-robot w-3 shrink-0 text-center text-secondary" aria-hidden />
            <span className="shrink-0 truncate font-medium text-primary" data-testid="reviews-agent-name">
                {task.name || t("reviewsAgents.agent")}
            </span>
            <span
                className={cn(
                    "min-w-0 truncate",
                    stuck ? "font-semibold text-[var(--mt-state-waiting)]" : "text-[var(--mt-state-done)]"
                )}
                title={task.text}
                data-testid="reviews-agent-state"
            >
                {task.text}
            </span>
            <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1">{actions}</div>
        </div>
    );
}

// The PR's one "who" line (#954, FR-REV-022 AC6 and AC7, FR-REV-029 AC4): the live agent first, the commit signers
// after it; the task asked from the row, stuck or done, with Retry, Open its work and Stop. Without a live agent or a
// task, the signers alone; with none of them, nothing.
export function RowAgentLine({
    dir,
    pr,
    task,
    onRetry,
    onOpenWork,
    onStop,
}: {
    dir: string;
    pr: ReviewPr;
    task: RebaseAsk;
    onRetry: () => void;
    onOpenWork: (blockId: string) => Promise<string>;
    onStop: (blockId: string) => Promise<string>;
}) {
    const t = useT();
    const facts = useBranchAgent(dir, pr.branch);
    const now = useMinuteNow();
    const [confirmStop, setConfirmStop] = useState(false);
    const [busy, setBusy] = useState<"work" | "stop">(null);
    const [error, setError] = useState("");
    const prTask: PrTask = task != null ? { ...task, kind: task.kind ?? "rebase" } : null;
    const state = prTaskState(prTask, pr, facts, now);
    const live = taskAgentLive(prTask, facts);
    const barTask: BarTask =
        prTask == null ? null : { state, text: taskStateText(t, prTask, state, live, pr), name: prTask.name };
    if (facts == null && barTask?.state !== "stuck") {
        return <PrSignature agents={pr.agents} testId="reviews-signature" />;
    }
    const liveBlock = facts?.kind === "panel" && live ? facts.blockId : "";
    const run = (what: "work" | "stop", fn: () => Promise<string>) => {
        if (busy != null) {
            return;
        }
        setBusy(what);
        setError("");
        fireAndForget(async () => {
            try {
                setError(await fn());
            } finally {
                setBusy(null);
                setConfirmStop(false);
            }
        });
    };
    const click = (fn: () => void) => (e: React.MouseEvent) => {
        e.stopPropagation();
        fn();
    };
    let actions: React.ReactNode = null;
    if (confirmStop && liveBlock) {
        actions = (
            <>
                <span className="truncate text-secondary" data-testid="reviews-agent-stop-confirm">
                    {t("reviewsAgents.stop.confirm", { name: facts.name || prTask?.name || "" })}
                </span>
                <button
                    type="button"
                    onClick={click(() => run("stop", () => onStop(liveBlock)))}
                    onKeyDown={stop}
                    className="molten-btn molten-btn-destructive h-5 cursor-pointer rounded-3 px-1.5 text-11"
                    data-testid="reviews-agent-stop-yes"
                >
                    {busy === "stop" ? <DominoLoader /> : null}
                    {t("reviewsAgents.stop.button")}
                    <MoltenWave />
                </button>
                <button
                    type="button"
                    onClick={click(() => setConfirmStop(false))}
                    onKeyDown={stop}
                    className={BarButton}
                    data-testid="reviews-agent-stop-no"
                >
                    {t("reviewsAgents.stop.cancel")}
                </button>
            </>
        );
    } else if (barTask != null && state !== "done") {
        const what = t(`reviewsAgents.task.what.${prTask.kind}`);
        actions = (
            <>
                {state === "stuck" ? (
                    <button
                        type="button"
                        onClick={click(onRetry)}
                        onKeyDown={stop}
                        className={BarButton}
                        title={
                            live
                                ? t("reviewsAgents.retryTitle", { what, name: prTask.name })
                                : t("reviewsAgents.retryGoneTitle", { what, name: prTask.name })
                        }
                        data-testid="reviews-agent-retry"
                    >
                        <i className="fa fa-solid fa-rotate-right text-10" aria-hidden />
                        {t("reviewsAgents.retry")}
                    </button>
                ) : null}
                {liveBlock ? (
                    <button
                        type="button"
                        onClick={click(() => run("work", () => onOpenWork(liveBlock)))}
                        onKeyDown={stop}
                        aria-busy={busy === "work" || undefined}
                        className={BarButton}
                        title={t("reviewsAgents.work.title", { number: pr.number, name: facts.name })}
                        data-testid="reviews-agent-work"
                    >
                        {busy === "work" ? (
                            <DominoLoader />
                        ) : (
                            <i className="fa fa-solid fa-table-columns text-10" aria-hidden />
                        )}
                        {t("reviewsAgents.work.button")}
                    </button>
                ) : null}
                {liveBlock ? (
                    <button
                        type="button"
                        onClick={click(() => setConfirmStop(true))}
                        onKeyDown={stop}
                        className={BarButton}
                        title={t("reviewsAgents.stop.title", { name: facts.name })}
                        data-testid="reviews-agent-stop"
                    >
                        <i className="fa fa-solid fa-stop text-10" aria-hidden />
                        {t("reviewsAgents.stop.button")}
                    </button>
                ) : null}
            </>
        );
    }
    return (
        <>
            {error ? (
                <div className="text-12 leading-4 text-danger" role="status" data-testid="reviews-agent-error">
                    {error}
                </div>
            ) : null}
            {/* A stuck task whose agent is gone is told by its own name, not by whoever is on the branch now. */}
            <AgentBar
                facts={!live && state === "stuck" ? null : facts}
                signers={pr.agents}
                task={barTask}
                actions={actions}
            />
        </>
    );
}

const DraftChipClasses: Record<DraftTurn["owner"], string> = {
    agent: "border-border bg-hover text-muted",
    developer: "border-warning/40 bg-warning/10 text-warning",
};

const DraftChipIcons: Record<DraftTurn["kind"], string> = {
    agent: "robot",
    test: "vial",
    ready: "flag-checkered",
    yours: "user",
};

// Whose turn a draft is (AC3, #954), as a chip of the row: never the developer's while an agent works on its branch,
// is in an agent's column of the board, or pushed a commit lately; else what the developer is expected to do.
export function DraftTurnChip({ dir, branch }: { dir: string; branch: string }) {
    const t = useT();
    const facts = useBranchAgent(dir, branch);
    const upcoming = useUpcomingAnswer(dir);
    const now = useMinuteNow();
    const draft = upcoming?.drafts?.find((d) => d.branch === branch);
    // Before wavesrv read this draft (its answer can predate GitHub's), nobody knows whose it is: no chip rather than
    // a wrong "yours". An agent seen on the branch is enough.
    if (upcoming == null || (draft == null && facts == null)) {
        return null;
    }
    const turn = draftTurn(facts, draft, now);
    const status = turn.status ? boardStatusText(t, turn.status) : "";
    const title = [
        t(`reviewsAgents.draft.${turn.kind}Title`),
        status ? t("reviewsAgents.draft.status", { status }) : "",
    ]
        .filter((s) => !!s)
        .join("\n");
    return (
        <span
            className={cn(
                "inline-flex items-center gap-1 rounded-4 border px-1.5 py-0.5 text-11 leading-4 whitespace-nowrap",
                DraftChipClasses[turn.owner]
            )}
            title={title}
            data-testid="reviews-draft-turn"
            data-owner={turn.owner}
            data-kind={turn.kind}
        >
            <i className={cn("fa fa-solid text-10", `fa-${DraftChipIcons[turn.kind]}`)} aria-hidden />
            {t(`reviewsAgents.draft.${turn.kind}`)}
        </span>
    );
}
