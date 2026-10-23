// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The review session's outcomes in the interface language (#652). wavesrv answers a reason code (pkg/molten/mcpreview's
// Reason…, or the typing path's reasons, pkg/molten/termupdate's InputReason…) with its English message, which is only
// the detail of the codes that carry one; an unknown code shows that message as it is. The prompts typed for the agent
// stay in English (wavesrv's).

import { t } from "../i18n/i18n";
import type { ReviewAskResult, ReviewBriefResult, ReviewSessionInfo, ReviewStartResult } from "./review-session";

export type SessionTextVars = {
    // The session's agent, by its display name.
    agent?: string;
    // What is in the foreground instead of the agent (notforeground).
    program?: string;
    // The command line that starts the agent (notstarted).
    command?: string;
    // The typing path's reason under a queue note (queuefailed).
    cause?: string;
};

// sessionReasonText words a reason in the interface language; message is wavesrv's English, the detail of the codes
// that carry one and what shows for a code this window does not know.
export function sessionReasonText(reason: string, message: string, vars: SessionTextVars = {}): string {
    const english = message ?? "";
    const v = {
        agent: vars.agent || t("review.ai.yourAgent"),
        program: vars.program ?? "",
        command: vars.command ?? "",
        message: english,
    };
    switch (reason) {
        case "notinstalled":
            return t("review.session.reason.notinstalled");
        case "agentmissing":
            return t("review.session.reason.agentmissing", v);
        case "alreadystarting":
            return t("review.session.reason.alreadystarting");
        case "nomolten":
            return t("review.session.reason.nomolten");
        case "head":
            return t("review.session.reason.head", v);
        case "worktree":
            return t("review.session.reason.worktree", v);
        case "command":
            return t("review.session.reason.command", v);
        case "terminal":
            return t("review.session.reason.terminal", v);
        case "notstarted":
            return t("review.session.reason.notstarted", v);
        case "sessionended":
            return t("review.session.reason.sessionended");
        case "cannottype":
            return t("review.session.reason.cannottype");
        case "agentstarting":
            return t("review.session.reason.agentstarting", v);
        case "queuehold":
            return t("review.session.reason.queuehold", v);
        case "queuefailed": {
            const why = vars.cause ? sessionReasonText(vars.cause, "", { ...vars, cause: undefined }) : "";
            return why ? t("review.session.reason.queuefailed", { why }) : english;
        }
        case "working":
            return t("review.session.reason.working", v);
        case "waiting":
            return t("review.session.reason.waiting", v);
        case "notforeground":
            if (!v.program || v.program === vars.agent) {
                return t("review.session.reason.notforegroundGone", v);
            }
            return t("review.session.reason.notforeground", v);
        case "noagent":
        case "terminalgone":
            return t("review.session.reason.noagent", v);
        case "busy":
            return t("review.session.reason.busy");
        case "unavailable":
            return t("review.session.reason.unavailable");
        case "unknownaction":
            return t("review.session.reason.unknownaction");
    }
    return english;
}

export function startResultText(result: ReviewStartResult): string {
    return sessionReasonText(result?.reason, result?.message, { agent: result?.agentname });
}

// localizeSession words a session's message and queue note in the interface language; the rest is wavesrv's.
export function localizeSession(session: ReviewSessionInfo): ReviewSessionInfo {
    if (session == null) {
        return session;
    }
    const vars = { agent: session.agentname, command: session.command };
    return {
        ...session,
        message: session.reason ? sessionReasonText(session.reason, session.message, vars) : session.message,
        queuenote: session.queuenotereason
            ? sessionReasonText(session.queuenotereason, session.queuenote, { ...vars, cause: session.queuenotecause })
            : session.queuenote,
    };
}

// localizeAsk words what Ask the AI, Discuss or the translation request did; agent: the session's.
export function localizeAsk<T extends Pick<ReviewAskResult, "message" | "reason" | "program">>(
    result: T,
    agent: string
): T {
    if (result == null || !result.reason) {
        return result;
    }
    return { ...result, message: sessionReasonText(result.reason, result.message, { agent, program: result.program }) };
}

export function localizeBrief(result: ReviewBriefResult, agent: string): ReviewBriefResult {
    if (result == null) {
        return result;
    }
    if (result.status === "typed") {
        return { ...result, message: t("review.session.briefTyped") };
    }
    if (!result.reason) {
        return result;
    }
    return { ...result, message: sessionReasonText(result.reason, result.message, { agent, program: result.program }) };
}
