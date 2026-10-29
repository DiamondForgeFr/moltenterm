// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view's entry points (FR-REV-001-AC3, DS-REV-012): the widget opens the view, Mission Control's Pull
// requests waiting block opens it on one PR, and a row opens that PR's Review tab (FR-REV-002).

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { makeORef, reloadWaveObject } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom } from "jotai";
import { AgentStates } from "../agent-state-store";
import { CodingAgentChoice, codingAgentName, fetchCodingAgent } from "../coding-agent/coding-agent";
import { errorPhrase, phrase, type Phrase } from "../i18n/phrase";
import { openMoltentermView } from "../open-view";
import { showTabFromHere } from "../opener-tab";
import { requestAssist } from "../review/review-assist";
import type { ReviewCleanupPr, ReviewCleanupResult } from "../review/review-cleanup";
import {
    askReviewFinish,
    askReviewInvestigate,
    askReviewRebase,
    markReviewReady,
    openReviewTab,
    ReviewPrInfo,
    ReviewPrMetaKey,
} from "../review/review-client";
import { MoltentermReviewView } from "../review/review-model";
import { showPanel } from "../review/review-panels";
import { openSheetValidate, ReviewValidateModel } from "../review/review-validate-model";
import { DurableSessions } from "../sessions/sessions-store";
import { AgentChoiceAnswer, agentChoiceOf, agentStartOf, askAgentChoice, showStartedAgent } from "./agent-choice";
import { AssistedReviewModel } from "./assisted-review-dialog";
import { BusyAgent, QueuedAsk, ReviewsAskQueue } from "./reviews-ask-queue";
import { reviewsGet, reviewsRerunFailed } from "./reviews-client";
import type { Forecast } from "./reviews-forecast-model";
import { ReviewsMerges } from "./reviews-merges";
import {
    blockersText,
    cleanupRebaseAsks,
    investigateBlockers,
    markReadyError,
    MoltentermReviewsView,
    ReadiedPrs,
    RebaseAsk,
    rebaseAskKey,
    rebaseOutcome,
    RebaseOutcome,
    repoOfPrUrl,
    ReviewPr,
    reviewPrOfCleanup,
    ReviewsAnswer,
} from "./reviews-model";
import {
    AfterMerge,
    afterMergeOf,
    forgetMerged,
    joinAfterMerge,
    keptOut,
    MergeQueue,
    QueueMemory,
    queueMemory,
} from "./reviews-queue-model";
import { checkAgentsPlan, CheckReport, prLeft, PrTaskKind } from "./reviews-task-model";

// The PR a Reviews view brings into sight and marks, asked by another surface; or, by its branch, a future PR's
// Upcoming entry (number 0, #962).
export type ReviewsFocus = { dir: string; number: number; branch?: string; at: number };

export type ReviewsValidateSheet = { model: ReviewValidateModel; blockId?: string };

export class ReviewsModel {
    private static instance: ReviewsModel = null;

    focusAtom = atom(null) as PrimitiveAtom<ReviewsFocus>;
    // The rebases asked from the rows (#683), by rebaseAskKey.
    rebaseAsksAtom = atom({}) as PrimitiveAtom<Record<string, RebaseAsk>>;
    // The drafts marked ready from MoltenTerm (#687), by rebaseAskKey: splitReviews moves them at once.
    readiedAtom = atom({}) as PrimitiveAtom<ReadiedPrs>;
    // A row's Validate sheet, open with no Review tab (#707), in the Reviews panel blockId.
    validateSheetAtom = atom(null) as PrimitiveAtom<ReviewsValidateSheet>;
    stopSheet: () => void = null;
    // The status line after a merge of a queued PR (#1062, FR-REV-024), by project folder; and the queue each project's
    // last read showed, which the next read is compared with.
    afterMergeAtom = atom({}) as PrimitiveAtom<Record<string, AfterMerge>>;
    queueMemories: Record<string, QueueMemory> = {};
    // The PRs the developer took out of the group merge (#1108, FR-REV-024), by project folder: kept while the app
    // runs, forgotten once a PR leaves the list. Every queueable PR is in by default.
    groupOutAtom = atom({}) as PrimitiveAtom<Record<string, number[]>>;

