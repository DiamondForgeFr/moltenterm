// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The agent bar under a Reviews tile (#712, FR-REV-022): a slim strip docked under the tile, a shade darker, whose
// left rail carries the agent's state in the states' fixed palette (#212): working's orange dimmed on the shared
// working beat (still under reduced motion, #473), waiting's amber, done's green. The text stays quiet (11 px, muted),
// the first name reads in the main colour, and Go to takes the window to the agent's panel. A background agent (run
// inside another agent) is "probably active", without Go to, with its parent session when one stands out. The
// durations follow one minute clock shared by every bar, so the list itself never renders again for them. A working or
// background agent also shows the suite's falling dominoes next to its state (#739), so the bar visibly works. A sub-agent
// a panel started (#1035) is named by its parent, tool, model and task, with its own state; Go to shows the parent.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget, makeIconClass, NullAtom } from "@/util/util";
import { atom, Atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import type { AgentStatesData } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { TFunction, useT } from "../i18n/i18n";
import { Phrase, useWordPhrase } from "../i18n/phrase";
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
import { reviewsGet } from "./reviews-client";
import type { AgentSignature, RebaseAsk, ReviewPr } from "./reviews-model";
import {
    agentLines,
    headStillFails,
    PrTask,
    PrTaskState,
    prTaskState,
    taskAgent,
    taskAgentLive,
    taskStateText,
} from "./reviews-task-model";
import { useUpcomingAnswer } from "./reviews-upcoming-client";
import {
    AgentBarFacts,
    barStateText,
    barTimeText,
    boardStatusText,
    branchAgent,
    branchAgents,
    DraftTurn,
    draftTurn,
    subagentDetails,
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

// Every agent on a branch of the project, live (#1057), and the windows' agent states, which name a task's terminal
// once it left the branch.
function useBranchAgents(dir: string, branch: string): { agents: AgentBarFacts[]; states: AgentStatesData } {
    const upcoming = useUpcomingAnswer(dir);
    const states = useAtomValue(AgentStates.getInstance().dataAtom);
    const agents = useMemo(() => branchAgents(upcoming, states, branch), [upcoming, states, branch]);
    return { agents, states };
}

// The agent a row's task is judged against, with the branch's agents and the task's state now.
function useTaskAgent(dir: string, pr: ReviewPr, task: RebaseAsk) {
    const { agents, states } = useBranchAgents(dir, pr.branch);
    const now = useMinuteNow();
    const prTask: PrTask = task != null ? { ...task, kind: task.kind ?? "rebase" } : null;
    const owner = taskAgent(prTask, agents, states);
    return { agents, prTask, owner, state: prTaskState(prTask, pr, owner, now) };
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

// The bar docks at the tile's bottom edge; several bars (#1057) dock as one stack, each without its own dock margins.
const BarDock = "-mx-3 -mb-2.5 mt-1";
const BarBody =
    "relative flex min-w-0 flex-wrap items-center gap-x-2 border-t border-border/50 bg-black/20 py-1 pr-2 pl-3.5 text-11 leading-5 text-muted";

function barClasses(stacked: boolean): string {
    return stacked ? BarBody : cn(BarDock, BarBody);
}

export function AgentBar({
    facts,
    signers,
    task,
    actions,
    stacked,
}: {
    facts: AgentBarFacts;
    signers?: AgentSignature[];
    task?: BarTask;
    actions?: React.ReactNode;
    stacked?: boolean;
}) {
    const t = useT();
    const now = useMinuteNow();
    const fullConfig = useAtomValue(atoms?.fullConfigAtom ?? (NullAtom as Atom<FullConfigType>));
    const trustDir = useTrustAsk(facts?.blockId);
    useWorkingBeat(facts?.state === "working");
    if (facts == null) {
        return task != null ? <GoneAgentBar task={task} actions={actions} stacked={stacked} /> : null;
    }
    const presets = fullConfig?.presets as Record<string, Record<string, unknown>>;
    const background = facts.kind === "background";
    const subagent = facts.kind === "subagent";
    const name = background
        ? t("reviewsAgents.background")
        : subagent
          ? facts.parentName
              ? t("reviewsAgents.subagent.of", { name: facts.parentName })
              : t("reviewsAgents.subagent.name")
          : facts.name || t("reviewsAgents.agent");
    const details = subagentDetails(facts);
    const taskShown = task != null && task.state !== "running" && !!task.text;
    const stuck = taskShown && task.state === "stuck";
    const barTime = barTimeText(t, facts, now);
    // A finished sub-agent says its state once, with its time: "finished 13 min ago".
    const finishedLine = !taskShown && facts.held == null && subagent && facts.subState === "done" ? barTime : "";
    const stateText = taskShown
        ? task.text
        : facts.held != null
          ? serverText(facts.held.text, facts.held.english)
          : finishedLine
            ? finishedLine
            : subagent
              ? t(`reviewsAgents.subagent.state.${facts.subState ?? "running"}`)
              : barStateText(t, facts.state);
    const timeText = finishedLine ? "" : barTime;
    const signed = signersSuffix(t, signers, facts.name);
    const rail = stuck ? "waiting" : facts.state;
    const goTo = (e: React.MouseEvent, blockId: string) => {
        e.stopPropagation();
        fireAndForget(() => showPanel(blockId));
    };
    return (
        <div
            className={barClasses(stacked)}
            data-testid="reviews-agent-bar"
            data-state={facts.state}
            data-task={taskShown ? task.state : undefined}
            data-kind={facts.kind}
            aria-label={[name, details, stateText, timeText, signed?.text].filter((s) => !!s).join(", ")}
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
            {details ? (
                <span className="min-w-0 truncate text-secondary" title={details} data-testid="reviews-agent-details">
                    {details}
                </span>
            ) : null}
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
                {subagent && facts.parentBlockId ? (
                    <button
                        type="button"
                        onClick={(e) => goTo(e, facts.parentBlockId)}
                        onKeyDown={stop}
                        className={BarButton}
                        title={t("reviewsAgents.goToTitle", { name: facts.parentName || t("reviewsAgents.agent") })}
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
function GoneAgentBar({ task, actions, stacked }: { task: BarTask; actions?: React.ReactNode; stacked?: boolean }) {
    const t = useT();
    const stuck = task.state === "stuck";
    if (!task.text) {
        return null;
    }
    return (
        <div
            className={barClasses(stacked)}
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

// The heads already read again because their agent said done while checks failed there: once per head and names.
const ReadAgainHeads = new Set<string>();

// No stale contradiction (#1020, FR-REV-028 AC8): the agent reads as done, or its task stopped, while checks fail on the
// PR's head. The list reads GitHub again once (the row may show an older head), then says what still fails there.
export function HeadStillFailsLine({ dir, pr, task }: { dir: string; pr: ReviewPr; task: RebaseAsk }) {
    const t = useT();
    const { agents, state } = useTaskAgent(dir, pr, task);
    const names = headStillFails(pr, agents[0] ?? null, state);
    const key = names.length > 0 ? `${dir}#${pr.number}@${pr.headoid ?? ""}:${names.join(",")}` : "";
    useEffect(() => {
        if (!key || ReadAgainHeads.has(key)) {
            return;
        }
        ReadAgainHeads.add(key);
        fireAndForget(async () => {
            await reviewsGet(dir, true);
        });
    }, [key, dir]);
    if (names.length === 0) {
        return null;
    }
    return (
        <div className="text-12 leading-4 text-danger" role="status" data-testid="reviews-head-still-fails">
            {t("reviews.ci.investigate.headStillFails", {
                head: (pr.headoid ?? "").slice(0, 7),
                names: names.join(", "),
            })}
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
    onOpenWork: (blockId: string) => Promise<Phrase>;
    onStop: (blockId: string) => Promise<Phrase>;
}) {
    const t = useT();
    const word = useWordPhrase();
    const { agents, prTask, owner: facts, state } = useTaskAgent(dir, pr, task);
    const [confirmStop, setConfirmStop] = useState(false);
    const [busy, setBusy] = useState<"work" | "stop">(null);
    const [error, setError] = useState<Phrase>(null);
    const live = taskAgentLive(prTask, facts);
    const barTask: BarTask =
        prTask == null ? null : { state, text: taskStateText(t, prTask, state, live, pr), name: prTask.name };
    if (agents.length === 0 && facts == null && barTask?.state !== "stuck") {
        return <PrSignature agents={pr.agents} testId="reviews-signature" />;
    }
    const liveBlock = facts?.kind === "panel" && live ? facts.blockId : "";
    const lines = agentLines(agents, prTask, facts);
    const run = (what: "work" | "stop", fn: () => Promise<Phrase>) => {
        if (busy != null) {
            return;
        }
        setBusy(what);
        setError(null);
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
            {error != null ? (
                <div className="text-12 leading-4 text-danger" role="status" data-testid="reviews-agent-error">
                    {word(error)}
                </div>
            ) : null}
            {/* Every agent of the branch says its own state (#1057); the task's line is its own agent's, and a stuck
                task whose agent is gone is told by its own name, not by whoever is on the branch now. */}
            <div className={cn(BarDock, "flex flex-col")} data-testid="reviews-agent-lines">
                {lines.map((line, i) => (
                    <AgentBar
                        key={line.facts?.blockId ?? `${line.facts?.kind ?? "gone"}-${i}`}
                        facts={line.task && !live && state === "stuck" ? null : line.facts}
                        signers={i === 0 ? pr.agents : undefined}
                        task={line.task ? barTask : undefined}
                        actions={line.task ? actions : undefined}
                        stacked
                    />
                ))}
            </div>
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
