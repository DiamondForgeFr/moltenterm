// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The in-app update's download as Brokk's Downloads shows it (FR-REL-005, FR-BOSS-009 AC62, #2163): one tracked transfer
// drawn from the installer's state, read through the same card view as Settings › About, so the two never disagree.
// Its actions are the update's own, never a file's: no Open and no Delete of what the app holds.

import type { TrackedTransfer, TransferAction } from "../downloads/tracked-transfer";
import { ReleaseOffer } from "./release-feed";
import { ReleaseInstallState } from "./release-install";
import { releaseCardView } from "./release-install-view";

export const ReleaseTransferSource = "release";
export const ReleaseTransferAction = {
    cancel: "cancel",
    restart: "restart",
    openUpdate: "openupdate",
    reveal: "reveal",
    retry: "retry",
} as const;

function action(id: string, key: string, extra?: Partial<TransferAction>): TransferAction {
    return { id, label: { key }, ...extra };
}

// The row of the update, or null when nothing is downloading, staged or failed.
export function releaseTransferOf(install: ReleaseInstallState, offer: ReleaseOffer): TrackedTransfer {
    const view = releaseCardView(null, install, null, offer);
    const base = {
        id: `${ReleaseTransferSource}:${install?.tag ?? ""}`,
        origin: { key: "downloads.update.origin" },
        icon: "arrows-rotate",
    };
    switch (view.kind) {
        case "downloading":
            return {
                ...base,
                title: { key: "downloads.update.title", vars: { version: view.version } },
                phase: "running",
                received: view.percent ?? 0,
                total: view.percent != null ? 100 : 0,
                actions: [action(ReleaseTransferAction.cancel, "downloads.action.cancel")],
            };
        case "verifying":
            return {
                ...base,
                title: { key: "downloads.update.title", vars: { version: view.version } },
                phase: "verifying",
                received: 0,
                total: 0,
                status: { key: "downloads.update.verifying" },
                actions: [],
            };
        case "readySwap":
            return {
                ...base,
                title: { key: "downloads.update.title", vars: { version: view.version } },
                phase: "done",
                received: 100,
                total: 100,
                status: { key: "downloads.update.readySwap" },
                actions: [
                    action(ReleaseTransferAction.restart, "update.install.restart", { main: true }),
                    action(ReleaseTransferAction.openUpdate, "downloads.update.openUpdate", { leaves: true }),
                ],
            };
        case "readyDownload":
            return {
                ...base,
                title: { key: "downloads.update.title", vars: { version: view.version } },
                phase: "done",
                received: 100,
                total: 100,
                status: { key: "downloads.update.readyDownload" },
                actions: [action(ReleaseTransferAction.reveal, "update.install.showInFolder", { main: true })],
            };
        case "failed":
            return {
                ...base,
                title: { key: "downloads.update.title", vars: { version: view.version } },
                phase: "failed",
                received: 0,
                total: 0,
                failed: true,
                status: { key: `update.install.error.${view.error?.kind ?? "unsupported"}` },
                actions:
                    view.retry && view.offer != null
                        ? [action(ReleaseTransferAction.retry, "update.check.retry", { main: true })]
                        : [],
            };
    }
    return null;
}
