// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Apart from release-update-ui.tsx on purpose: the status bar imports that one, so it sits in the entry chunk every
// window loads up front (NFR-PERF-003), while this card is only read in Settings, which loads on demand.

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { DominoLoader } from "../suite/suite";
import { notesAsText, ReleaseOffer } from "./release-feed";
import { ReleaseInstallError } from "./release-install";
import { releaseCardView } from "./release-install-view";
import { ageWords, checkedWhen, openReleasePage, ReleaseUpdateModel } from "./release-update-store";
import { restartWarning, TerminalSummary } from "./update-model";
import { readTerminals } from "./update-store";

const SecondaryButton =
    "inline-flex cursor-pointer items-center gap-1.5 rounded-4 border border-line-strong px-3 py-1 text-12 text-primary transition-colors duration-120 ease-mt hover:bg-surface-2 disabled:cursor-default disabled:opacity-60";
const CtaButton = "molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12";

// Settings › About › Updates (#1806, #1860): the version running, the last check, Check for updates, and where the
// update stands: offered, downloading, checked, ready to restart, or refused with its reason. The answer is also a
// toast or a notification, wherever the action ran; the installer's state is Electron main's, shown here and in every
// other window.
export function ReleaseUpdateCard() {
    const t = useT();
    const model = ReleaseUpdateModel.getInstance();
    const check = useAtomValue(model.checkViewAtom, { store: globalStore });
    const install = useAtomValue(model.installAtom, { store: globalStore });
    const plan = useAtomValue(model.planAtom, { store: globalStore });
    const offer = useAtomValue(model.offerAtom, { store: globalStore });
    const installed = useAtomValue(model.installedAtom, { store: globalStore });
    const lastChecked = useAtomValue(model.lastCheckedAtom, { store: globalStore });
    useEffect(() => {
        model.readLastCheck();
        return model.follow();
    }, []);
    const now = Date.now();
    const checking = check?.state === "checking";
    const view = releaseCardView(check, install, plan, offer);
    return (
        <div className="flex flex-col gap-3 px-5 py-3" data-testid="release-update-check">
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
                    className={SecondaryButton}
                >
                    {checking ? <DominoLoader className="mr-1.5" /> : null}
                    {t("update.check.button")}
                </button>
            </div>
            <ReleaseCardState view={view} now={now} />
        </div>
    );
}

function Why({ plan }: { plan: { reason?: string } }) {
    const t = useT();
    if (plan?.reason == null) {
        return null;
    }
    return (
        <span className="text-12 text-muted" data-testid="release-why">
            {t(`update.install.why.${plan.reason}`)}
        </span>
    );
}

function ErrorText({ error }: { error: ReleaseInstallError }) {
    const t = useT();
    return (
        <div className="flex flex-col gap-0.5">
            <span data-testid="release-install-error" className="text-12 text-danger">
                {t(`update.install.error.${error?.kind ?? "unsupported"}`)}
            </span>
            {error?.detail ? <span className="font-mono text-11 text-muted">{error.detail}</span> : null}
        </div>
    );
}

