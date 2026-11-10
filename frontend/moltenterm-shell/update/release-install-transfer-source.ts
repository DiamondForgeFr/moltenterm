// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The in-app update as a source of Brokk's Downloads (#2163): its row is read from the update store's own atoms and its
// actions call the store's own methods, the ones Settings › About's buttons call. Outside a release install the
// installer stays idle and the source has no row.

import { fireAndForget } from "@/util/util";
import { atom } from "jotai";
import { DownloadsModel, DownloadsTransferSource } from "../downloads/downloads-store";
import { openSettingsSection } from "../settings/settings-open";
import { ReleaseTransferAction, releaseTransferOf, ReleaseTransferSource } from "./release-install-transfer";
import { ReleaseUpdateModel } from "./release-update-store";

export function makeReleaseTransferSource(model: ReleaseUpdateModel = ReleaseUpdateModel.getInstance()) {
    const source: DownloadsTransferSource = {
        id: ReleaseTransferSource,
        transfersAtom: atom((get) => {
            const transfer = releaseTransferOf(get(model.installAtom), get(model.offerAtom));
            return transfer == null ? [] : [transfer];
        }),
        act: async (_transferId, actionId) => {
            switch (actionId) {
                case ReleaseTransferAction.cancel:
                    await model.cancel();
                    return;
                case ReleaseTransferAction.restart:
                    await model.apply("now");
                    return;
                case ReleaseTransferAction.openUpdate:
                    fireAndForget(() => openSettingsSection("about"));
                    return;
                case ReleaseTransferAction.reveal:
                    await model.reveal();
                    return;
                case ReleaseTransferAction.retry:
                    await model.install();
                    return;
            }
        },
    };
    return source;
}

export function startReleaseTransfers(): () => void {
    return DownloadsModel.getInstance().registerSource(makeReleaseTransferSource());
}
