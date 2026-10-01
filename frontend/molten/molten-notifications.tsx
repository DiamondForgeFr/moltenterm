// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Wave has no in-app notification stack, only blocking modals. The mod host mounts its own React root so that
// reporting a failed mod never patches Wave's layout.

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { createRoot } from "react-dom/client";
import type { MoltenHost, MoltenNotificationEntry } from "./molten-host";
import { MoltenTrustDialog } from "./molten-trust";

const KindBorder: Record<MoltenNotificationEntry["kind"], string> = {
    info: "border-l-accent",
    success: "border-l-success",
    warning: "border-l-warning",
    error: "border-l-error",
};

function MoltenNotificationCard({ host, entry }: { host: MoltenHost; entry: MoltenNotificationEntry }) {
    return (
        <div
            role={entry.kind === "error" ? "alert" : "status"}
            className={cn(
                "pointer-events-auto flex w-[360px] max-w-[calc(100vw-32px)] items-start gap-2 rounded border border-border border-l-4 bg-modalbg px-3 py-2 text-sm text-primary shadow-lg",
                KindBorder[entry.kind]
            )}
        >
            <div className="min-w-0 flex-1">
                <div className="font-semibold break-words">{entry.title}</div>
                {entry.message ? (
                    <div className="mt-1 whitespace-pre-wrap break-words text-secondary">{entry.message}</div>
                ) : null}
            </div>
            <button
                type="button"
                aria-label="Close"
                className="cursor-pointer rounded px-1 text-secondary hover:bg-hover hover:text-primary"
                onClick={() => host.dismissNotification(entry.id)}
            >
                <i className="fa fa-solid fa-xmark" />
            </button>
        </div>
    );
}

export function MoltenNotifications({ host }: { host: MoltenHost }) {
    const notifications = useAtomValue(host.notificationsAtom, { store: globalStore });
    if (notifications.length === 0) {
        return null;
    }
    return (
        <div className="pointer-events-none fixed right-4 bottom-4 z-[10000] flex flex-col items-end gap-2">
            {notifications.map((entry) => (
                <MoltenNotificationCard key={entry.id} host={host} entry={entry} />
            ))}
        </div>
    );
}

export function mountMoltenNotifications(host: MoltenHost): void {
    const elem = document.createElement("div");
    elem.id = "molten-notifications";
    document.body.appendChild(elem);
    createRoot(elem).render(
        <>
            <MoltenNotifications host={host} />
            <MoltenTrustDialog />
        </>
    );
}