function Offered({ offer, mode, reason }: { offer: ReleaseOffer; mode: string; reason?: string }) {
    const t = useT();
    const model = ReleaseUpdateModel.getInstance();
    const notes = notesAsText(offer.notes);
    return (
        <div className="flex flex-col gap-2 text-12 text-primary">
            <span className="font-medium" data-testid="release-check-available">
                {t("update.release.title", { version: offer.version })}
            </span>
            {notes ? <span className="line-clamp-4 text-muted">{notes}</span> : null}
            {mode !== "swap" ? <Why plan={{ reason }} /> : null}
            <div className="flex flex-wrap items-center gap-2">
                {mode === "none" ? (
                    <button
                        type="button"
                        data-testid="release-open-page"
                        onClick={() => openReleasePage(offer.url)}
                        className={cn(CtaButton)}
                    >
                        {t("update.release.download")}
                        <MoltenWave />
                    </button>
                ) : (
                    <>
                        <button
                            type="button"
                            data-testid="release-install"
                            onClick={() => fireAndForget(() => model.install())}
                            className={CtaButton}
                        >
                            {mode === "swap" ? t("update.release.update") : t("update.release.download")}
                            <MoltenWave />
                        </button>
                        <button
                            type="button"
                            data-testid="release-notes"
                            onClick={() => openReleasePage(offer.url)}
                            className={SecondaryButton}
                        >
                            {t("update.release.notes")}
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

function Restart() {
    const t = useT();
    const model = ReleaseUpdateModel.getInstance();
    const [terminals, setTerminals] = useState<TerminalSummary>(null);
    useEffect(() => {
        fireAndForget(async () => setTerminals(await readTerminals()));
    }, []);
    return (
        <div className="flex flex-col gap-2 text-12 text-primary">
            <span data-testid="release-ready">{t("update.install.readyWhen")}</span>
            <span className="text-muted">
                {terminals ? restartWarning(terminals) : <DominoLoader className="mr-1.5" />}
            </span>
            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    data-testid="release-restart"
                    onClick={() => fireAndForget(() => model.apply("now"))}
                    className={CtaButton}
                >
                    {t("update.install.restart")}
                    <MoltenWave />
                </button>
            </div>
        </div>
    );
}

function ReleaseCardState({ view, now }: { view: ReturnType<typeof releaseCardView>; now: number }) {
    const t = useT();
    const model = ReleaseUpdateModel.getInstance();
    const plan = useAtomValue(model.planAtom, { store: globalStore });
    switch (view.kind) {
        case "none":
            return null;
        case "checking":
            return (
                <span className="flex items-center text-12 text-muted" data-testid="release-checking">
                    <DominoLoader className="mr-1.5" />
                    {t("update.check.checking")}
                </span>
            );
        case "disabled":
            return <span className="text-12 text-muted">{t("update.check.disabled")}</span>;
        case "checkError":
            return (
                <div className="flex items-center gap-2 text-12 text-danger">
                    <span data-testid="release-check-error">{t("update.check.error")}</span>
                    <button type="button" onClick={() => model.checkNow()} className={SecondaryButton}>
                        {t("update.check.retry")}
                    </button>
                </div>
            );
        case "latest":
            return (
                <span data-testid="release-check-latest" className="text-12 text-muted">
                    {t("update.check.latest", { version: view.version, checked: checkedWhen(view.checkedat, now) })}
                </span>
            );
        case "available":
            return <Offered offer={view.offer} mode={view.plan?.mode ?? "none"} reason={view.plan?.reason} />;
        case "downloading":
            return (
                <div className="flex flex-col gap-1.5 text-12 text-primary" data-testid="release-downloading">
                    <span className="flex items-center">
                        <DominoLoader className="mr-1.5" />
                        {t("update.install.downloading", { version: view.version })}
                        {view.percent != null ? (
                            <span className="ml-2 text-muted">
                                {t("update.install.percent", { percent: view.percent })}
                            </span>
                        ) : null}
                    </span>
                    {view.percent != null ? (
                        <div
                            role="progressbar"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={view.percent}
                            className="h-1 w-full overflow-hidden rounded-full bg-surface-2"
                        >
                            <div
                                className="h-full bg-accent transition-[width] duration-120 ease-mt"
                                style={{ width: `${view.percent}%` }}
                            />
                        </div>
                    ) : null}
                    <div>
                        <button
                            type="button"
                            data-testid="release-cancel"
                            onClick={() => fireAndForget(() => model.cancel())}
                            className={SecondaryButton}
                        >
                            {t("update.install.cancel")}
                        </button>
                    </div>
                </div>
            );
        case "verifying":
            return (
                <span className="flex items-center text-12 text-primary" data-testid="release-verifying">
                    <DominoLoader className="mr-1.5" />
                    {t("update.install.verifying", { version: view.version })}
                </span>
            );
        case "readySwap":
            return (
                <div className="flex flex-col gap-1.5" data-testid="release-ready-swap">
                    <span className="text-12 font-medium text-primary">
                        {t("update.install.ready", { version: view.version })}
                    </span>
                    <Restart />
                </div>
            );
        case "readyDownload":
            return (
                <div className="flex flex-col gap-2 text-12 text-primary" data-testid="release-ready-download">
                    <span>{t("update.install.downloaded", { version: view.version })}</span>
                    <Why plan={{ reason: plan?.reason }} />
                    <span className="break-all font-mono text-11 text-muted">{view.file}</span>
                    <div>
                        <button
                            type="button"
                            onClick={() => fireAndForget(() => model.reveal())}
                            className={SecondaryButton}
                        >
                            {t("update.install.showInFolder")}
                        </button>
                    </div>
                </div>
            );
        case "failed":
            return (
                <div className="flex flex-col gap-2" data-testid="release-failed">
                    <span className="text-12 font-medium text-primary">
                        {t("update.install.failed", { version: view.version })}
                    </span>
                    <ErrorText error={view.error} />
                    <div className="flex flex-wrap items-center gap-2">
                        {view.retry && view.offer != null ? (
                            <button
                                type="button"
                                data-testid="release-retry"
                                onClick={() => fireAndForget(() => model.install())}
                                className={SecondaryButton}
                            >
                                {t("update.check.retry")}
                            </button>
                        ) : null}
                        {view.offer != null ? (
                            <button
                                type="button"
                                data-testid="release-failed-page"
                                onClick={() => openReleasePage(view.offer.url)}
                                className={SecondaryButton}
                            >
                                {t("update.install.releasePage")}
                            </button>
                        ) : null}
                    </div>
                </div>
            );
    }
}
