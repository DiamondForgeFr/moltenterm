// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Review tab's side of wavesrv (FR-REV-002, DS-REV-002, DS-REV-007): the PR's file list and one file's two sides,
// computed by local git on commit ids (pkg/molten/review), the review store, and the tab itself. The frontend never
// runs git.

import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import type { ServerText } from "../i18n/server-text";
import type { MarkReadyResult } from "../reviews/reviews-model";
import type { ReviewCleanupResult, ReviewCleanupStepResult } from "./review-cleanup";
import { ReviewAnchor, ReviewDepth, reviewScope } from "./review-session";

// must match pkg/molten/review/route.go
export const ReviewRoute = "molten:review";
export const ReviewUpdateEvent = "molten:review:update";
const OpenCommand = "moltenreviewopen";
const FilesCommand = "moltenreviewfiles";
const FileCommand = "moltenreviewfile";
const CompareCommand = "moltenreviewcompare";
const WorktreeCommand = "moltenreviewworktree";
const StateCommand = "moltenreviewstate";
const PrStateCommand = "moltenreviewprstate";
const ViewedCommand = "moltenreviewviewed";
const ShownCommand = "moltenreviewshown";
const MergePlanCommand = "moltenreviewmergeplan";
const MergeCommand = "moltenreviewmerge";
const MergeMethodsCommand = "moltenreviewmergemethods";
const MergeCancelCommand = "moltenreviewmergecancel";
const AiPaneCommand = "moltenreviewaipane";
const CommentCommand = "moltenreviewcomment";
const CommentStateCommand = "moltenreviewcommentstate";
const RewriteCommand = "moltenreviewcommentrewrite";
const DiscussCommand = "moltenreviewcommentdiscuss";
const RelocateCommand = "moltenreviewrelocate";
const PublishInfoCommand = "moltenreviewpublishinfo";
const TranslateCommand = "moltenreviewtranslate";
const TranslationCommand = "moltenreviewtranslation";
const SummaryCommand = "moltenreviewsummary";
const PublishCommand = "moltenreviewpublish";
const RestartCommand = "moltenreviewrestart";
const RebaseCommand = "moltenreviewrebase";

// A file list or a compare may fetch the PR's branches; a worktree may be created.
const GitTimeoutMs = 95_000;
const CallTimeoutMs = 15_000;
// Typing waits for the agent's terminal.
const DiscussTimeoutMs = 25_000;
// Post review lists, posts and checks on GitHub (pkg/molten/review/route.go's publishTimeout, plus a margin).
const PublishTimeoutMs = 245_000;
// Restart work may fetch and create a worktree, then waits for a new terminal's prompt (restart.go's restartTimeout).
const RestartTimeoutMs = 125_000;

// must match pkg/molten/review/diff.go
export type ReviewFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "typechanged" | "submodule";
export type ReviewCollapsed = "" | "binary" | "generated" | "large" | "submodule";

export type ReviewFile = {
    path: string;
    oldpath?: string;
    status: ReviewFileStatus;
    additions: number;
    deletions: number;
    binary?: boolean;
    generated?: boolean;
    oldblob?: string;
    newblob?: string;
    oldsize?: number;
    newsize?: number;
    collapsed?: ReviewCollapsed;
};

export type ReviewFilesRequest = {
    dir: string;
    headref: string;
    baseref: string;
    headoid?: string;
    baseoid?: string;
    from?: string;
};

export type ReviewFilesResult = {
    headoid: string;
    baseoid: string;
    from?: string;
    files: ReviewFile[];
    ms: number;
    cached?: boolean;
};

export type ReviewFileResult = {
    path: string;
    original: string;
    modified: string;
    collapsed?: ReviewCollapsed;
    oldlines?: number;
    newlines?: number;
    binary?: boolean;
    // The hunks of the diff GitHub shows: a line comment goes inside one (FR-REV-003).
    hunks?: ReviewHunk[];
    ms: number;
};

export type ReviewHunk = { oldstart: number; oldlines: number; newstart: number; newlines: number };

export type ReviewCompareResult = { commits: number; rewritten?: boolean };

export type ReviewWorktree = { worktree: string; kind: "agent" | "review"; ms: number };

export type ReviewRound = {
    id: string;
    startedat: number;
    headoid: string;
    publishedat?: number;
    githubreviewid?: number;
    githuburl?: string;
    restartedat?: number;
    // The agent Restart work handed the round to, its terminal and its worktree (FR-REV-011).
    restartagent?: string;
    restartblockid?: string;
    restartworktree?: string;
    // The language the round was published in (FR-REV-010).
    lang?: string;
};

