// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Settings › About (#1860): the build that runs, where MoltenTerm comes from, and its updates (Check for updates and the
// state of the update in place, FR-REL-005). The About dialog of the application menu says the same of the build; the
// updates live here, where the whole flow can be followed.

import { getApi } from "@/app/store/global";
import { isDev } from "@/util/isdev";
import { moltentermProductNameFor, MoltentermRepoUrl } from "@/util/moltenterm-identity";
import { fireAndForget } from "@/util/util";
import { useMemo } from "react";
import { currentBuildIdentity } from "../build/current-build";
import { useT } from "../i18n/i18n";
import { openWebLink } from "../open-web-link";
import { ReleaseNotesModel } from "../releases/release-notes-store";
import { suiteIcon } from "../suite/suite-icons";
import { ReleaseUpdateCard } from "../update/release-update-ui";
import { PageCard } from "./settings-page";

const WaveTerminalRepoUrl = "https://github.com/wavetermdev/waveterm";
const LinkClass = "cursor-pointer text-accent hover:underline";

// Two blocks, so the page's flow gives each its own gap: a fragment would be one child of the flow.
export function AboutBuildCard() {
    const t = useT();
    const identity = useMemo(() => currentBuildIdentity(getApi().getAboutModalDetails()?.version ?? ""), []);
    const build = typeof __MOLTENTERM_BUILD__ === "undefined" ? null : __MOLTENTERM_BUILD__;
    const name = moltentermProductNameFor(build?.channel, isDev());
    return (
        <PageCard title={name} label={name} hint={t("about.tagline")} icon={suiteIcon("identity")} scope="app">
            <div className="flex flex-col gap-1 px-5 py-3 text-12" data-testid="about-build">
                <button
                    type="button"
                    onClick={() => ReleaseNotesModel.getInstance().open()}
                    title={t("about.releaseNotes")}
                    className={`${LinkClass} self-start text-13 font-medium`}
                >
                    {t("about.version", { version: identity.version || t("about.unknownVersion") })}
                </button>
                <span className="text-muted">{identity.buildLine}</span>
                {identity.commitLine ? (
                    <span className="font-mono text-11 text-muted">{identity.commitLine}</span>
                ) : null}
                <span className="mt-1 text-muted">{t("about.basedOn", { wave: identity.waveBase })}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-12">
                <button type="button" onClick={() => ReleaseNotesModel.getInstance().open()} className={LinkClass}>
                    {t("about.releaseNotes")}
                </button>
                <button
                    type="button"
                    onClick={() => fireAndForget(() => openWebLink(MoltentermRepoUrl))}
                    className={LinkClass}
                >
                    GitHub
                </button>
                <button
                    type="button"
                    onClick={() => fireAndForget(() => openWebLink(WaveTerminalRepoUrl))}
                    className={LinkClass}
                >
                    Wave Terminal
                </button>
            </div>
            <div className="px-5 py-3 text-11 text-muted">
                {t("about.copyright", { year: new Date().getFullYear() })}
            </div>
        </PageCard>
    );
}

export function AboutUpdatesCard() {
    const t = useT();
    return (
        <PageCard
            title={t("settings.about.updates")}
            hint={t("settings.about.updatesHint")}
            icon={suiteIcon("updates")}
            scope="app"
        >
            <ReleaseUpdateCard />
        </PageCard>
    );
}
