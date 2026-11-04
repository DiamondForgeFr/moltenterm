// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { useT } from "../i18n/i18n";
import { DominoLoader } from "../suite/suite";
import { ageWords, checkedWhen, openReleasePage, ReleaseUpdateModel, UpdateCheckView } from "./release-update-store";

// The status bar's entry for a newer release (#188): it opens the release page, where the files are.
export function ReleaseUpdateButton() {
    const t = useT();
    const model = ReleaseUpdateModel.getInstance();
    const offer = useAtomValue(model.offerAtom, { store: globalStore });
    useEffect(() => model.start(), []);
    if (offer == null) {
        return null;
    }
    return (
        <button
            type="button"
            data-testid="release-update"
            onClick={() => openReleasePage(offer.url)}
            title={t("update.release.buttonTitle", { version: offer.version })}
            className="flex cursor-pointer items-center gap-1 rounded-6 border border-accent/60 px-1.5 leading-[16px] text-primary hover:bg-accent/15"
        >
            <i className="fa fa-solid fa-circle-arrow-up text-11 text-accent" />
            {t("update.release.button", { version: offer.version })}
        </button>
    );
}

// Settings › General › Updates, under "Also get release candidates" (#1806): the version running, the last check, and
// Check for updates now with its answer in place. The answer is also a toast or a notification, wherever the action ran.
export function ReleaseUpdateCheck() {
    const t = useT();
    const model = ReleaseUpdateModel.getInstance();
    const view = useAtomValue(model.checkViewAtom, { store: globalStore });
    const installed = useAtomValue(model.installedAtom, { store: globalStore });
    const lastChecked = useAtomValue(model.lastCheckedAtom, { store: globalStore });
    useEffect(() => model.readLastCheck(), []);
    const now = Date.now();
    const checking = view?.state === "checking";
    return (
        <div className="flex flex-col gap-2 py-2" data-testid="release-update-check">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-col text-12 text-muted">
                    <span data-testid="release-installed-version">
                        {t("update.check.installed", { version: installed })}
                    </span>
                    <span data-testid="release-last-check">
                        {lastChecked > 0
                            ? t("update.check.lastChecked", { when: ageWords(lastChecked, now) })
                            : t("update.check.never")}
                    </span>
                </div>
                <button
                    type="button"
                    data-testid="release-check-now"
                    disabled={checking}
                    onClick={() => model.checkNow()}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-4 border border-line-strong px-3 py-1 text-12 text-primary transition-colors duration-120 ease-mt hover:bg-surface-2 disabled:cursor-default disabled:opacity-60"
                >
                    {checking ? <DominoLoader className="mr-1.5" /> : null}
                    {t("update.check.button")}
                </button>
            </div>
            <ReleaseUpdateStatus view={view} now={now} />
        </div>
    );
}

function ReleaseUpdateStatus({ view, now }: { view: UpdateCheckView; now: number }) {
    const t = useT();
    const model = ReleaseUpdateModel.getInstance();
    if (view == null) {
        return null;
    }
    if (view.state === "checking") {
        return <span className="text-12 text-muted">{t("update.check.checking")}</span>;
    }
    if (view.state === "disabled") {
        return <span className="text-12 text-muted">{t("update.check.disabled")}</span>;
    }
    if (view.state === "error") {
        return (
            <div className="flex items-center gap-2 text-12 text-danger">
                <span data-testid="release-check-error">{t("update.check.error")}</span>
                <button
                    type="button"
                    onClick={() => model.checkNow()}
                    className="cursor-pointer rounded-4 border border-line-strong px-2 py-0.5 text-primary hover:bg-surface-2"
                >
                    {t("update.check.retry")}
                </button>
            </div>
        );
    }
    if (view.state === "available") {
        return (
            <div className="flex items-center gap-2 text-12 text-primary">
                <span data-testid="release-check-available">
                    {t("update.release.title", { version: view.offer.version })}
                </span>
                <button
                    type="button"
                    onClick={() => openReleasePage(view.offer.url)}
                    className="cursor-pointer rounded-4 border border-accent/60 px-2 py-0.5 text-primary hover:bg-accent/15"
                >
                    {t("update.release.download")}
                </button>
            </div>
        );
    }
    return (
        <span data-testid="release-check-latest" className="text-12 text-muted">
            {t("update.check.latest", { version: view.version, checked: checkedWhen(view.checkedat, now) })}
        </span>
    );
}