    private constructor() {}

    static getInstance(): ReviewsModel {
        if (ReviewsModel.instance == null) {
            ReviewsModel.instance = new ReviewsModel();
        }
        return ReviewsModel.instance;
    }

    // Opens the Reviews view of the active tab (or focuses it), on a PR when one is named, else on the Upcoming entry
    // of a branch when one is named.
    async openReviews(dir?: string, number?: number, branch?: string): Promise<void> {
        if (dir && number) {
            globalStore.set(this.focusAtom, { dir, number, at: Date.now() });
        } else if (dir && branch) {
            globalStore.set(this.focusAtom, { dir, number: 0, branch, at: Date.now() });
        }
        await openMoltentermView(MoltentermReviewsView);
    }

    // A row's action: the PR's Review tab in this workspace, created the first time, shown after.
    async openPullRequestReview(dir: string, pr: ReviewPr, repo?: string): Promise<void> {
        const workspaceId = globalStore.get(atoms.workspace)?.oid;
        const repoName = repo || repoOfPrUrl(pr?.url);
        if (!dir || pr == null || !workspaceId || !repoName) {
            return;
        }
        showTabFromHere(await openPullRequestTab(workspaceId, dir, pr, repoName));
    }

    // A card's Assisted review (FR-REV-033): the confirmation first; on Start the agent the Review tab opens with the
    // agent on the left of the diff, on Diff only it opens as a row's click does, on Cancel nothing opens.
    async openAssistedReview(dir: string, pr: ReviewPr, repo?: string): Promise<void> {
        const repoName = repo || repoOfPrUrl(pr?.url);
        if (!dir || pr == null || !repoName) {
            return;
        }
        const dialog = AssistedReviewModel.getInstance();
        const answer = dialog.ask({ number: pr.number, branch: pr.branch, base: pr.base });
        fireAndForget(async () => {
            const choice = await fetchCodingAgent(dir).catch((): CodingAgentChoice => null);
            dialog.nameAgent(pr.number, choice?.agentname || codingAgentName(choice?.agent ?? ""));
        });
        const choice = await answer;
        const workspaceId = globalStore.get(atoms.workspace)?.oid;
        if (choice == null || !workspaceId) {
            return;
        }
        const tabId = await openPullRequestTab(workspaceId, dir, pr, repoName);
        if (choice === "agent") {
            await requestAssist(tabId);
        }
        showTabFromHere(tabId);
    }

    // A row's Validate (#683, #707): the Validate sheet opens in place, over this tab, with no Review tab; it shows the
    // plan, and merging stays the developer's click there. blockId is the Reviews panel that shows it.
    openValidate(dir: string, pr: ReviewPr, repo?: string, blockId?: string) {
        const repoName = repo || repoOfPrUrl(pr?.url);
        // A PR MoltenTerm merged (#898) offers no validation, even from a row drawn before the merge.
        if (!dir || pr == null || !repoName || ReviewsMerges.getInstance().isMerged(dir, pr.number)) {
            return;
        }
        this.closeValidateSheet();
        const opened = openSheetValidate(reviewPrInfo(dir, pr, repoName), () =>
            this.openPullRequestReview(dir, pr, repoName)
        );
        const unsub = globalStore.sub(opened.model.validateAtom, () => {
            if (!globalStore.get(opened.model.validateAtom).open) {
                this.closeValidateSheet();
            }
        });
        this.stopSheet = () => {
            unsub();
            opened.stop();
        };
        globalStore.set(this.validateSheetAtom, { model: opened.model, blockId });
    }

    closeValidateSheet() {
        const stop = this.stopSheet;
        this.stopSheet = null;
        stop?.();
        globalStore.set(this.validateSheetAtom, null);
    }

