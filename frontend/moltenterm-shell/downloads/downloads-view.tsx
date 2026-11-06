// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Downloads section (FR-MC-019 AC7-AC13, #1992): the downloads in progress first, then the history by day. It reads
// the DownloadsModel and draws; the bell's tab and Brokk's tab only host it, so a surface can move without touching
// the model, the main process or the notifications.

import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useEffect, useRef, useState } from "react";
import { useLocale, useT, useTCount } from "../i18n/i18n";
import { formatAge } from "../notifications-model";
import { TabActivity, whileShown } from "../tab-activity";
import { formatSize, reasonText, runningStats } from "./downloads-format";
import { DownloadRecord, extensionOf, groupDownloads, isActive, percentOf, rowActions } from "./downloads-model";
import { OriginState } from "./downloads-origin-model";
import { DownloadsModel } from "./downloads-store";

const AgeTickMs = 30000;

const MainActionClass =
    "cursor-pointer rounded-6 border border-border px-2 py-0.5 text-12 text-primary hover:bg-hover disabled:cursor-default disabled:opacity-50";
const OtherActionClass =
    "cursor-pointer rounded-6 px-2 py-0.5 text-12 text-secondary hover:bg-hover hover:text-primary disabled:cursor-default disabled:opacity-50";
const IconActionClass =
    "flex h-6 w-6 cursor-pointer items-center justify-center rounded-6 text-secondary hover:bg-hover hover:text-primary";

// The request already shown, so a request made before the section mounted (the notification's View) is honoured once.
let handledRequest = 0;

function iconFor(record: DownloadRecord): string {
    const ext = extensionOf(record.name);
    if (record.executable) {
        return "terminal";
    }
    if (["zip", "gz", "tgz", "tar", "7z", "rar", "bz2", "xz"].includes(ext)) {
        return "file-zipper";
    }
    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "heic", "avif"].includes(ext)) {
        return "image";
    }
    if (["iso", "img", "dmg"].includes(ext)) {
        return "compact-disc";
    }
    if (ext === "pdf") {
        return "file-pdf";
    }
    return "file";
}

function ProgressBar({ record }: { record: DownloadRecord }) {
    const t = useT();
    const percent = percentOf(record);
    const failed = record.state === "interrupted";
    return (
        <div
            role="progressbar"
            aria-label={t("downloads.row.progress")}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            className="mt-2 h-1 overflow-hidden rounded-full bg-hover"
            data-testid="download-progress"
        >
            <div
                className={cn(
                    "h-full rounded-full",
                    failed ? "bg-error" : "bg-accent",
                    percent == null && "mt-beat-blink w-1/3",
                    record.state === "paused" && "opacity-50"
                )}
                style={percent == null ? undefined : { width: `${percent}%` }}
            />
        </div>
    );
}

