// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Restart work (FR-REV-011): the Review tab's header button, and the line under the header that follows the agent the
// round went to (its live state from the agent states) and, after its push, offers the changes since the round.

import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { AgentStateDotClasses } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { useLocale } from "../i18n/i18n";
import { shortOid } from "./review-model";
import {
    folderName,
    lastPublished,
    pushedSinceRound,
    restartButtonTitle,
    restartLine,
    restartOutcome,
    restartResultTone,
    RestartText,
} from "./review-restart";
import { ReviewTabModel } from "./review-tab-model";

const ToolbarButton =
    "flex h-6 cursor-pointer items-center gap-1.5 rounded-6 border border-border px-2 text-12 whitespace-nowrap text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";

const LinkButton = "cursor-pointer text-12 text-secondary underline-offset-2 hover:text-primary hover:underline";

const ToneClasses: Record<string, string> = {
    ok: "text-success",
    warn: "text-warning",
    fail: "text-error",
};

export function RestartButton({ model }: { model: ReviewTabModel }) {
    useLocale();
    const state = useAtomValue(model.stateAtom);
    const restart = useAtomValue(model.restartAtom);
    const last = lastPublished(state);
    const restarting = restart.status === "restarting";
    return (
        <button
            type="button"
            className={ToolbarButton}
            disabled={last == null || restarting}
            onClick={() => fireAndForget(() => model.restartWork())}
            title={restartButtonTitle(last)}
            data-testid="review-restart"
        >
            {restarting ? (
                <i className="fa fa-solid fa-circle-notch fa-spin text-11" />
            ) : (
                <i className="fa fa-solid fa-arrow-rotate-right text-11" />
            )}
            {restarting ? RestartText.restarting() : RestartText.button()}
        </button>
    );
}

export function RestartStatus({ model }: { model: ReviewTabModel }) {
    useLocale();
    const state = useAtomValue(model.stateAtom);
    const restart = useAtomValue(model.restartAtom);
    const head = useAtomValue(model.headAtom);
    const mode = useAtomValue(model.modeAtom);
    const last = lastPublished(state);
    const blockId = last?.round?.restartedat ? last.round.restartblockid : null;
    const agent = useAtomValue(AgentStates.getInstance().blockAtom(blockId));
    const line = restartLine(last, agent);
    const outcome = restart.status === "done" ? restartOutcome(restart.result, restart.error) : "";
    if (!line && !outcome) {
        return null;
    }
    const tone = restart.error ? "fail" : restartResultTone(restart.result);
    const pushed = pushedSinceRound(last, head);
    const since = state?.since;
    const canShowSince = pushed && since?.published && since.to === head && mode !== "since";
    return (
        <div
            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1.5 text-12"
            data-testid="review-restart-status"
        >
            {line ? (
                <span className="flex min-w-0 items-center gap-1.5" data-state={agent?.state ?? "none"}>
                    {agent ? (
                        <span
                            className={cn(
                                "inline-block h-2 w-2 shrink-0 rounded-full",
                                AgentStateDotClasses[agent.state ?? "idle"]
                            )}
                        />
                    ) : (
                        <i className="fa fa-solid fa-arrow-rotate-right text-11 text-muted" />
                    )}
                    <span className="truncate text-secondary">
                        {line}
                        {last.round.restartworktree ? (
                            <span className="text-muted" title={last.round.restartworktree}>
                                {" "}
                                {RestartText.inWorktree(folderName(last.round.restartworktree))}
                            </span>
                        ) : null}
                    </span>
                    {agent ? (
                        <button
                            type="button"
                            className={LinkButton}
                            onClick={() => fireAndForget(() => model.showRestartAgent(agent))}
                        >
                            {RestartText.showAgent()}
                        </button>
                    ) : null}
                </span>
            ) : null}
            {pushed ? (
                <span className="flex items-center gap-1.5 text-secondary" data-testid="review-restart-pushed">
                    <i className="fa fa-solid fa-code-commit text-11" />
                    {RestartText.pushed(last.number)}
                    <code className="text-muted">
                        {shortOid(last.round.headoid)}..{shortOid(head)}
                    </code>
                    {canShowSince ? (
                        <button
                            type="button"
                            className={LinkButton}
                            onClick={() => fireAndForget(() => model.setMode("since"))}
                            data-testid="review-restart-since"
                        >
                            {RestartText.showSince()}
                        </button>
                    ) : null}
                </span>
            ) : null}
            {outcome ? (
                <span className="flex min-w-0 items-center gap-1.5" data-testid="review-restart-outcome">
                    <span className={cn("min-w-0 break-words", ToneClasses[tone])}>{outcome}</span>
                    <button type="button" className={LinkButton} onClick={() => model.dismissRestart()}>
                        {RestartText.dismiss()}
                    </button>
                </span>
            ) : null}
        </div>
    );
}