    // A row's Ask for a rebase (#683): the agent on the PR's branch gets it. With none there, the developer chooses how
    // one starts (#758): out of sight, or in its own tab shown by this window; never the PR's Review tab. An agent
    // reached marks the row until the PR's head changes. mergedPr: the merge that put the PR in conflict (#691).
    async askRebase(dir: string, pr: ReviewPr, repo: string, mergedPr?: number): Promise<RebaseOutcome> {
        const outcome = await this.askRebaseOnce(dir, pr, repo, null, mergedPr);
        if (outcome?.kind !== "offer") {
            return outcome;
        }
        const choice = await askAgentChoice({
            kind: "rebase",
            number: pr.number,
            branch: pr.branch,
            base: pr.base,
            agent: outcome.agent,
            ...agentChoiceOf(outcome.result),
        });
        if (choice == null) {
            return null;
        }
        return this.askRebaseOnce(dir, pr, repo, choice, mergedPr);
    }

    private async askRebaseOnce(
        dir: string,
        pr: ReviewPr,
        repo: string,
        choice: AgentChoiceAnswer,
        mergedPr?: number
    ): Promise<RebaseOutcome> {
        const mode = choice?.mode;
        const repoName = repo || repoOfPrUrl(pr?.url);
        if (!dir || pr == null || !repoName) {
            return null;
        }
        let outcome: RebaseOutcome;
        try {
            const result = await askReviewRebase({
                repo: repoName,
                number: pr.number,
                dir,
                headref: pr.branch,
                baseref: pr.base,
                headoid: pr.headoid,
                title: pr.tickettitle || pr.title,
                url: pr.url,
                ticket: pr.ticket,
                mergedpr: mergedPr || undefined,
                ...(mode != null ? agentStartOf("rebase", pr.number, mode, choice.agent) : {}),
            });
            showStartedAgent(mode, result);
            outcome = rebaseOutcome(result);
        } catch (e) {
            outcome = rebaseOutcome(null, errorPhrase(e));
        }
        this.noteTask(dir, pr, "rebase", outcome);
        return outcome;
    }

    // noteTask records the work an agent took on a PR (#954): its row's agent line then follows it to done or stuck.
    noteTask(dir: string, pr: ReviewPr, kind: PrTaskKind, outcome: RebaseOutcome) {
        if (outcome?.kind !== "asked" || !dir || pr == null) {
            return;
        }
        const key = rebaseAskKey(dir, pr.number);
        const asks = globalStore.get(this.rebaseAsksAtom);
        globalStore.set(this.rebaseAsksAtom, {
            ...asks,
            [key]: { kind, name: outcome.name, blockId: outcome.blockId, head: pr.headoid ?? "", at: Date.now() },
        });
    }

    // noteQueueRead (#1062): a new read of a project's list against the queue the last one showed: the queued PRs merged
    // since then make the status line say what changed. takenByQueue: the PRs the running merge queue rebases itself.
    noteQueueRead(
        dir: string,
        answer: ReviewsAnswer,
        listed: readonly ReviewPr[],
        queue: MergeQueue,
        forecast: Forecast,
        takenByQueue: (number: number) => boolean
    ) {
        let memory = this.queueMemories[dir];
        const after = afterMergeOf(memory, answer, listed, takenByQueue);
        if (after != null) {
            const shown = globalStore.get(this.afterMergeAtom);
            globalStore.set(this.afterMergeAtom, { ...shown, [dir]: joinAfterMerge(shown[dir], after) });
            memory = forgetMerged(memory, after.merged);
        }
        this.queueMemories[dir] = queueMemory(queue, forecast, listed) ?? memory;
    }

    // setInGroupMerge (#1108): a queue step's checkbox, or its card's menu, puts a PR into the group merge or takes it
    // out.
    setInGroupMerge(dir: string, number: number, inGroup: boolean) {
        const shown = globalStore.get(this.groupOutAtom);
        const out = (shown[dir] ?? []).filter((n) => n !== number);
        if (!inGroup) {
            out.push(number);
        }
        globalStore.set(this.groupOutAtom, { ...shown, [dir]: out });
    }