// What a row says of where the download came from, and the call to action that leads back (#1992): to the page while
// it is open, to the view when only the page is closed, and to the page again, in the origin workspace, otherwise.
function OriginLine({
    record,
    origin,
    onFollow,
}: {
    record: DownloadRecord;
    origin: OriginState;
    onFollow: (how: "page" | "reopen" | "view") => void;
}) {
    const t = useT();
    const site = record.host;
    const name = record.pageTitle || site;
    const workspace = origin?.otherWorkspace
        ? t("downloads.origin.inWorkspace", { workspace: origin.workspaceName })
        : "";
    let text: string;
    switch (origin?.kind) {
        case "pageclosed":
            text = [t("downloads.origin.pageClosed", { name }), workspace].filter(Boolean).join(" · ");
            break;
        case "viewclosed":
            text = [t("downloads.origin.viewClosed", { name }), workspace].filter(Boolean).join(" · ");
            break;
        case "workspacegone":
            text = t("downloads.origin.workspaceGone");
            break;
        default:
            text = [
                site,
                origin?.kind === "page" && origin.viewName
                    ? t("downloads.origin.inView", { view: origin.viewName })
                    : "",
                workspace,
            ]
                .filter(Boolean)
                .join(" · ");
    }
    const reopenLabel = origin?.otherWorkspace
        ? t("downloads.origin.reopenIn", { workspace: origin.workspaceName })
        : t("downloads.origin.reopen");
    return (
        <div
            className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-11 text-muted"
            data-testid="download-origin"
            data-origin={origin?.kind ?? "unknown"}
        >
            <span className="inline-flex min-w-0 items-center gap-1">
                <i className={cn(makeIconClass("globe", true), "text-10")} aria-hidden />
                <span className="min-w-0 truncate" title={record.pageUrl || record.url}>
                    {text}
                </span>
            </span>
            {origin?.cta === "goto" ? (
                <button
                    type="button"
                    className={OtherActionClass}
                    data-testid="download-goto"
                    onClick={() => onFollow("page")}
                >
                    <i className={cn(makeIconClass("arrow-up-right-from-square", true), "mr-1 text-10")} aria-hidden />
                    {t("downloads.origin.goTo")}
                </button>
            ) : null}
            {origin?.cta === "reopen" ? (
                <button
                    type="button"
                    className={OtherActionClass}
                    data-testid="download-reopen"
                    title={t("downloads.origin.reopenTitle", { workspace: origin.workspaceName })}
                    onClick={() => onFollow("reopen")}
                >
                    <i className={cn(makeIconClass("rotate-right", true), "mr-1 text-10")} aria-hidden />
                    {reopenLabel}
                </button>
            ) : null}
            {origin?.toView ? (
                <button
                    type="button"
                    className={OtherActionClass}
                    data-testid="download-toview"
                    onClick={() => onFollow("view")}
                >
                    {t("downloads.origin.toView")}
                </button>
            ) : null}
        </div>
    );
}

type RowProps = {
    record: DownloadRecord;
    origin: OriginState;
    error: string;
    now: number;
    highlighted: boolean;
    confirming: boolean;
    onConfirming: (confirming: boolean) => void;
    onLeave: () => void;
};

