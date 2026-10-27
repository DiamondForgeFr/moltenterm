// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The agent bar under a Reviews tile (#712, FR-REV-022): a slim strip docked under the tile, a shade darker, whose
// left rail carries the agent's state in the states' fixed palette (#212): working's orange, waiting's amber, done's
// green; under a Reviews card the card's rail says it instead (#1060). The text stays quiet (11 px, muted),
// the first name reads in the main colour, and Go to takes the window to the agent's panel. A background agent (run
// inside another agent) is "probably active", without Go to, with its parent session when one stands out. The
// durations follow one minute clock shared by every bar, so the list itself never renders again for them. A working or
// background agent also shows the suite's falling dominoes (#739), so the bar visibly works; for a working agent they
// replace the word "working", which stays their accessible name (#1060). A sub-agent
// a panel started (#1035) is named by its parent, tool, model and task, with its own state; Go to shows the parent.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget, makeIconClass, NullAtom } from "@/util/util";
import { atom, Atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
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
import { pathBaseName } from "../workspace-project";
import { PrSignature, signatureLine } from "./pr-signature";
import { BatchRuns, queueKey } from "./reviews-batch-client";
import { reviewsGet } from "./reviews-client";
import type { AgentSignature, RebaseAsk, ReviewPr } from "./reviews-model";
import { cardAgents, type CardContext } from "./reviews-sections-model";
import {
    AgentLine,
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
    DraftTurn,
    draftTurn,
    durationText,
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

export function useMinuteNow(): number {
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

// The agent a row's task is judged against, with every agent on the branch (#1057) and the merge queue's agent on the
// PR it works on (#1128), the task's state now and whether its agent is live; the card's state (#1060) reads the same.
export function useCardAgents(dir: string, pr: ReviewPr, task: RebaseAsk) {
    const ctx = useCardContext(dir);
    const { states, now } = ctx;
    const agents = useMemo(() => cardAgents(pr, ctx), [pr, ctx]);
    const prTask: PrTask = task != null ? { ...task, kind: task.kind ?? "rebase" } : null;
    const owner = taskAgent(prTask, agents, states);
    const live = taskAgentLive(prTask, owner);
    return { agents, prTask, owner, live, now, state: prTaskState(prTask, pr, owner, now) };
}

// What a card's state is computed from besides its PR (#1061): the list and each card read the same context.
export function useCardContext(dir: string): CardContext {
    const t = useT();
    const upcoming = useUpcomingAnswer(dir);
    const states = useAtomValue(AgentStates.getInstance().dataAtom);
    const now = useMinuteNow();
    const runs = useAtomValue(BatchRuns.getInstance().runsAtom);
    return useMemo(
        () => ({
            upcoming,
            states,
            now,
            boardText: (status: string) => boardStatusText(t, status),
            batchRun: (base: string) => runs[queueKey(dir, base)] ?? null,
        }),
        [upcoming, states, now, t, runs, dir]
    );
}

// The rail sits on the tile's 1 px border, 1 px to the left (the lists clip at their border edge for it), so the bar
// keeps one left edge (#738). Idle and background draw none: the tile's border alone. Working's rail stays still: the
// dominoes are the bar's one moving thing (#1060).
const RailClasses: Record<string, string> = {
    working: "bg-[var(--mt-state-working)]",
    waiting: "bg-[var(--mt-state-waiting)]",
    done: "bg-[var(--mt-state-done)]",
};

// The row's own controls keep their click and keys: the tile's click opens the review.
function stop(e: React.SyntheticEvent) {
    e.stopPropagation();
}

// A task the line follows (#954): stuck or done, in its own words; name: the agent that took it, for a gone one.
// quiet: an idle task agent while another agent works on the branch reads "inactive", muted, not as an alarm (#1060).
export type BarTask = { state: PrTaskState; text: string; name?: string; quiet?: boolean };

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
    const word = useWordPhrase();
    const now = useMinuteNow();
    const fullConfig = useAtomValue(atoms?.fullConfigAtom ?? (NullAtom as Atom<FullConfigType>));
    const trustDir = useTrustAsk(facts?.blockId);
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
          : facts.name || t(facts.batch ? "reviews.batch.yourAgent" : "reviewsAgents.agent");
    const details = subagentDetails(facts);
    const taskShown = task != null && task.state !== "running" && !!task.text;
    const stuck = taskShown && task.state === "stuck";
    const barTime = barTimeText(t, facts, now);
    // The merge queue's agent says the queue's work (#1128), as a held state says what MoltenTerm has it do.
    const work = facts.work != null && facts.state !== "waiting" ? word(facts.work) : "";
    const said = facts.held != null || !!work;
    // A finished sub-agent says its state once, with its time: "finished 13 min ago".
    const finishedLine = !taskShown && !said && subagent && facts.subState === "done" ? barTime : "";
    const stateText = taskShown
        ? task.text
        : work
          ? work
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
    // A working agent shows the dominoes in place of the word, which stays its accessible name (#1060).
    const dominoOnly = !taskShown && !said && !finishedLine && facts.state === "working";
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
            {/* Stacked under a card, the card's own rail says the state (#1060). */}
            {RailClasses[rail] && !stacked ? (
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
            {dominoOnly ? (
                <span
                    role="img"
                    aria-label={stateText}
                    title={stateText}
                    className="inline-flex shrink-0 items-center"
                    data-testid="reviews-agent-working"
                >
                    <DominoLoader className="text-[var(--mt-state-working)]" />
                </span>
            ) : (
                <span
                    className={cn(
                        said || taskShown ? "min-w-0 truncate" : "shrink-0",
                        facts.state === "waiting" || (stuck && !task.quiet)
                            ? "font-semibold text-[var(--mt-state-waiting)]"
                            : taskShown && !task.quiet
                              ? "text-[var(--mt-state-done)]"
                              : "text-secondary"
                    )}
                    title={said || taskShown ? stateText : undefined}
                    data-testid="reviews-agent-state"
                >
                    {stateText}
                </span>
            )}
            {!dominoOnly && !stuck && (facts.state === "working" || facts.state === "background") ? (
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
            {stuck && !stacked ? (
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
// PR's head. The list reads GitHub again once (the row may show an older head); the card's state then says the checks
// fail "on the latest commit" (#1060: the failure is said once, no head hash line). Answers the names.
export function useHeadStillFails(dir: string, pr: ReviewPr, agents: AgentBarFacts[], state: PrTaskState): string[] {
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
    return names;
}

// The PR's "who" lines (#954, FR-REV-022 AC6, AC7 and AC10, FR-REV-029 AC4): every agent of the branch with its own
// state, the commit signers after the first; the task asked from the card, stuck or done, on its own agent's line. A
// live panel agent's line offers Open its work and Stop; relaunching a task is the card's action (#1060), not the
// line's. An idle task agent while another agent works reads "inactive", muted. hideGone: the card says a gone task
// agent's stop in its own history line. Without a live agent or a task, the signers alone; with none, nothing.
export function RowAgentLine({
    dir,
    pr,
    task,
    onOpenWork,
    onStop,
    hideGone,
}: {
    dir: string;
    pr: ReviewPr;
    task: RebaseAsk;
    onOpenWork: (blockId: string) => Promise<Phrase>;
    onStop: (blockId: string) => Promise<Phrase>;
    hideGone?: boolean;
}) {
    const t = useT();
    const word = useWordPhrase();
    const { agents, prTask, owner: facts, live, now, state } = useCardAgents(dir, pr, task);
    const [confirmStop, setConfirmStop] = useState<string>(null);
    const [busy, setBusy] = useState<"work" | "stop">(null);
    const [error, setError] = useState<Phrase>(null);
    const othersWork = agents.some((a) => a !== facts && (a.state === "working" || a.kind === "background"));
    const quiet = prTask != null && state === "stuck" && live && othersWork;
    const barTask: BarTask =
        prTask == null
            ? null
            : {
                  state,
                  text: quiet
                      ? t("reviewsAgents.task.inactive", {
                            what: t(`reviewsAgents.task.what.${prTask.kind}`),
                            duration: durationText(t, now - prTask.at),
                        })
                      : taskStateText(t, prTask, state, live, pr),
                  name: prTask.name,
                  quiet,
              };
    const goneStuck = barTask?.state === "stuck" && !live;
    if (agents.length === 0 && facts == null && (!goneStuck || hideGone)) {
        return <PrSignature agents={pr.agents} testId="reviews-signature" />;
    }
    const lines = agentLines(agents, prTask, facts).filter(
        (l) => !(hideGone && l.task && goneStuck && !agents.includes(l.facts))
    );
    if (lines.length === 0) {
        return <PrSignature agents={pr.agents} testId="reviews-signature" />;
    }
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
                setConfirmStop(null);
            }
        });
    };
    const click = (fn: () => void) => (e: React.MouseEvent) => {
        e.stopPropagation();
        fn();
    };
    const actionsOf = (line: AgentLine): React.ReactNode => {
        const agent = line.facts;
        const blockId = agent?.kind === "panel" && (!line.task || live) ? agent.blockId : "";
        // The merge queue's agent works for the queue: its line keeps Go there only, the banner's Stop ends the whole
        // queue (#1128).
        if (!blockId || (line.task && state === "done") || agent.batch) {
            return null;
        }
        if (confirmStop === blockId) {
            return (
                <>
                    <span className="truncate text-secondary" data-testid="reviews-agent-stop-confirm">
                        {t("reviewsAgents.stop.confirm", { name: agent.name || prTask?.name || "" })}
                    </span>
                    <button
                        type="button"
                        onClick={click(() => run("stop", () => onStop(blockId)))}
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
                        onClick={click(() => setConfirmStop(null))}
                        onKeyDown={stop}
                        className={BarButton}
                        data-testid="reviews-agent-stop-no"
                    >
                        {t("reviewsAgents.stop.cancel")}
                    </button>
                </>
            );
        }
        return (
            <>
                <button
                    type="button"
                    onClick={click(() => run("work", () => onOpenWork(blockId)))}
                    onKeyDown={stop}
                    aria-busy={busy === "work" || undefined}
                    className={BarButton}
                    title={t("reviewsAgents.work.title", { number: pr.number, name: agent.name })}
                    data-testid="reviews-agent-work"
                >
                    {busy === "work" ? (
                        <DominoLoader />
                    ) : (
                        <i className="fa fa-solid fa-table-columns text-10" aria-hidden />
                    )}
                    {t("reviewsAgents.work.button")}
                </button>
                <button
                    type="button"
                    onClick={click(() => setConfirmStop(blockId))}
                    onKeyDown={stop}
                    className={BarButton}
                    title={t("reviewsAgents.stop.title", { name: agent.name })}
                    data-testid="reviews-agent-stop"
                >
                    <i className="fa fa-solid fa-stop text-10" aria-hidden />
                    {t("reviewsAgents.stop.button")}
                </button>
            </>
        );
    };
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
                        actions={actionsOf(line)}
                        stacked
                    />
                ))}
            </div>
        </>
    );
}

// Whose turn a draft is (FR-REV-022 AC3, #954), for the card's state (#1060): never the developer's while an agent
// works on its branch, is in an agent's column of the board, or pushed a commit lately. Null before wavesrv read the
// draft (its answer can predate GitHub's): nobody knows whose it is yet. status: the board column, worded.
export function useDraftTurn(dir: string, pr: ReviewPr, agents: AgentBarFacts[]): { turn: DraftTurn; status: string } {
    const t = useT();
    const upcoming = useUpcomingAnswer(dir);
    const now = useMinuteNow();
    if (!pr.draft || upcoming == null) {
        return { turn: null, status: "" };
    }
    const draft = upcoming.drafts?.find((d) => d.branch === pr.branch);
    if (draft == null && agents.length === 0 && upcoming.humantesting !== "no") {
        return { turn: null, status: "" };
    }
    const turn = draftTurn(agents[0] ?? null, draft, now, upcoming.humantesting);
    return { turn, status: turn.status ? boardStatusText(t, turn.status) : "" };
}