// must match RestartResult in pkg/molten/review/restart.go
// offer: Ask for a rebase found no agent on the branch (pkg/molten/review/rebase.go).
export type ReviewRestartStatus = "started" | "sent" | "typed" | "busy" | "noagent" | "failed" | "offer";

export type ReviewRestartResult = {
    status: ReviewRestartStatus;
    // Why the round was not handed over (busy or failed): restart.go's RestartReason… codes.
    reason?: string;
    agentstate?: string;
    branch?: string;
    // wavesrv's English detail, and its code when it is one of MoltenTerm's sentences.
    message?: string;
    messagetext?: ServerText;
    round?: string;
    worktree?: string;
    worktreecreated?: boolean;
    blockid?: string;
    // The new agent's own tab, hidden when it works out of sight (#758).
    tabid?: string;
    hidden?: boolean;
    agent?: string;
    agentname?: string;
    firstname?: string;
    briefpath?: string;
    state?: ReviewState;
    // The developer's coding agent (#845): the chosen one when they chose, missing when it is not installed, the
    // agents an offer can switch to.
    chosenagent?: string;
    chosenname?: string;
    agentmissing?: boolean;
    agentsource?: string;
    agents?: { id: string; name: string; installed: boolean }[];
};

// How a new agent works (#758): out of sight, or in a tab the window shows; must match agentstart.go.
export type AgentMode = "background" | "together";

// The start of a new agent the developer chose: its tab goes in the workspace, named in the interface language;
// agent: the coding agent picked for this run in the dialog (#845), none for the project's choice.
export type AgentStart = { start?: boolean; mode?: AgentMode; workspaceid?: string; tabname?: string; agent?: string };

export type ReviewSince = { from: string; to: string; published?: boolean };

// must match pkg/molten/review/merge.go and postmerge.go
export type ReviewCheckState = "ok" | "info" | "warn" | "pending" | "fail";
// The sheet writes a check from its id, its code and the data (review-stepper.ts).
export type ReviewMergeCheck = {
    id: string;
    state: ReviewCheckState;
    code?: string;
    count?: number;
    local?: number;
    names?: string[];
    base?: string;
    prstate?: string;
};
export type ReviewMergeStep = { id: "update" | "waitci" | "merge" };
// must match MergeMethod… in pkg/molten/review/mergemethod.go, in GitHub's order
export type ReviewMergeMethod = "merge" | "squash" | "rebase";

export type ReviewMergePlan = {
    id: string;
    repo: string;
    number: number;
    dir: string;
    title?: string;
    url?: string;
    ticket?: number;
    headref: string;
    baseref: string;
    headoid: string;
    prstate: string;
    mergestate?: string;
    mergeable?: string;
    behind?: boolean;
    // The merge methods the repository and the base's rules allow, the default, and what narrowed them (#673).
    methods?: ReviewMergeMethod[];
    method?: ReviewMergeMethod;
    methodrule?: "queue" | "ruleset" | "linear";
    // A merge queue merges the PR, with its own method.
    queue?: boolean;
    // The repository's remembered method GitHub no longer allows: the sheet says what replaces it (#957).
    methodrefused?: ReviewMergeMethod;
    checks: ReviewMergeCheck[];
    steps: ReviewMergeStep[];
    // The cleanup after the merge, every step planned.
    cleanup: ReviewCleanupStepResult[];
    canmerge: boolean;
    // The id of the first check that fails or waits.
    blocking?: string;
    // Only the CI runs: validated now, the merge queue merges it once green (FR-REV-026); greenonly: the
    // review:validategreenonly setting keeps it blocked instead.
    canqueue?: boolean;
    greenonly?: boolean;
    warnings: string[];
    createdat: number;
};

export type ReviewMergeState =
    | "checking"
    | "updating"
    | "waitingci"
    | "merging"
    | "queued"
    | "merged"
    | "refused"
    | "failed"
    | "cancelled";