export const DownloadRow = memo(function DownloadRow({
    record,
    origin,
    error,
    now,
    highlighted,
    confirming,
    onConfirming,
    onLeave,
}: RowProps) {
    const t = useT();
    const model = DownloadsModel.getInstance();
    const actions = rowActions(record);
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);
    const rowRef = useRef<HTMLLIElement>(null);
    useEffect(() => {
        if (highlighted) {
            rowRef.current?.scrollIntoView({ block: "nearest" });
        }
    }, [highlighted]);
    const act = (action: "pause" | "resume" | "cancel" | "retry" | "remove" | "reveal") =>
        fireAndForget(async () => {
            model.clearError(record.id);
            await model.act({ id: record.id, action });
        });
    const open = () =>
        fireAndForget(async () => {
            model.clearError(record.id);
            const result = await model.act({ id: record.id, action: "open" });
            if (!result.ok && result.error === "executable") {
                onConfirming(true);
            }
        });
    const openAnyway = () =>
        fireAndForget(async () => {
            onConfirming(false);
            await model.act({ id: record.id, action: "open", confirmed: true });
        });
    const follow = (how: "page" | "reopen" | "view") => {
        if (busy) {
            return;
        }
        setBusy(true);
        fireAndForget(async () => {
            try {
                if (await model.followOrigin(record.id, how)) {
                    onLeave();
                }
            } finally {
                setBusy(false);
            }
        });
    };
    const copy = () => {
        fireAndForget(async () => {
            await navigator.clipboard.writeText(record.url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        });
    };
    const running = isActive(record);
    const failed = record.state === "interrupted" || record.state === "cancelled";
    const stateChip =
        record.state === "paused"
            ? t("downloads.state.paused")
            : record.state === "interrupted"
              ? t("downloads.state.interrupted")
              : record.state === "cancelled"
                ? t("downloads.state.cancelled")
                : null;
    return (
        <li
            ref={rowRef}
            data-testid="download-row"
            data-download={record.id}
            data-state={record.state}
            data-missing={record.missing ? "true" : "false"}
            className={cn(
                "flex gap-2.5 border-b border-border px-3 py-2.5 last:border-b-0",
                highlighted && "molten-notification-highlight"
            )}
        >
            <span
                className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-4 border text-12",
                    record.executable ? "border-warning/40 text-warning" : "border-border text-secondary",
                    (record.state === "interrupted" || record.missing) && "border-dashed"
                )}
                aria-hidden
            >
                <i className={makeIconClass(iconFor(record), true)} />
            </span>
            <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                    <span
                        className={cn(
                            "min-w-0 flex-1 truncate font-medium",
                            (record.missing || failed) && "text-secondary"
                        )}
                        title={record.name}
                        data-testid="download-name"
                    >
                        {record.name}
                    </span>
                    {stateChip ? (
                        <span
                            className="shrink-0 rounded-4 border border-border px-1.5 text-11 leading-4 text-secondary"
                            data-testid="download-chip"
                        >
                            {stateChip}
                        </span>
                    ) : null}
                    {!running ? (
                        <span className="shrink-0 text-11 text-muted tabular-nums">
                            {formatAge(record.endedAt || record.startedAt, now)}
                        </span>
                    ) : null}
                </div>
                <OriginLine record={record} origin={origin} onFollow={follow} />
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-11 text-muted">
                    {record.agent ? (
                        <span
                            className="inline-flex items-center gap-1 rounded-4 border border-[var(--mt-state-running)] px-1.5 leading-4 text-[var(--mt-state-running)]"
                            data-testid="download-agent"
                        >
                            <i className={cn(makeIconClass("robot", true), "text-10")} aria-hidden />
                            {t("downloads.row.startedBy", { name: record.agent })}
                        </span>
                    ) : null}
                    {record.state === "completed" && record.total > 0 ? <span>{formatSize(record.total)}</span> : null}
                    {record.executable && record.state === "completed" ? (
                        <span
                            className="inline-flex items-center gap-1 rounded-4 border border-warning/45 px-1.5 leading-4 text-warning"
                            data-testid="download-program"
                        >
                            <i className={cn(makeIconClass("triangle-exclamation", true), "text-10")} aria-hidden />
                            {t("downloads.row.program")}
                        </span>
                    ) : null}
                    {record.missing ? (
                        <span
                            className="rounded-4 border border-dashed border-border px-1.5 leading-4"
                            data-testid="download-missing"
                        >
                            {t("downloads.row.missing")}
                        </span>
                    ) : null}
                </div>
                {running || (record.state === "interrupted" && percentOf(record) != null) ? (
                    <ProgressBar record={record} />
                ) : null}
                {running ? (
                    <div className="mt-1 text-11 text-secondary tabular-nums" data-testid="download-stats">
                        {runningStats(record)}
                    </div>
                ) : null}
                {record.state === "interrupted" ? (
                    <div className="mt-1 text-11 text-danger" data-testid="download-reason">
                        {reasonText(record)}
                    </div>
                ) : null}
                {error ? (
                    <div className="mt-1 text-11 text-danger" role="status" data-testid="download-error">
                        {t(`downloads.error.${error}`)}
                    </div>
                ) : null}
                {confirming ? (
                    <div
                        role="alertdialog"
                        aria-label={t("downloads.confirm.aria")}
                        data-testid="download-confirm"
                        className="mt-2 flex gap-2 rounded-4 border border-warning/50 bg-warning/5 px-2.5 py-2 text-12 text-secondary"
                        onKeyDown={(e) => {
                            if (e.key === "Escape") {
                                e.stopPropagation();
                                onConfirming(false);
                            }
                        }}
                    >
                        <i
                            className={cn(makeIconClass("triangle-exclamation", true), "mt-0.5 text-warning")}
                            aria-hidden
                        />
                        <div className="min-w-0">
                            <div className="font-semibold text-primary">
                                {t("downloads.confirm.title", { name: record.name })}
                            </div>
                            <div>{t("downloads.confirm.body", { site: record.host })}</div>
                            <div className="mt-2 flex items-center gap-1.5">
                                <button
                                    type="button"
                                    autoFocus
                                    className={MainActionClass}
                                    data-testid="download-confirm-cancel"
                                    onClick={() => onConfirming(false)}
                                >
                                    {t("downloads.confirm.cancel")}
                                </button>
                                <button
                                    type="button"
                                    className="cursor-pointer rounded-6 border border-warning/60 px-2 py-0.5 text-12 text-warning hover:bg-warning/10"
                                    data-testid="download-confirm-open"
                                    onClick={openAnyway}
                                >
                                    {t("downloads.confirm.open")}
                                </button>
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {actions.pause ? (
                            <button
                                type="button"
                                className={MainActionClass}
                                data-testid="download-pause"
                                onClick={() => act("pause")}
                            >
                                <i className={cn(makeIconClass("pause", true), "mr-1 text-10")} aria-hidden />
                                {t("downloads.action.pause")}
                            </button>
                        ) : null}
                        {actions.resume ? (
                            <button
                                type="button"
                                className={MainActionClass}
                                data-testid="download-resume"
                                onClick={() => act("resume")}
                            >
                                <i className={cn(makeIconClass("play", true), "mr-1 text-10")} aria-hidden />
                                {t("downloads.action.resume")}
                            </button>
                        ) : null}
                        {actions.cancel ? (
                            <button
                                type="button"
                                className={OtherActionClass}
                                data-testid="download-cancel"
                                onClick={() => act("cancel")}
                            >
                                {t("downloads.action.cancel")}
                            </button>
                        ) : null}
                        {actions.retry ? (
                            <button
                                type="button"
                                className={MainActionClass}
                                data-testid="download-retry"
                                onClick={() => act("retry")}
                            >
                                <i className={cn(makeIconClass("rotate-right", true), "mr-1 text-10")} aria-hidden />
                                {t("downloads.action.retry")}
                            </button>
                        ) : null}
                        {actions.redownload ? (
                            <button
                                type="button"
                                className={MainActionClass}
                                data-testid="download-redownload"
                                onClick={() => act("retry")}
                            >
                                <i className={cn(makeIconClass("download", true), "mr-1 text-10")} aria-hidden />
                                {t("downloads.action.redownload")}
                            </button>
                        ) : null}
                        {actions.open ? (
                            <button
                                type="button"
                                className={MainActionClass}
                                data-testid="download-open"
                                onClick={open}
                            >
                                {t("downloads.action.open")}
                            </button>
                        ) : null}
                        {actions.reveal ? (
                            <button
                                type="button"
                                className={OtherActionClass}
                                data-testid="download-reveal"
                                onClick={() => act("reveal")}
                            >
                                {t("downloads.action.reveal")}
                            </button>
                        ) : null}
                        <span className="flex-1" />
                        {actions.copyLink ? (
                            <button
                                type="button"
                                className={IconActionClass}
                                title={copied ? t("downloads.action.copied") : t("downloads.action.copyLink")}
                                aria-label={t("downloads.action.copyLink")}
                                data-testid="download-copy"
                                onClick={copy}
                            >
                                <i className={makeIconClass(copied ? "check" : "link", true)} aria-hidden />
                            </button>
                        ) : null}
                        {actions.remove ? (
                            <button
                                type="button"
                                className={IconActionClass}
                                title={t("downloads.action.remove")}
                                aria-label={t("downloads.action.remove")}
                                data-testid="download-remove"
                                onClick={() => act("remove")}
                            >
                                <i className={makeIconClass("xmark", true)} aria-hidden />
                            </button>
                        ) : null}
                    </div>
                )}
            </div>
        </li>
    );
});

