// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The notification center (FR-SHELL-002, FR-MC-010, FR-MC-019): what needs the user's attention in every workspace,
// newest first. A notification opens where it comes from, carries up to two actions, shows when its situation is
// resolved, and is settled by acting on it or going to its source (notification-settle.ts, #2026): it then moves to the
// Archived list, as it does when cleared by hand (the ×, Clear all with its undo); the Archived list keeps them until
// cleared for good. What arrives shows as a toast
// (FR-SHELL-055), each subject says only what the user chose, and the work running in every project shows on top. What
// each subject may say is set in Preferences › Notifications, which the center links to (FR-SHELL-106,
// notification-settings.tsx).
//
// The bell is gone (FR-BOSS-009, AC9, #2003): the center is the Notifications panel of Brokk's group (#2032,
// boss/brokk-notes-panel.tsx, which keeps the running work's WorkRow and the failing-row boundary from here), and what the
// bell hosted without drawing (the listeners, the toasts, the approval dialogs) is NotificationHost, mounted with Brokk's
// host. Nothing here opens by itself: a warning, an error or a question is a toast, a row of Brokk's list and, when the
// developer set it to Vient, a visit.

import { createBlock, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { Component, ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AgentHandoffGesture, answerAgentHandoff } from "./agent-handoff";
import { AgentLinksGesture } from "./agent-links/agent-links-model";
import { openAgentLinksGesture } from "./agent-links/agent-links-store";
import { startAgentSeen } from "./agent-seen";
import { BossBubbleModel } from "./boss/boss-store";
import { startDownloads } from "./downloads/downloads-notify";
import { DownloadsModel } from "./downloads/downloads-store";
import { startHandoffSystemNotifications } from "./handoff-system-notify";
import { t as translateNow, useT } from "./i18n/i18n";
import { serverErrorText, serverText } from "./i18n/server-text";
import { DepSyncHost } from "./mission/dep-sync";
import { registerSetupPrGestures } from "./mission/release-setup-gestures";
import { TrustApprovalHost } from "./mission/trust-approval";
import { startNotificationSettling } from "./notification-settle-start";
import { startNotificationToasts } from "./notification-toasts";
import { WorkspaceLabel } from "./notification-workspace";
import { WorkspaceChip } from "./notification-workspace-chip";
import { formatAge } from "./notifications-model";
import { MoltentermNotifications, registerNotificationGesture, startNotificationAutoRead } from "./notifications-store";
import { showProjectTab } from "./project/project-tab";
import { canStop, stopWork, WorkItem } from "./running-work";
import { DominoLoader } from "./suite/suite";
import { ToastStack } from "./toast-stack";
import { Toasts } from "./toast-store";
import { pathParent } from "./workspace-project";

// Actions every window knows; features register their own (the gold update registers "update:review").
function registerBuiltInGestures(): () => void {
    const unregister = [
        registerNotificationGesture("path:reveal", async (args) => {
            if (typeof args.path !== "string" || args.path === "") {
                return { ok: false, error: translateNow("notif.center.noPath") };
            }
            getApi().openNativePath(pathParent(args.path) || args.path);
            return { ok: true };
        }),
        // must match TerminalGesture in pkg/molten/review/trunksync.go
        registerNotificationGesture("path:terminal", async (args) => {
            if (typeof args.path !== "string" || args.path === "") {
                return { ok: false, error: translateNow("notif.center.noPath") };
            }
            await createBlock({ meta: { view: "term", controller: "shell", "cmd:cwd": args.path } });
            return { ok: true };
        }),
        registerNotificationGesture(AgentHandoffGesture, answerAgentHandoff),
        registerNotificationGesture(AgentLinksGesture, openAgentLinksGesture),
        registerSetupPrGestures(),
    ];
    return () => unregister.forEach((fn) => fn());
}

// A row that fails to render is left out instead of breaking the panel.
export class RowBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError() {
        return { failed: true };
    }

    componentDidCatch(error: unknown) {
        console.error("A notification could not be shown:", error);
    }

    render() {
        if (this.state.failed) {
            return (
                <div className="border-b border-border px-3 py-2 text-12 text-muted">
                    {translateNow("notif.center.rowFailed")}
                </div>
            );
        }
        return this.props.children;
    }
}