    // forgetLeftGroupOut: the PRs taken out that left the list are forgotten; one that comes back is in again.
    forgetLeftGroupOut(dir: string, listed: readonly ReviewPr[]) {
        const shown = globalStore.get(this.groupOutAtom);
        const out = shown[dir];
        if (out == null) {
            return;
        }
        const kept = keptOut(out, listed);
        if (kept.length === out.length) {
            return;
        }
        globalStore.set(this.groupOutAtom, { ...shown, [dir]: kept });
    }

    closeAfterMerge(dir: string) {
        const shown = globalStore.get(this.afterMergeAtom);
        if (shown[dir] == null) {
            return;
        }
        const next = { ...shown };
        delete next[dir];
        globalStore.set(this.afterMergeAtom, next);
    }

    // handOverAfterMerge: "Hand the rebase over" on the status line: each PR named goes to its agent, as Ask for a
    // rebase does (a busy agent gets it after its task, the card says so); what could not be asked stays on the line.
    async handOverAfterMerge(dir: string, repo: string, listed: readonly ReviewPr[]): Promise<void> {
        const after = globalStore.get(this.afterMergeAtom)[dir];
        if (after == null) {
            return;
        }
        const failures: Phrase[] = [];
        for (const need of after.needs) {
            const pr = listed.find((p) => p.number === need.number);
            if (pr == null) {
                continue;
            }
            const outcome = await this.askRebase(dir, pr, repo, need.after);
            if (outcome?.busy != null) {
                this.queueAsk(dir, pr, repo, "rebase", outcome.busy, need.after);
            } else if (outcome?.kind === "failed") {
                failures.push(outcome.text);
            }
        }
        if (failures.length === 0) {
            this.closeAfterMerge(dir);
            return;
        }
        const shown = globalStore.get(this.afterMergeAtom);
        globalStore.set(this.afterMergeAtom, { ...shown, [dir]: { ...after, needs: [], failures } });
    }

    // queueAsk (#1062, FR-REV-022 AC12): "Hand the rebase to {name} after its task": the task waits for the busy agent
    // and goes to it, with no dialog, once it is neither working nor waiting.
    queueAsk(
        dir: string,
        pr: ReviewPr,
        repo: string,
        kind: PrTaskKind,
        agent: BusyAgent,
        mergedPr?: number,
        markReady?: boolean
    ) {
        const queue = this.askQueue();
        queue.queue({ dir, repo, pr, kind, agent, mergedPr, markReady });
    }

    // askQueue: the queue of asks, sending through this model and watching the agents' states once it is first used.
    askQueue(): ReviewsAskQueue {
        const queue = ReviewsAskQueue.getInstance();
        if (queue.sender != null) {
            return queue;
        }
        const states = AgentStates.getInstance();
        queue.sender = (ask) => this.sendQueued(ask);
        queue.statesOf = () => globalStore.get(states.dataAtom);
        queue.unsubscribe = globalStore.sub(states.dataAtom, () => queue.check(globalStore.get(states.dataAtom)));
        return queue;
    }

    sendQueued(ask: QueuedAsk): Promise<RebaseOutcome> {
        switch (ask.kind) {
            case "investigate":
                return this.investigateOnce(ask.dir, ask.pr, ask.repo, null);
            case "finish":
                return this.finishOnce(ask.dir, ask.pr, ask.repo, null, ask.markReady);
        }
        return this.askRebaseOnce(ask.dir, ask.pr, ask.repo, null, ask.mergedPr);
    }

    // Retry (#954): the same task again, with the PR as the list reads it now. The agent that took it gets it in its
    // session; when that session is gone, the developer chooses how a new one starts, as for the first ask.
    retryTask(dir: string, pr: ReviewPr, repo: string, kind: PrTaskKind): Promise<RebaseOutcome> {
        if (kind === "investigate") {
            return this.investigate(dir, pr, repo);
        }
        if (kind === "finish") {
            return this.askFinish(dir, pr, repo);
        }
        return this.askRebase(dir, pr, repo);
    }

