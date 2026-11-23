// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Companion's permission request card (#2155, #2474): what the agent asks to run, and how the developer answers it.
// A request MoltenTerm holds for the companion (companion-permit-model.ts) offers Allow, Deny and Answer in the terminal
// with the time left before it goes back to the agent's own prompt; one the deny list keeps for the developer offers the
// way to the terminal and says why; any other (an older run, Kimi's observation-only hook) shows what the transcript says
// and the way to the terminal. Hook-free, so the cards are tested without a window.

import { cn } from "@/util/util";
import type { AgentStateInfo } from "../agent-state-model";
import type { TFunction } from "../i18n/i18n";
import { serverText } from "../i18n/server-text";
import { MoltenWave } from "../molten-button";
import { CompanionToolCall, formatArgs } from "./companion-model";
import {
    countdownText,
    folderName,
    PermitDecision,
    permitKind,
    PermitRequest,
    requestText,
    sentence,
} from "./companion-permit-model";
import "./companion-permit.css";

export type TerminalLocation = { workspaceid?: string; tabid?: string; blockid: string };

// The terminal the Companion follows, where its agent's state says it is; the block alone when no state is known.
export function permissionTerminalOf(target: string, info: AgentStateInfo): TerminalLocation {
    if (!target) {
        return null;
    }
    return { workspaceid: info?.workspaceid, tabid: info?.tabid, blockid: target };
}

// Called as a function, not rendered, so the cards stay a tree a test reads without a window.
function goToTerminalButton(t: TFunction, onShowTerminal: () => void) {
    return (
        <button
            type="button"
            className="molten-btn cursor-pointer rounded-4 px-3 py-1 text-12"
            data-testid="companion-permission-terminal"
            onClick={onShowTerminal}
        >
            {t("companion.goToTerminal")}
            <MoltenWave />
        </button>
    );
}

// The body of the permission block (#2441) for a request the transcript shows: who asks to run what, its arguments sunk
// in mono, and the way to the terminal where the developer answers it. hint: one line under it, for a run that cannot
// be answered from here and says why.
export function PermissionRequestCard({
    request,
    t,
    onShowTerminal,
    agent,
    hint,
}: {
    request: CompanionToolCall;
    t: TFunction;
    onShowTerminal: () => void;
    // The agent's first name, "" when unknown.
    agent?: string;
    hint?: string;
}) {
    if (request == null) {
        return null;
    }
    const tool = <span data-mono="">{request.tool}</span>;
    return (
        <div className="flex flex-col gap-2.5" data-testid="companion-permission">
            <div className="mt-cdash-perm-line">
                {agent ? t("companion.dash.wantsToRun", { name: agent }) : t("companion.dash.wantsToRunPlain")} {tool}
            </div>
            {request.args ? <pre className="mt-cdash-perm-args">{formatArgs(request.args)}</pre> : null}
            <div className="mt-cdash-act">
                <span>{t("companion.answerInTerminal")}</span>
                {goToTerminalButton(t, onShowTerminal)}
            </div>
            {hint ? (
                <div className="mt-cdash-perm-meta" data-testid="companion-permit-restart">
                    {hint}
                </div>
            ) : null}
        </div>
    );
}

export type PermitRequestCardProps = {
    request: PermitRequest;
    t: TFunction;
    // The agent's first name, "" when unknown.
    agent?: string;
    now: number;
    // An answer is on its way: nothing is clicked twice.
    busy?: boolean;
    // What went wrong with the last answer, already worded.
    error?: string;
    onAnswer: (decision: PermitDecision) => void;
    onShowTerminal: () => void;
};

// The body of the permission block for a request MoltenTerm knows exactly (#2474): the sentence for what is asked, the
// exact command or input in a mono box, the tool and the project, then either the three answers and the time left, or
// the deny list's reason and the way to the terminal.
export function PermitRequestCard({
    request,
    t,
    agent,
    now,
    busy,
    error,
    onAnswer,
    onShowTerminal,
}: PermitRequestCardProps) {
    if (request == null) {
        return null;
    }
    const name = agent || t("companion.permit.agentPlain");
    const text = requestText(request);
    const folder = folderName(request.cwd);
    const held = request.state === "held";
    return (
        <div
            className="flex flex-col gap-2.5"
            data-testid="companion-permission"
            data-state={request.state}
            aria-busy={busy ? true : undefined}
        >
            <div className="mt-cdash-perm-line">{t(`companion.permit.line.${permitKind(request.tool)}`, { name })}</div>
            {text ? (
                <pre className="mt-cdash-perm-args mt-cdash-perm-text" tabIndex={0} data-testid="companion-permit-text">
                    {text}
                </pre>
            ) : null}
            <div className="mt-cdash-perm-meta" data-testid="companion-permit-meta">
                {folder
                    ? t("companion.permit.meta", { tool: request.tool, folder })
                    : t("companion.permit.metaTool", { tool: request.tool })}
            </div>
            {request.clipped ? <div className="mt-cdash-perm-meta">{t("companion.permit.clipped")}</div> : null}
            {held ? (
                <div
                    className="mt-cdash-perm-act"
                    role="group"
                    aria-label={t("companion.permit.actions", { name })}
                    data-testid="companion-permit-actions"
                >
                    <button
                        type="button"
                        className="molten-btn cursor-pointer rounded-4 px-3 py-1 text-12"
                        data-testid="companion-permit-allow"
                        disabled={busy}
                        onClick={() => onAnswer("allow")}
                    >
                        {t("companion.permit.allow")}
                        <MoltenWave />
                    </button>
                    <button
                        type="button"
                        className="molten-btn-secondary cursor-pointer rounded-4 px-3 py-1 text-12"
                        data-testid="companion-permit-deny"
                        disabled={busy}
                        onClick={() => onAnswer("deny")}
                    >
                        {t("companion.permit.deny")}
                    </button>
                    <button
                        type="button"
                        className="molten-btn-ghost cursor-pointer rounded-4 px-2 py-1 text-12 underline underline-offset-2"
                        data-testid="companion-permit-terminal"
                        disabled={busy}
                        onClick={() => onAnswer("terminal")}
                    >
                        {t("companion.permit.terminal")}
                    </button>
                    {request.deadline != null ? (
                        <span className="mt-cdash-perm-count" data-testid="companion-permit-countdown">
                            {t("companion.permit.countdown", { time: countdownText(request.deadline, now) })}
                        </span>
                    ) : null}
                </div>
            ) : (
                <>
                    <div
                        className="mt-cdash-perm-strip"
                        role="note"
                        aria-label={t("companion.permit.denyListLabel")}
                        data-testid="companion-permit-denylist"
                    >
                        <i className="fa fa-solid fa-triangle-exclamation" aria-hidden="true" />
                        <span>
                            {request.reason
                                ? t("companion.permit.denyList", {
                                      reason: sentence(serverText(request.reasontext, request.reason)),
                                  })
                                : t("companion.permit.denyListPlain")}
                        </span>
                    </div>
                    <div className="mt-cdash-act">{goToTerminalButton(t, onShowTerminal)}</div>
                </>
            )}
            {error ? (
                <div
                    className={cn("mt-cdash-perm-meta", "mt-cdash-perm-error")}
                    role="alert"
                    data-testid="companion-permit-error"
                >
                    {error}
                </div>
            ) : null}
        </div>
    );
}