function GroupHeading({ children }: { children: React.ReactNode }) {
    return <div className="px-3 pt-2 text-11 font-medium tracking-wide text-muted uppercase">{children}</div>;
}

// onLeave: an action took the window somewhere else (a download's page), so the surface that hosts the list closes.
export function DownloadsList({ onLeave }: { onLeave?: () => void }) {
    const t = useT();
    const tc = useTCount();
    const locale = useLocale();
    const model = DownloadsModel.getInstance();
    const snapshot = useAtomValue(model.snapshotAtom, { store: globalStore });
    const origins = useAtomValue(model.originsAtom, { store: globalStore });
    const errors = useAtomValue(model.errorsAtom, { store: globalStore });
    const request = useAtomValue(model.requestAtom, { store: globalStore });
    const [now, setNow] = useState(Date.now());
    const [confirmId, setConfirmId] = useState<string>(null);
    const [highlightId, setHighlightId] = useState<string>(null);
    const items = snapshot.items;
    const idsKey = items.map((r) => r.id).join(",");

    useEffect(() => {
        model.setVisible(1);
        fireAndForget(async () => {
            await model.check();
            await model.refreshOrigins();
        });
        const onFocus = () => {
            fireAndForget(async () => {
                await model.check();
                await model.refreshOrigins();
            });
        };
        window.addEventListener("focus", onFocus);
        return () => {
            window.removeEventListener("focus", onFocus);
            model.setVisible(-1);
        };
    }, []);
    useEffect(() => {
        fireAndForget(() => model.refreshOrigins());
    }, [idsKey]);
    useEffect(() => TabActivity.getInstance().every(whileShown(AgeTickMs), () => setNow(Date.now()), "clock"), []);
    useEffect(() => {
        if (request == null || request.seq <= handledRequest) {
            return;
        }
        handledRequest = request.seq;
        if (request.id == null) {
            return;
        }
        setHighlightId(request.id);
        setConfirmId(request.confirm ? request.id : null);
    }, [request]);

    const groups = groupDownloads(items, now);
    const closed = items.filter((r) => !isActive(r)).length;

    if (items.length === 0) {
        return (
            <div className="px-6 py-8 text-center" data-testid="downloads-empty">
                <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full border border-dashed border-border text-secondary">
                    <i className={makeIconClass("download", true)} aria-hidden />
                </div>
                <div className="font-semibold text-primary">{t("downloads.empty.title")}</div>
                <p className="mt-1.5 text-12 text-secondary">{t("downloads.empty.body")}</p>
                <p className="mt-1.5 text-12 text-muted">{t("downloads.empty.noDelete")}</p>
                <button
                    type="button"
                    className={cn(OtherActionClass, "mt-3 inline-flex items-center")}
                    data-testid="downloads-open-folder"
                    onClick={() => fireAndForget(() => model.act({ action: "openfolder" }))}
                >
                    <i className={cn(makeIconClass("folder-open", true), "mr-1.5 text-11")} aria-hidden />
                    {t("downloads.folder.open")}
                </button>
            </div>
        );
    }

    const renderRow = (record: DownloadRecord) => (
        <DownloadRow
            key={record.id}
            record={record}
            origin={origins[record.id]}
            error={errors[record.id]}
            now={now}
            highlighted={highlightId === record.id}
            confirming={confirmId === record.id}
            onConfirming={(confirming) => setConfirmId(confirming ? record.id : null)}
            onLeave={() => onLeave?.()}
        />
    );
    return (
        <div data-testid="downloads-list">
            {groups.running.length > 0 ? (
                <section>
                    <GroupHeading>{tc("downloads.group.running", groups.running.length)}</GroupHeading>
                    <ul>{groups.running.map(renderRow)}</ul>
                </section>
            ) : null}
            {groups.days.map((day) => (
                <section key={day.key}>
                    <GroupHeading>
                        {day.kind === "today"
                            ? t("downloads.day.today")
                            : day.kind === "yesterday"
                              ? t("downloads.day.yesterday")
                              : new Date(day.time).toLocaleDateString(locale, { day: "numeric", month: "long" })}
                    </GroupHeading>
                    <ul>{day.items.map(renderRow)}</ul>
                </section>
            ))}
            <div className="flex items-center gap-2 border-t border-border px-2 py-1.5 text-11 text-muted">
                <button
                    type="button"
                    className={OtherActionClass}
                    disabled={closed === 0}
                    data-testid="downloads-clear"
                    onClick={() => fireAndForget(() => model.clear())}
                >
                    {t("downloads.clear")}
                </button>
                <span className="flex-1" />
                <span>{t("downloads.clearNote")}</span>
            </div>
        </div>
    );
}