    // Check and finish one PR (#954), from its row's Retry: the agent on the branch, else the developer's choice.
    // markReady (#1212): Resume on a draft its agent stopped before marking ready, in a workflow without Human Testing.
    async askFinish(dir: string, pr: ReviewPr, repo: string, markReady?: boolean): Promise<RebaseOutcome> {
        const outcome = await this.finishOnce(dir, pr, repo, null, markReady);
        if (outcome?.kind !== "offer") {
            return outcome;
        }
        const choice = await askAgentChoice({
            kind: "finish",
            number: pr.number,
            branch: pr.branch,
            base: pr.base,
            agent: outcome.agent,
            ...agentChoiceOf(outcome.result),
        });
        if (choice == null) {
            return null;
        }
        return this.finishOnce(dir, pr, repo, choice, markReady);
    }

    private async finishOnce(
        dir: string,
        pr: ReviewPr,
        repo: string,
        choice: AgentChoiceAnswer,
        markReady?: boolean
    ): Promise<RebaseOutcome> {
        const mode = choice?.mode;
        const repoName = repo || repoOfPrUrl(pr?.url);
        if (!dir || pr == null || !repoName) {
            return null;
        }
        const left = prLeft(pr);
        let outcome: RebaseOutcome;
        try {
            const result = await askReviewFinish({
                repo: repoName,
                number: pr.number,
                dir,
                headref: pr.branch,
                baseref: pr.base,
                headoid: pr.headoid,
                title: pr.tickettitle || pr.title,
                url: pr.url,
                ticket: pr.ticket,
                conflicts: left.conflicts || undefined,
                failedchecks: left.failedChecks.length > 0 ? left.failedChecks : undefined,
                changesrequested: left.changesRequested || undefined,
                noreport: left.noReport || undefined,
                markready: (markReady && pr.draft) || undefined,
                ...(mode != null ? agentStartOf("finish", pr.number, mode, choice.agent) : {}),
            });
            showStartedAgent(mode, result);
            outcome = rebaseOutcome(result, null, "finish");
        } catch (e) {
            outcome = rebaseOutcome(null, errorPhrase(e), "finish");
        }
        this.noteTask(dir, pr, "finish", outcome);
        return outcome;
    }

    // Check the agents (#954, FR-REV-022 AC8), on the developer's click: each listed PR with something left goes to the
    // agent on its branch; a busy agent is left alone; the PRs whose agent is gone wait for startOffers.
    async checkAgents(dir: string, repo: string, prs: ReviewPr[]): Promise<CheckReport> {
        const plan = checkAgentsPlan(prs);
        const report: CheckReport = {
            checked: plan.checked,
            needs: plan.needs.length,
            sent: 0,
            busy: 0,
            offers: [],
            started: 0,
            failed: 0,
        };
        for (const pr of plan.needs) {
            const outcome = await this.finishOnce(dir, pr, repo, null);
            switch (outcome?.kind) {
                case "asked":
                    report.sent++;
                    break;
                case "offer":
                    report.offers.push(pr);
                    break;
                case "info":
                    report.busy++;
                    break;
                default:
                    report.failed++;
            }
        }
        return report;
    }

    // The developer's confirmation after Check the agents: a new agent, out of sight, on each PR whose agent is gone.
    async startOffers(dir: string, repo: string, report: CheckReport): Promise<CheckReport> {
        const next: CheckReport = { ...report, offers: [] };
        for (const pr of report.offers) {
            const outcome = await this.finishOnce(dir, pr, repo, { mode: "background" });
            if (outcome?.kind === "asked") {
                next.started++;
            } else {
                next.failed++;
            }
        }
        return next;
    }

