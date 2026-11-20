// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Starting an agent for the developer (#758): nothing happens in MoltenTerm that they did not ask for. Before an agent
// starts for a rebase (Ask for a rebase, the Validate sheet's offer after a merge) or for Restart work, this dialog says
// what will happen and asks how: Let the agent handle it (out of sight: no tab, no focus change; its progress shows in
// the Reviews row and in Sessions, a notification says when it is done or needs them), or Go through it with the agent
// (its own tab, shown, terminal focused). The two options are a radio group (#930): a click or the arrows only select,
// the default is selected and focused at open. Validate (or Enter) starts the agent in the selected mode; Cancel and
// Escape start nothing. The dialog itself is agent-choice-dialog.tsx, loaded when an agent is to start.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { lazy, Suspense, useEffect } from "react";
import { preferredProviderId } from "../agent-info/providers-in-use";
import { refreshProviderUse } from "../agent-info/providers-in-use-use";
import { t } from "../i18n/i18n";
import { registerNotificationGesture } from "../notifications-store";
import { showTabFromHere } from "../opener-tab";
import { AgentMode, AgentStart, openReviewTab, ReviewPrInfo, ReviewRestartResult } from "../review/review-client";
import { reviewsCardGesture, ReviewsCardGesture } from "./reviews-card-gesture";
import { investigateGesture, InvestigateGesture } from "./reviews-queue-gesture";
import { reviewsResendGesture, ReviewsResendGesture } from "./reviews-resend-gesture";

// must match ReviewOpenGesture in pkg/molten/review/agentfollow.go
export const ReviewOpenGesture = "review:open";

export type AgentChoiceRequest = {
    kind: "rebase" | "restart" | "investigate" | "finish";
    number: number;
    branch: string;
    base: string;
    // The agent that would start (its name), "" when wavesrv named none.
    agent?: string;
    round?: number;
    // checks: the failed checks an investigation reads (#797), named.
    checks?: string;
    // The coding agent (#845): the one that would start (its id), the agents the developer can switch to for this
    // run, and the chosen agent when it is not installed (nothing starts until another is picked).
    agentid?: string;
    agents?: { id: string; name: string; installed: boolean }[];
    missing?: string;
    // The agent name the pull request's signature gives (#2431): a resume leads with the provider that made the PR.
    prAgent?: string;
};

// The developer's answer: how the agent works, and the agent picked for this run when they switched.
export type AgentChoiceAnswer = { mode: AgentMode; agent?: string };

// agentChoiceOf: the dialog's request fields from wavesrv's offer.
export function agentChoiceOf(
    result: Pick<ReviewRestartResult, "agent" | "agentname" | "agents" | "agentmissing" | "chosenagent" | "chosenname">
): Partial<AgentChoiceRequest> {
    if (result == null) {
        return {};
    }
    return {
        agent: result.agentname ?? "",
        agentid: result.agent ?? "",
        agents: result.agents,
        missing: result.agentmissing ? result.chosenname || result.chosenagent : undefined,
    };
}

export const ChoiceKeys: Record<
    AgentChoiceRequest["kind"],
    { title: string; what: string; together: string; tab: string; checkout: string }
> = {
    rebase: {
        title: "agentChoice.title.rebase",
        what: "agentChoice.what.rebase",
        together: "agentChoice.together.rebase",
        tab: "agentChoice.tab.rebase",
        checkout: "agentChoice.checkout",
    },
    restart: {
        title: "agentChoice.title.restart",
        what: "agentChoice.what.restart",
        together: "agentChoice.together.restart",
        tab: "agentChoice.tab.restart",
        checkout: "agentChoice.checkout",
    },
    investigate: {
        title: "agentChoice.title.investigate",
        what: "agentChoice.what.investigate",
        together: "agentChoice.together.investigate",
        tab: "agentChoice.tab.investigate",
        checkout: "agentChoice.checkoutInvestigate",
    },
    finish: {
        title: "agentChoice.title.finish",
        what: "agentChoice.what.finish",
        together: "agentChoice.together.finish",
        tab: "agentChoice.tab.finish",
        checkout: "agentChoice.checkout",
    },
};

export type PendingChoice = AgentChoiceRequest & { answer: (mode: AgentMode, agent?: string) => void };

export const DefaultMode: AgentMode = "background";

export const PlainButton =
    "cursor-pointer rounded-4 border border-border px-3 py-1 text-12 text-secondary hover:bg-hover hover:text-primary";

export class AgentChoiceModel {
    private static instance: AgentChoiceModel = null;

    pendingAtom = atom(null) as PrimitiveAtom<PendingChoice>;

    private constructor() {}