export type ReviewMergeRecord = {
    planid: string;
    method: string;
    planhead: string;
    head?: string;
    mergedoid?: string;
    state: ReviewMergeState;
    refused?: "headmoved" | "basemoved" | "check" | "mergedaway";
    // What the sheet writes about the outcome, and its data; error: gh's raw error.
    code?: string;
    error?: string;
    blocking?: ReviewMergeCheck;
    names?: string[];
    movedfrom?: string;
    movedto?: string;
    minutes?: number;
    // The English text of records made before #672.
    message?: string;
    updated?: boolean;
    overridden?: string[];
    startedat: number;
    endedat?: number;
    // The cleanup after the merge runs; its outcome is ReviewState.cleanup.
    cleanuprunning?: boolean;
};
// The review session's latest briefing (FR-REV-005); headoid: the head the agent briefed.
export type ReviewBriefing = { markdown: string; headoid?: string; agent?: string; at: number };

// The agent's answer to a question of the developer's (FR-REV-006), on its lines (no anchor: on the whole PR).
// must match Explanation in pkg/molten/review/explanations.go
export type ReviewExplanation = {
    id: string;
    question?: string;
    // FR-REV-007 AC1: the technique the answer teaches, the card's title.
    technique?: string;
    markdown: string;
    anchor?: ReviewAnchor;
    depth?: ReviewDepth;
    sources?: string[];
    related?: string[];
    principles?: string[];
    headoid?: string;
    agent?: string;
    at: number;
    updatedat?: number;
};

// must match State in pkg/molten/review/store.go
export type ReviewState = {
    repo: string;
    number: number;
    briefing?: ReviewBriefing;
    explanations?: ReviewExplanation[];
    viewed: Record<string, string>;
    lasthead?: string;
    since?: ReviewSince;
    rounds: ReviewRound[];
    // What the last cleanup after the merge did (FR-REV-013, review-cleanup.ts).
    cleanup?: ReviewCleanupResult;
    comments?: ReviewComment[];
    updatedat?: number;
    merge?: ReviewMergeRecord;
    // The next review's summary and the last Post review's outcome (FR-REV-010).
    summary?: ReviewSummary;
    publish?: ReviewPublishRecord;
};

// The PR a Review tab shows, kept in its block's meta (PrMetaKey).
export type ReviewPrInfo = {
    dir: string;
    repo: string;
    number: number;
    title?: string;
    url?: string;
    headref: string;
    baseref: string;
    headoid?: string;
    baseoid?: string;
    ticket?: number;
};

export const ReviewPrMetaKey = "molten:review";

function call<T>(command: string, data: any, timeout = CallTimeoutMs): Promise<T> {
    return TabRpcClient.wshRpcCall(command, data, { route: ReviewRoute, timeout });
}

export function openReviewTab(workspaceid: string, pr: ReviewPrInfo): Promise<{ tabid: string; created?: boolean }> {
    return call(OpenCommand, { workspaceid, pr });
}

// openReviewAiPane returns the PR's AI panel in the tab, creating it right of the review block (DS-REV-012).
export function openReviewAiPane(
    tabid: string,
    blockid: string,
    pr: ReviewPrInfo
): Promise<{ blockid: string; created?: boolean }> {
    return call(AiPaneCommand, { tabid, blockid, pr });
}

export function reviewFiles(req: ReviewFilesRequest): Promise<ReviewFilesResult> {
    return call(FilesCommand, req, GitTimeoutMs);
}

export function reviewFile(req: {
    dir: string;
    path: string;
    oldblob?: string;
    newblob?: string;
    load?: boolean;
}): Promise<ReviewFileResult> {
    return call(FileCommand, req, GitTimeoutMs);
}

export function reviewCompare(req: {
    dir: string;
    headref: string;
    from: string;
    to: string;
}): Promise<ReviewCompareResult> {
    return call(CompareCommand, req, GitTimeoutMs);
}

export function reviewWorktree(req: {
    dir: string;
    number: number;
    headref: string;
    headoid: string;
}): Promise<ReviewWorktree> {
    return call(WorktreeCommand, req, GitTimeoutMs);
}

export function reviewState(repo: string, num: number): Promise<ReviewState> {
    return call(StateCommand, { repo, number: num });
}

// must match PrStateResult in pkg/molten/review/prstate.go
export type ReviewPrStateResult = {
    state: "open" | "merged" | "closed";
    baseref?: string;
    mergedoid?: string;
    mergedat?: string;
    closedat?: string;
};

// reviewPrState reads the PR's state on GitHub (#686): merged or closed outside MoltenTerm.
export function reviewPrState(dir: string, repo: string, num: number): Promise<ReviewPrStateResult> {
    return call(PrStateCommand, { dir, repo, number: num });
}

export function setReviewViewed(
    repo: string,
    num: number,
    path: string,
    blob: string,
    viewed: boolean
): Promise<ReviewState> {
    return call(ViewedCommand, { repo, number: num, path, blob: blob || undefined, viewed });
}