    // Open its work (#954): the PR's diff (the Review tab's review block) beside the agent's terminal, in the agent's
    // tab, then that tab shown with the terminal focused. A diff of the PR already there is shown again, not doubled.
    async openAgentWork(dir: string, pr: ReviewPr, repo: string, blockId: string): Promise<Phrase> {
        const repoName = repo || repoOfPrUrl(pr?.url);
        if (!dir || pr == null || !repoName || !blockId) {
            return phrase("reviewsAgents.work.failed", { message: "" });
        }
        try {
            const info = await RpcApi.BlockInfoCommand(TabRpcClient, blockId);
            const tabId = info?.tabid;
            if (!tabId) {
                return phrase("reviewsAgents.work.gone");
            }
            const prInfo = reviewPrInfo(dir, pr, repoName);
            if (!(await tabHasReviewOf(tabId, prInfo))) {
                await RpcApi.CreateBlockCommand(TabRpcClient, {
                    tabid: tabId,
                    blockdef: { meta: { view: MoltentermReviewView, [ReviewPrMetaKey]: prInfo } as MetaType },
                    targetblockid: blockId,
                    targetaction: "splitright",
                });
            }
            await showPanel(blockId);
        } catch (e) {
            return phrase("reviewsAgents.work.failed", { message: errorPhrase(e) });
        }
        return null;
    }

    // Stop (#954, #933's Stop): the agent's session ends; what it pushed stays. Answers the error in plain words.
    async stopAgent(blockId: string): Promise<Phrase> {
        const sessions = DurableSessions.getInstance();
        const session = globalStore.get(sessions.dataAtom)?.sessions?.find((s) => s.blockid === blockId);
        if (session == null || !session.canend) {
            return phrase("reviewsAgents.stop.noSession");
        }
        try {
            await sessions.end(session.id);
        } catch (e) {
            return phrase("reviewsAgents.stop.failed", { message: errorPhrase(e) });
        }
        return null;
    }

    // The rebases the cleanup after a merge asked (#691) mark their Reviews rows like a row's click.
    noteCleanupRebases(dir: string, cleanup: ReviewCleanupResult) {
        if (!dir || cleanup == null) {
            return;
        }
        const asks = globalStore.get(this.rebaseAsksAtom);
        const next = cleanupRebaseAsks(asks, dir, cleanup);
        if (next !== asks) {
            globalStore.set(this.rebaseAsksAtom, next);
        }
    }

    // Start an agent on a PR the merge of mergedPr put in conflict (#691), from the Validate sheet: Ask for a rebase,
    // with the same choice (#758).
    startCleanupAgent(
        dir: string,
        repo: string,
        base: string,
        pr: ReviewCleanupPr,
        mergedPr?: number
    ): Promise<RebaseOutcome> {
        return this.askRebase(dir, reviewPrOfCleanup(pr, base), repo, mergedPr);
    }

    // Investigate (#797), on a row whose check failed: the agent on the PR's branch reads the failed checks; with none
    // there, the developer chooses how one starts, as for a rebase. Nothing starts before that click.
    async investigate(dir: string, pr: ReviewPr, repo: string): Promise<RebaseOutcome> {
        const outcome = await this.investigateOnce(dir, pr, repo, null);
        if (outcome?.kind !== "offer") {
            return outcome;
        }
        const choice = await askAgentChoice({
            kind: "investigate",
            number: pr.number,
            branch: pr.branch,
            base: pr.base,
            agent: outcome.agent,
            checks: blockersText(pr),
            ...agentChoiceOf(outcome.result),
        });
        if (choice == null) {
            return null;
        }
        return this.investigateOnce(dir, pr, repo, choice);
    }

