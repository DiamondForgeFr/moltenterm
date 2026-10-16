// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Starting an agent for the developer (#758): nothing happens in MoltenTerm that they did not ask for. Before an agent
// starts for a rebase (Ask for a rebase, the Validate sheet's offer after a merge) or for Restart work, this dialog says
// what will happen and asks how: Let the agent handle it (out of sight: no tab, no focus change; its progress shows in
// the Reviews row and in Sessions, a notification says when it is done or needs them), or Go through it with the agent
// (its own tab, shown, terminal focused). Enter takes the default, Escape cancels.

import { atoms, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { DialogFrame } from "../dialog-frame";
import { t, useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { registerNotificationGesture } from "../notifications-store";
import { AgentMode, AgentStart, openReviewTab, ReviewPrInfo, ReviewRestartResult } from "../review/review-client";

// must match ReviewOpenGesture in pkg/molten/review/agentfollow.go
export const ReviewOpenGesture = "review:open";

export type AgentChoiceRequest = {
    kind: "rebase" | "restart" | "investigate";
    number: number;
    branch: string;
    base: string;
    // The agent that would start (its name), "" when wavesrv named none.
    agent?: string;
    round?: number;
    // checks: the failed checks an investigation reads (#797), named.
    checks?: string;
};

const ChoiceKeys: Record<AgentChoiceRequest["kind"], { title: string; what: string; together: string; tab: string; checkout: string }> =
    {
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
    };

type PendingChoice = AgentChoiceRequest & { answer: (mode: AgentMode) => void };

const PlainButton =
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
    ask(req: AgentChoiceRequest): Promise<AgentMode> {
        globalStore.get(this.pendingAtom)?.answer(null);
        return new Promise((resolve) => {
            globalStore.set(this.pendingAtom, {
                ...req,
                answer: (mode) => {
                    globalStore.set(this.pendingAtom, null);
                    resolve(mode);
                },
            });
        });
    }
}

export function askAgentChoice(req: AgentChoiceRequest): Promise<AgentMode> {
    return AgentChoiceModel.getInstance().ask(req);
}

// agentTabName: the agent's tab, named in the interface language.
export function agentTabName(kind: AgentChoiceRequest["kind"], number: number): string {
    return t(ChoiceKeys[kind].tab, { number });
}

// agentStartOf is what a request carries once the developer chose: the tab goes in this window's workspace.
export function agentStartOf(kind: AgentChoiceRequest["kind"], number: number, mode: AgentMode): AgentStart {
    return {
        start: true,
        mode,
        workspaceid: globalStore.get(atoms.workspace)?.oid,
        tabname: agentTabName(kind, number),
    };
}

// showStartedAgent: with the developer, the window shows the agent's tab; out of sight, nothing moves.
export function showStartedAgent(mode: AgentMode, result: ReviewRestartResult) {
    if (mode !== "together" || !result?.tabid || result.hidden) {
        return;
    }
    getApi().setActiveTab(result.tabid);
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
    getApi().setActiveTab(tabid);
    return { ok: true, resolve: true };
}

export function AgentChoiceHost() {
    const pending = useAtomValue(AgentChoiceModel.getInstance().pendingAtom);
    useEffect(() => registerNotificationGesture(ReviewOpenGesture, openReviewGesture), []);
    if (pending == null) {
        return null;
    }
    return <AgentChoiceDialog key={`${pending.kind}:${pending.number}`} pending={pending} />;
}

export function AgentChoiceDialog({ pending }: { pending: PendingChoice }) {
    const t = useT();
    const defaultRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        defaultRef.current?.focus();
        // On the window, before the document's listeners: the Validate sheet under this dialog keeps its Escape.
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape") {
                return;
            }
            e.stopPropagation();
            e.preventDefault();
            pending.answer(null);
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [pending]);
    const keys = ChoiceKeys[pending.kind];
    const vars = {
        number: pending.number,
        branch: pending.branch,
        base: pending.base,
        round: pending.round ?? 0,
        checks: pending.checks ?? "",
        agent: pending.agent || t("agentChoice.yourAgent"),
        tab: agentTabName(pending.kind, pending.number),
    };
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key !== "Enter" || (e.target as HTMLElement)?.tagName === "BUTTON") {
            return;
        }
        e.preventDefault();
        pending.answer("background");
    };
    return (
        <DialogFrame
            role="agent-choice"
            title={t(keys.title, vars)}
            subtitle={t("agentChoice.subtitle", vars)}
            widthClass="w-[520px]"
            trapFocus
            buttons={
                <>
                    <button
                        type="button"
                        className={PlainButton}
                        onClick={() => pending.answer(null)}
                        data-testid="agent-choice-cancel"
                    >
                        {t("common.cancel")}
                    </button>
                    <button
                        type="button"
                        className={PlainButton}
                        onClick={() => pending.answer("together")}
                        data-testid="agent-choice-together"
                    >
                        {t(keys.together)}
                    </button>
                    <button
                        ref={defaultRef}
                        type="button"
                        className="molten-btn cursor-pointer rounded-4 px-3 py-1 text-12"
                        onClick={() => pending.answer("background")}
                        data-testid="agent-choice-background"
                    >
                        {t("agentChoice.background.button")}
                        <MoltenWave />
                    </button>
                </>
            }
        >
            <div className="flex flex-col gap-3 text-12 leading-5" onKeyDown={onKeyDown} data-testid="agent-choice">
                <p className="text-secondary">
                    {t(keys.what, vars)}
                </p>
                <Option
                    icon="fa-eye-slash"
                    title={t("agentChoice.background.button")}
                    text={t("agentChoice.background.text", vars)}
                    marked
                />
                <Option
                    icon="fa-terminal"
                    title={t(keys.together)}
                    text={t("agentChoice.together.text", vars)}
                />
                <p className="text-muted">{t(keys.checkout, vars)}</p>
            </div>
        </DialogFrame>
    );
}

function Option({ icon, title, text, marked }: { icon: string; title: string; text: string; marked?: boolean }) {
    const t = useT();
    return (
        <div className={cn("flex gap-2.5 rounded-4 border px-3 py-2", marked ? "border-accent/50" : "border-border")}>
            <i className={cn("fa fa-solid mt-1 w-4 text-center text-11 text-muted", icon)} aria-hidden />
            <div className="min-w-0">
                <div className="font-medium text-primary">
                    {title}
                    {marked ? (
                        <span className="ml-2 text-10 font-semibold tracking-[0.08em] text-muted uppercase">
                            {t("agentChoice.default")}
                        </span>
                    ) : null}
                </div>
                <div className="text-secondary">{text}</div>
            </div>
        </div>
    );
}
