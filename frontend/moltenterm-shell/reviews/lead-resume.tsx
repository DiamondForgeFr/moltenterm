// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Resume with a lead agent that no longer runs (#1779, FR-REV-022 AC19): nothing starts unasked (#758), so before the
// lead's session starts again this dialog says what will happen. Resume {name} (the default, Enter) starts the lead's
// CLI on its session in a tab shown to the developer and hands it the work once its prompt is up; New agent goes the
// usual way (the agent choice dialog); Cancel and Escape start nothing.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { DialogFrame } from "../dialog-frame";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";

export type LeadResumeAnswer = "resume" | "new";

export type LeadResumeRequest = {
    number: number;
    // The lead's first name and its CLI's name.
    name: string;
    agent: string;
    // Where its session would resume, and whether that is only the CLI's most recent session of the folder.
    folder: string;
    guessed: boolean;
};

export type PendingLeadResume = LeadResumeRequest & { answer: (choice: LeadResumeAnswer) => void };

const PlainButton =
    "cursor-pointer rounded-4 border border-border px-3 py-1 text-12 text-secondary hover:bg-hover hover:text-primary";

export class LeadResumeModel {
    private static instance: LeadResumeModel = null;

    pendingAtom = atom(null) as PrimitiveAtom<PendingLeadResume>;

    private constructor() {}

    static getInstance(): LeadResumeModel {
        if (LeadResumeModel.instance == null) {
            LeadResumeModel.instance = new LeadResumeModel();
        }
        return LeadResumeModel.instance;
    }

    // ask resolves with the developer's choice, null when they cancel (or another ask replaced this one).
    ask(req: LeadResumeRequest): Promise<LeadResumeAnswer> {
        globalStore.get(this.pendingAtom)?.answer(null);
        return new Promise((resolve) => {
            globalStore.set(this.pendingAtom, {
                ...req,
                answer: (choice) => {
                    globalStore.set(this.pendingAtom, null);
                    resolve(choice);
                },
            });
        });
    }
}

export function askLeadResume(req: LeadResumeRequest): Promise<LeadResumeAnswer> {
    return LeadResumeModel.getInstance().ask(req);
}

export function LeadResumeHost() {
    const pending = useAtomValue(LeadResumeModel.getInstance().pendingAtom);
    if (pending == null) {
        return null;
    }
    return <LeadResumeDialog key={pending.number} pending={pending} />;
}

export function LeadResumeDialog({ pending }: { pending: PendingLeadResume }) {
    const t = useT();
    const resumeRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        resumeRef.current?.focus();
    }, []);
    const vars = { number: pending.number, name: pending.name, agent: pending.agent, folder: pending.folder };
    return (
        <DialogFrame
            role="lead-resume"
            onEscape={() => pending.answer(null)}
            title={t("reviews.lead.dialog.title", vars)}
            subtitle={t("reviews.lead.dialog.subtitle", vars)}
            widthClass="w-[500px]"
            trapFocus
            buttons={
                <>
                    <button
                        type="button"
                        className={PlainButton}
                        onClick={() => pending.answer(null)}
                        data-testid="lead-resume-cancel"
                    >
                        {t("common.cancel")}
                    </button>
                    <button
                        type="button"
                        className={PlainButton}
                        onClick={() => pending.answer("new")}
                        data-testid="lead-resume-new"
                    >
                        {t("reviews.lead.dialog.newAgent")}
                    </button>
                    <button
                        ref={resumeRef}
                        type="button"
                        className="molten-btn cursor-pointer rounded-4 px-3 py-1 text-12"
                        onClick={() => pending.answer("resume")}
                        data-testid="lead-resume-start"
                    >
                        {t("reviews.lead.dialog.resume", vars)}
                        <MoltenWave />
                    </button>
                </>
            }
        >
            <div className="flex flex-col gap-3 text-12 leading-5" data-testid="lead-resume">
                <p className="text-secondary">{t("reviews.lead.dialog.what", vars)}</p>
                {pending.guessed ? (
                    <p className="text-muted" data-testid="lead-resume-guessed">
                        {t("reviews.lead.dialog.guessed", vars)}
                    </p>
                ) : null}
                <p className="text-muted">{t("reviews.lead.dialog.then", vars)}</p>
            </div>
        </DialogFrame>
    );
}