export function setReviewShown(repo: string, num: number, headoid: string): Promise<ReviewState> {
    return call(ShownCommand, { repo, number: num, headoid });
}

// Validate (FR-REV-012): the plan reads the PR once on GitHub; the merge starts on the developer's click and reports
// through the review store.
export function reviewMergePlan(req: {
    dir: string;
    repo: string;
    number: number;
    ticket?: number;
}): Promise<ReviewMergePlan> {
    return call(MergePlanCommand, req, GitTimeoutMs);
}

export function reviewMerge(
    repo: string,
    num: number,
    planid: string,
    override: boolean,
    method?: ReviewMergeMethod
): Promise<ReviewMergeRecord> {
    return call(MergeCommand, { repo, number: num, planid, override: override || undefined, method });
}

// Validate's method for a repository's base, for the batch modal (#957): must match MergeMethods in
// pkg/molten/review/mergemethod.go.
export type ReviewMergeMethods = {
    methods: ReviewMergeMethod[];
    method: ReviewMergeMethod;
    methodrule?: "queue" | "ruleset" | "linear";
    queue?: boolean;
    methodrefused?: ReviewMergeMethod;
};

export function reviewMergeMethods(dir: string, repo: string, base: string): Promise<ReviewMergeMethods> {
    return call(MergeMethodsCommand, { dir, repo, base }, GitTimeoutMs);
}

export function reviewMergeCancel(repo: string, num: number): Promise<void> {
    return call(MergeCancelCommand, { repo, number: num });
}

// must match pkg/molten/review/comments.go and drafting.go
export type ReviewCommentSubject = "line" | "file";
// proposed: a comment the review session's agent proposed, the developer's only once accepted (FR-REV-009).
export type ReviewCommentState = "draft" | "staged" | "translated" | "published" | "dropped" | "proposed";
export type ReviewCommentKind = "comment" | "change";
// editedbyuser: a translation the developer wrote or changed, which the agent never replaces.
export type ReviewCommentText = { lang?: string; text: string; editedbyuser?: boolean };
export type ReviewCommentAction = "stage" | "unstage" | "drop" | "restore" | "accept";

// One entry of a comment's history: the state after it, and the text when it changed (FR-REV-009 AC5).
export type ReviewCommentEvent = {
    at: number;
    event: string;
    state: ReviewCommentState;
    kind?: ReviewCommentKind;
    text?: string;
    by: string;
};

// One message of a comment's discussion with the review session: the developer's, or the agent's reply (markdown)
// with an optional rewrite of the comment.
export type ReviewCommentMessage = {
    id: string;
    at: number;
    by: "developer" | "agent";
    text?: string;
    rewrite?: string;
    rewritestate?: "proposed" | "accepted" | "ignored";
    agent?: string;
};

export type ReviewComment = {
    id: string;
    round?: string;
    anchor: ReviewAnchor;
    // line: a GitHub line comment on the anchor; file: a file-level comment quoting the anchor's excerpt.
    subject: ReviewCommentSubject;
    // comment: a remark or question for the PR's author; change: a change request.
    kind: ReviewCommentKind;
    state: ReviewCommentState;
    // The developer's text, in their language; translation: its version in the publication language (FR-REV-010).
    original: ReviewCommentText;
    translation?: ReviewCommentText;
    githubcommentid?: number;
    // How GitHub got it (line or file comment, review: a section of the review's body) and why not as a line comment.
    publishedas?: "line" | "file" | "review";
    publishnote?: ReviewPublishNoteKind;
    // developer, agent (a proposal) or agent-proposal-accepted.
    author: string;
    // The lines are not in the head shown any more; the comment keeps its excerpt.
    outdated?: boolean;
    createdat: number;
    updatedat?: number;
    history?: ReviewCommentEvent[];
    discussion?: ReviewCommentMessage[];
};

export type ReviewCommentRequest = {
    // Set: changes that comment's text (and kind); otherwise a new draft on the anchor.
    id?: string;
    anchor?: ReviewAnchor;
    subject?: ReviewCommentSubject;
    kind?: ReviewCommentKind;
    text: string;
    lang?: string;
};

export function saveReviewComment(repo: string, num: number, req: ReviewCommentRequest): Promise<ReviewState> {
    return call(CommentCommand, { repo, number: num, ...req });
}

