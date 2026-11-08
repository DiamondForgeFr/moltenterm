// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Preferences › Browser › Downloads (FR-MC-019 AC12, #1992): where downloads are saved. They go straight to the
// system's Downloads folder; the "Always ask where to save" setting (browser:downloadask, shown as an ordinary row of
// this section) asks first, in the engine's own save dialog. This card shows the folder and takes the developer to it.

import { globalStore } from "@/app/store/jotaiStore";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useT } from "../i18n/i18n";
import { PageCard, PageRowClass } from "../settings/settings-page";
import { suiteIcon } from "../suite/suite-icons";
import { DownloadsModel } from "./downloads-store";

export function DownloadsFolderCard() {
    const t = useT();
    const model = DownloadsModel.getInstance();
    const snapshot = useAtomValue(model.snapshotAtom, { store: globalStore });
    return (
        <PageCard title={t("downloads.settings.folderTitle")} icon={suiteIcon("folder")} scope="app">
            <div className={PageRowClass} data-testid="downloads-folder-card">
                <div className="min-w-0 flex-1">
                    <div className="text-12 font-medium text-primary">{t("downloads.settings.folderLabel")}</div>
                    <div
                        className="truncate font-mono text-11 text-muted"
                        title={snapshot.folder}
                        data-testid="downloads-folder-path"
                    >
                        {snapshot.folder || t("downloads.settings.folderUnknown")}
                    </div>
                    <div className="text-12 text-muted">
                        {snapshot.askWhere ? t("downloads.settings.askOn") : t("downloads.settings.askOff")}
                    </div>
                </div>
                <button
                    type="button"
                    className="cursor-pointer rounded-6 border border-border px-2 py-0.5 text-12 text-primary hover:bg-hover"
                    data-testid="downloads-folder-open"
                    onClick={() => fireAndForget(() => model.act({ action: "openfolder" }))}
                >
                    {t("downloads.action.reveal")}
                </button>
            </div>
        </PageCard>
    );
}