    static getInstance(): AgentChoiceModel {
        if (AgentChoiceModel.instance == null) {
            AgentChoiceModel.instance = new AgentChoiceModel();
        }
        return AgentChoiceModel.instance;
    }

    // ask resolves with the developer's choice, null when they cancel (or another ask replaced this one).
    ask(req: AgentChoiceRequest): Promise<AgentChoiceAnswer> {
        globalStore.get(this.pendingAtom)?.answer(null);
        return new Promise((resolve) => {
            globalStore.set(this.pendingAtom, {
                ...req,
                answer: (mode, agent) => {
                    globalStore.set(this.pendingAtom, null);
                    resolve(mode == null ? null : agent ? { mode, agent } : { mode });
                },
            });
        });
    }
}

export function askAgentChoice(req: AgentChoiceRequest): Promise<AgentChoiceAnswer> {
    return AgentChoiceModel.getInstance().ask(req);
}

// agentTabName: the agent's tab, named in the interface language.
export function agentTabName(kind: AgentChoiceRequest["kind"], number: number): string {
    return t(ChoiceKeys[kind].tab, { number });
}

// agentStartOf is what a request carries once the developer chose: the tab goes in this window's workspace, and the
// agent picked for this run when they switched.
export function agentStartOf(
    kind: AgentChoiceRequest["kind"],
    number: number,
    mode: AgentMode,
    agent?: string
): AgentStart {
    return {
        start: true,
        mode,
        workspaceid: globalStore.get(atoms.workspace)?.oid,
        tabname: agentTabName(kind, number),
        ...(agent ? { agent } : {}),
    };
}

// The agent that starts once the developer answers: the one they picked, else the offer's; none while the chosen one
// is missing and nothing was picked.
export function pickedAgent(pending: AgentChoiceRequest, picked: string): string {
    if (picked) {
        return picked;
    }
    if (pending.missing) {
        return "";
    }
    return preferredProviderId(pending.prAgent, pending.agents) || (pending.agentid ?? "");
}

// answerAgentChoice: Validate with the selected mode (or null for Cancel) answers the dialog; Validate does nothing
// while no agent can start. The agent travels only when the developer switched, or the project's choice is missing.
export function answerAgentChoice(pending: PendingChoice, picked: string, mode: AgentMode) {
    const agent = pickedAgent(pending, picked);
    if (mode != null && !agent) {
        return;
    }
    pending.answer(mode, agent && (picked != null || pending.missing) ? agent : undefined);
}

// showStartedAgent: with the developer, the window shows the agent's tab; out of sight, nothing moves.
export function showStartedAgent(mode: AgentMode, result: ReviewRestartResult) {
    if (mode !== "together" || !result?.tabid || result.hidden) {
        return;
    }
    showTabFromHere(result.tabid);
}

function readPrInfo(value: any): ReviewPrInfo {
    if (value == null || typeof value !== "object" || typeof value.dir !== "string" || typeof value.repo !== "string") {
        return null;
    }
    return typeof value.number === "number" ? (value as ReviewPrInfo) : null;
}

// A notification's Open the review: the PR's Review tab in this window's workspace.
async function openReviewGesture(args: Record<string, any>) {
    const pr = readPrInfo(args?.pr);
    const workspaceId = globalStore.get(atoms.workspace)?.oid;
    if (pr == null || !workspaceId) {
        return { ok: false, error: t("agentChoice.noReview") };
    }
    const { tabid } = await openReviewTab(workspaceId, pr);
    showTabFromHere(tabid);
    return { ok: true, resolve: true };
}

// The dialog's code loads when an agent is to start: it stays out of the first JavaScript (NFR-PERF-003).
const LazyAgentChoiceDialog = lazy(() =>
    import("./agent-choice-dialog").then((m) => ({ default: m.AgentChoiceDialog }))
);

export function AgentChoiceHost() {
    const pending = useAtomValue(AgentChoiceModel.getInstance().pendingAtom);
    useEffect(() => fireAndForget(refreshProviderUse), []);
    useEffect(() => registerNotificationGesture(ReviewOpenGesture, openReviewGesture), []);
    useEffect(() => registerNotificationGesture(InvestigateGesture, investigateGesture), []);
    useEffect(() => registerNotificationGesture(ReviewsCardGesture, reviewsCardGesture), []);
    useEffect(() => registerNotificationGesture(ReviewsResendGesture, reviewsResendGesture), []);
    if (pending == null) {
        return null;
    }
    return (
        <Suspense fallback={null}>
            <LazyAgentChoiceDialog key={`${pending.kind}:${pending.number}`} pending={pending} />
        </Suspense>
    );
}