export function WorkRow({ item, label, now }: { item: WorkItem; label: WorkspaceLabel; now: number }) {
    const t = useT();
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState<string>(null);
    const measured = item.progress >= 0;
    const elapsed = item.startedat ? formatAge(item.startedat, now) : "";
    return (
        <div className="border-b border-border px-3 py-2" data-testid="running-work">
            <div className="flex items-center gap-2">
                <DominoLoader className="text-accent" />
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                {measured ? (
                    <span className="text-12 text-muted tabular-nums">{Math.round(item.progress * 100)}%</span>
                ) : null}
                {canStop(item) && !confirming ? (
                    <button
                        type="button"
                        data-testid="running-work-stop"
                        onClick={() => setConfirming(true)}
                        className="cursor-pointer rounded-6 px-1.5 py-0.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                    >
                        {t("notif.work.stop")}
                    </button>
                ) : null}
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-hover">
                <div
                    className={cn("h-full rounded-full bg-accent", !measured && "mt-beat-blink w-1/3")}
                    style={measured ? { width: `${Math.round(item.progress * 100)}%` } : undefined}
                />
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-11 text-muted">
                {label ? (
                    <>
                        <WorkspaceChip
                            label={label}
                            onGo={() => {
                                if (!label.current) {
                                    getApi().switchWorkspace(label.id);
                                    return;
                                }
                                fireAndForget(() => showProjectTab(label.id));
                            }}
                        />
                        {item.detail || elapsed ? <span>·</span> : null}
                    </>
                ) : null}
                {item.detail ? (
                    <span className="min-w-0 truncate">{serverText(item.detailtext, item.detail)}</span>
                ) : null}
                {item.detail && elapsed ? <span>·</span> : null}
                {elapsed ? <span className="shrink-0 tabular-nums">{t("notif.work.started", { elapsed })}</span> : null}
            </div>
            {confirming ? (
                <div className="mt-1.5 flex items-center justify-end gap-2 text-12">
                    <span className="mr-auto text-secondary">
                        {t("notif.work.stopQuestion", { title: item.title })}
                    </span>
                    <button
                        type="button"
                        onClick={() => setConfirming(false)}
                        className="cursor-pointer rounded-6 px-1.5 py-0.5 text-secondary hover:bg-hover hover:text-primary"
                    >
                        {t("notif.work.keepIt")}
                    </button>
                    <button
                        type="button"
                        data-testid="running-work-confirm-stop"
                        onClick={() =>
                            fireAndForget(async () => {
                                try {
                                    await stopWork(item);
                                    setConfirming(false);
                                } catch (e) {
                                    setError(String(e?.message ?? e));
                                }
                            })
                        }
                        className="cursor-pointer rounded-6 border border-error/50 px-1.5 py-0.5 text-danger hover:bg-error/10"
                    >
                        {t("notif.work.stop")}
                    </button>
                </div>
            ) : null}
            {error ? <div className="mt-1 text-12 text-danger">{serverErrorText(error)}</div> : null}
        </div>
    );
}

// Where a toast flies when it times out: Brokk's avatar, where its notification waits (the bell's place before #2003).
const AvatarRef = {
    get current(): HTMLElement {
        return document.querySelector<HTMLElement>("[data-brokk-avatar]");
    },
} as React.RefObject<HTMLElement>;

// What the bell hosted without drawing: the listeners that raise toasts and settle notifications, the dialogs that wait
// on an answer (dependency sync, trust), the toast stack, and the requests of the surfaces that want a section of
// Brokk's panel (a toast's Open, the downloads pill, a notification's View). A request only brings the panel on the
// developer's gesture; the one a notification makes for itself brings nothing unless the panel is open already.
export function NotificationHost() {
    const boss = BossBubbleModel.getInstance();
    const model = MoltentermNotifications.getInstance();
    const downloads = DownloadsModel.getInstance();
    const panelRequest = useAtomValue(model.panelRequestAtom, { store: globalStore });
    const downloadsRequest = useAtomValue(downloads.requestAtom, { store: globalStore });
    useEffect(() => startNotificationAutoRead(), []);
    useEffect(() => startAgentSeen(), []);
    useEffect(() => startNotificationSettling(), []);
    useEffect(() => registerBuiltInGestures(), []);
    useEffect(() => startNotificationToasts(), []);
    useEffect(() => startHandoffSystemNotifications(), []);
    useEffect(() => startDownloads(), []);
    useEffect(() => {
        if (panelRequest != null && panelRequest.ids.length > 0) {
            boss.showInOpenPanel("notifications", panelRequest.ids);
        }
    }, [panelRequest, boss]);
    useEffect(() => {
        if (downloadsRequest == null) {
            return;
        }
        Toasts.getInstance().clearNotificationToasts();
        boss.showPanel("downloads");
    }, [downloadsRequest, boss]);
    return (
        <>
            <DepSyncHost />
            <TrustApprovalHost />
            {/* On the body: the stack's z-index must compete with the dialogs, not with Brokk's layer. */}
            {createPortal(
                <ToastStack onOpenCenter={() => boss.showPanel("notifications")} bellRef={AvatarRef} />,
                document.body
            )}
        </>
    );
}