// setReviewCommentState stages, unstages, drops, restores or accepts (a proposal) a comment (FR-REV-009).
export function setReviewCommentState(
    repo: string,
    num: number,
    id: string,
    action: ReviewCommentAction
): Promise<ReviewState> {
    return call(CommentStateCommand, { repo, number: num, id, action });
}

// useReviewRewrite takes (accept) or ignores the rewrite an agent's reply proposed.
export function useReviewRewrite(
    repo: string,
    num: number,
    id: string,
    messageid: string,
    accept: boolean
): Promise<ReviewState> {
    return call(RewriteCommand, { repo, number: num, id, messageid, accept });
}

// sent: typed into the agent's prompt (submitted: with Enter), state: the store with the developer's message. busy:
// the agent works or waits for an answer, nothing was typed.
export type ReviewDiscussResult = {
    sent: boolean;
    submitted?: boolean;
    busy?: boolean;
    // starting: the agent was not ready, nothing was typed (review-ready.ts sends again).
    starting?: boolean;
    line?: string;
    message?: string;
    // Why nothing was typed (review-session-text.ts).
    reason?: string;
    program?: string;
    state?: ReviewState;
};

// discussReviewComment sends a comment and its lines to the PR's review session, with the developer's message.
export function discussReviewComment(
    repo: string,
    num: number,
    id: string,
    message: string
): Promise<ReviewDiscussResult> {
    return call(DiscussCommand, { repo, number: num, id, message: message || undefined }, DiscussTimeoutMs);
}

// relocateReviewComments moves the comments made on other heads to the head shown, or marks them outdated.
export function relocateReviewComments(req: {
    repo: string;
    number: number;
    dir: string;
    headoid: string;
    baseoid: string;
}): Promise<ReviewState> {
    return call(RelocateCommand, req, GitTimeoutMs);
}

// must match pkg/molten/review/publish.go and translation.go (FR-REV-010)
export type ReviewPublishNoteKind =
    | "filelevel"
    | "outdated"
    | "otherhead"
    | "outsidediff"
    | "refused"
    | "late"
    | "notinpr"
    | "failed";
export type ReviewPublishNote = {
    commentid: string;
    note: ReviewPublishNoteKind;
    message?: string;
    messagetext?: ServerText;
};
export type ReviewPublishState = "publishing" | "published" | "partial" | "failed";
export type ReviewPublishRecord = {
    roundid: string;
    state: ReviewPublishState;
    lang: string;
    aswritten?: boolean;
    headoid: string;
    reviewid?: number;
    url?: string;
    message?: string;
    messagetext?: ServerText;
    notes?: ReviewPublishNote[];
    startedat: number;
    endedat?: number;
};
export type ReviewSummary = { original: ReviewCommentText; translation?: ReviewCommentText };
// The publication language and where it came from (pkg/molten/reviewlang).
export type ReviewLanguage = { lang: string; name: string; source: "project" | "setting" | "detected" | "default" };
export type ReviewTranslateResult = ReviewDiscussResult & { language: ReviewLanguage; count: number };
// The review summary's id in a translation (mcpreview.SummaryId).
export const ReviewSummaryId = "summary";

export function reviewPublishInfo(dir: string, repo: string, num: number): Promise<ReviewLanguage> {
    return call(PublishInfoCommand, { dir, repo, number: num }, GitTimeoutMs);
}

// translateReview asks the PR's review session to translate the staged comments not yet in the publication language;
// all asks again for those the agent already translated (never the developer's own).
export function translateReview(dir: string, repo: string, num: number, all: boolean): Promise<ReviewTranslateResult> {
    return call(TranslateCommand, { dir, repo, number: num, all: all || undefined }, GitTimeoutMs);
}

// setReviewTranslation keeps the developer's translation of a comment or of the summary (ReviewSummaryId); empty
// clears it.
export function setReviewTranslation(
    repo: string,
    num: number,
    id: string,
    text: string,
    lang: string
): Promise<ReviewState> {
    return call(TranslationCommand, { repo, number: num, id, text, lang });
}

export function setReviewSummary(repo: string, num: number, text: string, lang: string): Promise<ReviewState> {
    return call(SummaryCommand, { repo, number: num, text, lang });
}

// publishReview is the developer's click on Post review (aswritten: Post as written); the store says what was posted.
export function publishReview(req: {
    repo: string;
    number: number;
    dir: string;
    headoid: string;
    baseoid?: string;
    aswritten?: boolean;
}): Promise<ReviewState> {
    return call(PublishCommand, req, PublishTimeoutMs);
}