    private async investigateOnce(
        dir: string,
        pr: ReviewPr,
        repo: string,
        choice: AgentChoiceAnswer
    ): Promise<RebaseOutcome> {
        const mode = choice?.mode;
        const repoName = repo || repoOfPrUrl(pr?.url);
        if (!dir || pr == null || !repoName) {
            return null;
        }
        try {
            const result = await askReviewInvestigate({
                repo: repoName,
                number: pr.number,
                dir,
                headref: pr.branch,
                baseref: pr.base,
                headoid: pr.headoid,
                title: pr.tickettitle || pr.title,
                url: pr.url,
                ticket: pr.ticket,
                ...investigateBlockers(pr),
                ...(mode != null ? agentStartOf("investigate", pr.number, mode, choice.agent) : {}),
            });
            showStartedAgent(mode, result);
            const outcome = rebaseOutcome(result, null, "investigate");
            this.noteTask(dir, pr, "investigate", outcome);
            return outcome;
        } catch (e) {
            return rebaseOutcome(null, errorPhrase(e), "investigate");
        }
    }

    // Rerun failed jobs (#797), after the row's confirmation: wavesrv reruns the runs of the failed checks and tells
    // their outcome by a notification; the list reads GitHub again. Answers the error in plain words, null on success.
    async rerunFailed(dir: string, number: number): Promise<{ error: Phrase; checks: string[] }> {
        if (!dir || !number) {
            return { error: phrase("reviews.ci.rerun.failed", { message: "" }), checks: [] };
        }
        try {
            const result = await reviewsRerunFailed(dir, number);
            fireAndForget(async () => {
                await reviewsGet(dir, true);
            });
            return { error: null, checks: result?.checks ?? [] };
        } catch (e) {
            return { error: phrase("reviews.ci.rerun.failed", { message: errorPhrase(e) }), checks: [] };
        }
    }

    // Mark ready for review (#687), from a draft's row or its Review tab: gh pr ready, then the list moves the PR to
    // Waiting for review and asks GitHub again. Answers the error in plain words, null on success.
    async markReady(dir: string, number: number, repo: string): Promise<Phrase> {
        if (!dir || !number || !repo) {
            return markReadyError(null);
        }
        let error: Phrase;
        try {
            error = markReadyError(await markReviewReady({ repo, number, dir }));
        } catch (e) {
            error = markReadyError(null, errorPhrase(e));
        }
        if (error) {
            return error;
        }
        const key = rebaseAskKey(dir, number);
        globalStore.set(this.readiedAtom, { ...globalStore.get(this.readiedAtom), [key]: Date.now() });
        fireAndForget(async () => {
            await reviewsGet(dir, true);
        });
        return null;
    }
}

// openPullRequestTab returns the PR's Review tab in the workspace, created the first time (a row's click, `molten review`).
export async function openPullRequestTab(
    workspaceId: string,
    dir: string,
    pr: ReviewPr,
    repo: string
): Promise<string> {
    const { tabid } = await openReviewTab(workspaceId, reviewPrInfo(dir, pr, repo));
    return tabid;
}

// tabHasReviewOf: the tab already holds a review block of the PR (Open its work twice does not double the diff).
async function tabHasReviewOf(tabId: string, pr: ReviewPrInfo): Promise<boolean> {
    const tab = await reloadWaveObject<Tab>(makeORef("tab", tabId));
    for (const blockId of tab?.blockids ?? []) {
        const block = await reloadWaveObject<Block>(makeORef("block", blockId));
        const shown = block?.meta?.[ReviewPrMetaKey] as ReviewPrInfo;
        if (block?.meta?.view === MoltentermReviewView && shown?.number === pr.number && shown?.repo === pr.repo) {
            return true;
        }
    }
    return false;
}

// reviewPrInfo is the PR as a Review tab and the Validate sheet know it, from a Reviews row.
export function reviewPrInfo(dir: string, pr: ReviewPr, repo: string): ReviewPrInfo {
    return {
        dir,
        repo,
        number: pr.number,
        title: pr.tickettitle || pr.title,
        url: pr.url,
        headref: pr.branch,
        baseref: pr.base,
        headoid: pr.headoid,
        baseoid: pr.baseoid,
        ticket: pr.ticket,
    };
}
