// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Check the agents (#954, FR-REV-022 AC8): on the developer's click only, the agent on each listed PR with something
// left (conflicts, red CI, requested changes, no test report) is asked to verify the PR against its ticket and finish
// it; the others are skipped and a busy agent is left alone. The PRs whose agent is gone wait for one confirmation
// before a new agent starts on each, out of sight. A line reports the count, and each row's agent line then follows its
// task (working, done, stuck). The button sits on the heading of the "Agents on it" section (#1061), its report and
// offer under that heading.

import { fireAndForget } from "@/util/util";
import { useState } from "react";
import { useT, useTCount } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { DominoLoader } from "../suite/suite";
import type { ReviewPr } from "./reviews-model";
import { ReviewsModel } from "./reviews-store";
import { CheckReport, checkReportText } from "./reviews-task-model";

const PlainButton =
    "flex shrink-0 cursor-pointer items-center gap-1.5 rounded-4 border border-border px-1.5 py-0.5 text-11 leading-4 font-normal text-secondary hover:bg-hover hover:text-primary";

export type CheckAgents = {
    busy: boolean;
    report: CheckReport;
    check: () => void;
    start: () => void;
    skip: () => void;
};

export function useCheckAgents(dir: string, repo: string, prs: ReviewPr[]): CheckAgents {
    const [busy, setBusy] = useState(false);
    const [report, setReport] = useState<CheckReport>(null);
    const model = ReviewsModel.getInstance();
    const run = (fn: () => Promise<CheckReport>) => {
        if (busy) {
            return;
        }
        setBusy(true);
        fireAndForget(async () => {
            try {
                setReport(await fn());
            } finally {
                setBusy(false);
            }
        });
    };
    return {
        busy,
        report,
        check: () => run(() => model.checkAgents(dir, repo, prs)),
        start: () => run(() => model.startOffers(dir, repo, report)),
        skip: () => setReport(report == null ? null : { ...report, offers: [] }),
    };
}

export function CheckAgentsButton({ check }: { check: CheckAgents }) {
    const t = useT();
    return (
        <button
            type="button"
            onClick={check.check}
            onKeyDown={(e) => e.stopPropagation()}
            aria-busy={check.busy || undefined}
            className={PlainButton}
            title={t("reviews.check.buttonTitle")}
            data-testid="reviews-check-button"
        >
            {check.busy ? <DominoLoader /> : <i className="fa fa-solid fa-list-check text-10" aria-hidden />}
            {check.busy ? t("reviews.check.checking") : t("reviews.check.button")}
        </button>
    );
}

export function CheckAgentsReport({ check }: { check: CheckAgents }) {
    const t = useT();
    const tCount = useTCount();
    const report = check.report;
    if (report == null) {
        return null;
    }
    const offers = report.offers ?? [];
    return (
        <div className="flex flex-col gap-1.5" data-testid="reviews-check">
            <span className="min-w-0 text-11 text-muted" role="status" data-testid="reviews-check-report">
                {checkReportText(tCount, report)}
            </span>
            {offers.length > 0 ? (
                <div
                    className="flex flex-wrap items-center gap-2 rounded-4 border border-warning/40 bg-warning/10 px-2 py-1.5 text-12"
                    data-testid="reviews-check-offers"
                >
                    <span className="min-w-0 grow">
                        {t("reviews.check.offers", { list: offers.map((pr) => `#${pr.number}`).join(", ") })}
                    </span>
                    <button
                        type="button"
                        onClick={check.start}
                        className="molten-btn cursor-pointer rounded-4 px-2 py-0.5 text-11"
                        data-testid="reviews-check-start"
                    >
                        {tCount("reviews.check.start", offers.length)}
                        <MoltenWave />
                    </button>
                    <button type="button" onClick={check.skip} className={PlainButton} data-testid="reviews-check-skip">
                        {t("reviews.check.notNow")}
                    </button>
                </div>
            ) : null}
        </div>
    );
}