// restartReviewWork is the developer's click on Restart work (FR-REV-011): the last published round goes to an agent in
// the worktree of the PR's branch; with no agent there it answers offer, and start starts one the chosen way (#758).
export function restartReviewWork(
    req: {
        repo: string;
        number: number;
        dir: string;
        headref: string;
        baseref?: string;
        title?: string;
        url?: string;
        ticket?: number;
    } & AgentStart
): Promise<ReviewRestartResult> {
    return call(RestartCommand, req, RestartTimeoutMs);
}

// askReviewRebase is the developer's click on Ask for a rebase in the Reviews list (#683): the agent on the PR's branch
// gets the rebase; with start, a new agent starts the chosen way (#758) when none works there.
export function askReviewRebase(
    req: {
        repo: string;
        number: number;
        dir: string;
        headref: string;
        baseref: string;
        headoid?: string;
        title?: string;
        url?: string;
        ticket?: number;
        mergedpr?: number;
    } & AgentStart
): Promise<ReviewRestartResult> {
    return call(RebaseCommand, req, RestartTimeoutMs);
}

const InvestigateCommand = "moltenreviewinvestigate";

// must match InvestigateCheck in pkg/molten/review/investigate.go
export type InvestigateCheck = {
    name: string;
    workflow?: string;
    url?: string;
    runid?: number;
    jobid?: number;
    local?: boolean;
};

// The blockers a row read (#1020), as InvestigateRequest in pkg/molten/review/investigate.go names them.
export type InvestigateBlockers = {
    checks?: InvestigateCheck[];
    merge?: "behind" | "conflicts";
    changesrequested?: boolean;
    noreport?: boolean;
    localseen?: boolean;
};

// askReviewInvestigate is the developer's click on Analyze and resolve (#797, #1020): the agent on the PR's branch, or a
// new one once the developer chose how (Start), resolves the PR's blockers in order.
export function askReviewInvestigate(
    req: {
        repo: string;
        number: number;
        dir: string;
        headref: string;
        baseref: string;
        headoid?: string;
        title?: string;
        url?: string;
        ticket?: number;
    } & InvestigateBlockers &
        AgentStart
): Promise<ReviewRestartResult> {
    return call(InvestigateCommand, req, RestartTimeoutMs);
}

// must match FinishCommand in pkg/molten/review/finish.go
const FinishCommand = "moltenreviewfinish";

// askReviewFinish is Check the agents in the Reviews list (#954), for one PR: the agent on its branch, or a new one once
// the developer confirmed (Start), verifies the PR against its ticket and finishes what is left.
export function askReviewFinish(
    req: {
        repo: string;
        number: number;
        dir: string;
        headref: string;
        baseref: string;
        headoid?: string;
        title?: string;
        url?: string;
        ticket?: number;
        conflicts?: boolean;
        failedchecks?: string[];
        changesrequested?: boolean;
        noreport?: boolean;
    } & AgentStart
): Promise<ReviewRestartResult> {
    return call(FinishCommand, req, RestartTimeoutMs);
}

// must match ReleaseResolveCommand in pkg/molten/review/release_resolve.go
const ReleaseResolveCommand = "moltenreviewreleaseresolve";

// askReleaseResolve is the developer's click on Analyze and resolve (background) or Investigate together (together) on
// a failed release step (#945): a new agent starts in its own copy of the trunk with the release's rules.
export function askReleaseResolve(req: {
    dir: string;
    repo?: string;
    tag: string;
    phase: string;
    step: string;
    trunk: string;
    log?: string;
    runs?: InvestigateCheck[];
    mode: AgentMode;
    workspaceid: string;
    tabname?: string;
}): Promise<ReviewRestartResult> {
    return call(ReleaseResolveCommand, req, RestartTimeoutMs);
}

const MarkReadyCommand = "moltenreviewmarkready";

// markReviewReady is the developer's click on Mark ready for review (#687): gh pr ready on the draft PR.
export function markReviewReady(req: { repo: string; number: number; dir: string }): Promise<MarkReadyResult> {
    return call(MarkReadyCommand, req, GitTimeoutMs);
}

// subscribeReviewState follows a PR's review store (another window, the CLI); returns the unsubscribe function.
export function subscribeReviewState(repo: string, num: number, handler: (state: ReviewState) => void): () => void {
    return waveEventSubscribeSingle({
        eventType: ReviewUpdateEvent as WaveEventName,
        scope: reviewScope(repo, num),
        handler: (event) => handler(event.data as ReviewState),
    });
}
