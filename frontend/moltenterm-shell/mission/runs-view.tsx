// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Starting and following a project's declared builds (FR-MC-006, DS-MC-005): the trust prompt the first run of a
// project's commands asks for, the card of a build (phases, last lines of its log, the whole log on demand, cancel,
// open or show its artifact), and the list of recent builds.

import { getApi } from "@/app/store/global";
import { cn, fireAndForget } from "@/util/util";
import { useEffect, useRef, useState } from "react";
import { useRestoreFocus } from "../busy-close";
import { DialogFrame } from "../dialog-frame";
import { useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { MoltenWave } from "../molten-button";
import { DominoLoader } from "../suite/suite";
import { whileShown } from "../tab-activity";
import { everyInPanel, usePanelBlockId } from "../view360/offcarpet-model";
import { pathParent } from "../workspace-project";
import { buildCardTitle, BuildManifest, BuildPhaseDef, BuildPhaseStatus, buildRunView } from "./builds-model";
import { missionBuilds, missionCancel, missionClose, missionLog, missionRun, missionTrust } from "./mission-client";
import { logTail, RunRecord, RunState, RunStateLabels, UntrustedInfo } from "./mission-model";
import { usePendingLock } from "./pending-action";
import { timeAgo } from "./time-format";

const StateClasses: Record<RunState, string> = {
    running: "bg-accent/20 text-primary",
    success: "bg-success/20 text-success",
    failure: "bg-error/20 text-primary",
    cancelled: "bg-hover text-muted",
    lost: "bg-warning/20 text-warning",
};

const PlainButton =
    "cursor-pointer rounded-6 border border-border px-2 py-1 text-12 text-secondary hover:bg-hover hover:text-primary";
const BusyButtonClass = "inline-flex items-center disabled:cursor-default disabled:opacity-50";

export function TrustPrompt({
    projectName,
    dir,
    info,
    onTrust,
    onCancel,
    busy,
    approveOnly,
    bodyKey,
    fill,
}: {
    projectName: string;
    dir: string;
    info: UntrustedInfo;
    onTrust: () => void;
    onCancel: () => void;
    // The trust and the start it allows are on their way (#952): nothing in the prompt can be clicked.
    busy?: boolean;
    // Approve only (#1017): the developer trusts the commands a refused run asked for, and nothing starts.
    approveOnly?: boolean;
    // Says why the commands are asked for, when it is not a refused run (the release setup just wrote them, #1030).
    bodyKey?: string;
    // Takes the whole window, like the release setup it follows (#1047).
    fill?: boolean;
}) {
    const t = useT();
    const cancelRef = useRef<HTMLButtonElement>(null);
    useRestoreFocus();
    // After useRestoreFocus noted where the focus was: autoFocus would come first.
    useEffect(() => {
        cancelRef.current?.focus();
    }, []);
    return (
        <DialogFrame
            role="mc-trust"
            onEscape={busy ? undefined : onCancel}
            title={t(approveOnly ? "mc.trust.approveTitle" : "mc.trust.title", { project: projectName })}
            subtitle={t(bodyKey ?? (approveOnly ? "mc.trust.approveBody" : "mc.trust.body"), { dir })}
            subtitleWraps
            widthClass="w-[560px]"
            fill={fill}
            trapFocus
            onBackdrop={busy ? undefined : onCancel}
            buttons={
                <>
                    <button
                        ref={cancelRef}
                        type="button"
                        onClick={onCancel}
                        disabled={busy}
                        className={cn(PlainButton, "disabled:cursor-default disabled:opacity-50")}
                    >
                        {t("common.cancel")}
                    </button>
                    <button
                        type="button"
                        onClick={onTrust}
                        disabled={busy}
                        aria-busy={busy}
                        className="molten-btn inline-flex cursor-pointer items-center rounded-6 px-3 py-1 text-12 disabled:cursor-default disabled:opacity-50"
                        data-testid="mc-trust-go"
                    >
                        {busy ? <DominoLoader className="mr-1.5" /> : null}
                        {busy
                            ? t(approveOnly ? "mc.trust.trusting" : "mc.common.starting")
                            : t(approveOnly ? "mc.trust.trust" : "mc.trust.trustAndRun")}
                        <MoltenWave />
                    </button>
                </>
            }
        >
            <div>
                {info.commands.map((c) => (
                    <div key={`${c.kind}:${c.id}`} className="border-b border-border py-1.5 last:border-b-0">
                        <div className="text-12">
                            <span className="mr-1.5 rounded-4 bg-hover px-1 text-11 text-muted uppercase">
                                {c.kind}
                            </span>
                            {c.title || c.id}
                        </div>
                        <code className="block text-11 break-all text-secondary">
                            {c.cwd ? `${c.cwd}$ ` : ""}
                            {c.run}
                        </code>
                    </div>
                ))}
            </div>
        </DialogFrame>
    );
}

type PendingRun = { kind: string; id: string; info: UntrustedInfo };

// Starts a declared command; the first time (or after a change) the user reviews and trusts the project's commands.
export function useStartRun(dir: string, projectName: string) {
    const [pending, setPending] = useState<PendingRun>(null);
    const [error, setError] = useState<string>(null);
    // Resolves to the error, if any; an untrusted start opens the trust prompt.
    const startAsync = async (kind: string, id: string): Promise<string> => {
        setError(null);
        try {
            const result = await missionRun(dir, kind, id);
            if (result?.untrusted) {
                setPending({ kind, id, info: result.untrusted });
            }
            return "";
        } catch (e) {
            return serverErrorText(e);
        }
    };
    const start = (kind: string, id: string) =>
        fireAndForget(async () => {
            const failure = await startAsync(kind, id);
            if (failure) {
                setError(failure);
            }
        });
    const trustAndRun = () =>
        fireAndForget(async () => {
            const run = pending;
            setPending(null);
            try {
                await missionTrust(dir, run.info.hash);
                await missionRun(dir, run.kind, run.id);
            } catch (e) {
                setError(serverErrorText(e));
            }
        });
    const prompt =
        pending != null ? (
            <TrustPrompt
                projectName={projectName}
                dir={dir}
                info={pending.info}
                onTrust={trustAndRun}
                onCancel={() => setPending(null)}
            />
        ) : null;
    return { start, startAsync, prompt, error, clearError: () => setError(null) };
}

function openPath(path: string) {
    getApi().openNativePath(path);
}

// The artifact a build produced: opened (an app starts), or shown in the system's file manager through its folder.
export function ArtifactActions({ run }: { run: RunRecord }) {
    const t = useT();
    if (!run.artifact || run.state !== "success") {
        return null;
    }
    return (
        <>
            <button type="button" onClick={() => openPath(run.artifact)} className={PlainButton} title={run.artifact}>
                <i className="fa fa-solid fa-play mr-1 text-11" />
                {t("common.open")}
            </button>
            <button type="button" onClick={() => openPath(pathParent(run.artifact))} className={PlainButton}>
                <i className="fa fa-solid fa-folder-open mr-1 text-11" />
                {t("mc.builds.showInFolder")}
            </button>
        </>
    );
}

// The log of a run, read from where the last read stopped, every second while the run goes on.
export function useRunLog(run: RunRecord): string {
    const [text, setText] = useState("");
    const offset = useRef(0);
    const panelId = usePanelBlockId();
    useEffect(() => {
        setText("");
        offset.current = 0;
    }, [run.id]);
    useEffect(() => {
        let cancelled = false;
        const read = () =>
            fireAndForget(async () => {
                const chunk = await missionLog(run.dir, run.id, offset.current);
                if (cancelled || chunk == null || chunk.size === offset.current) {
                    return;
                }
                offset.current = chunk.size;
                setText((current) => (current + chunk.text).slice(-512 * 1024));
            });
        read();
        if (run.state !== "running") {
            return () => {
                cancelled = true;
            };
        }
        const stop = everyInPanel(panelId, whileShown(1000), read, "run-log");
        return () => {
            cancelled = true;
            stop();
        };
    }, [run.id, run.state, run.logsize, panelId]);
    return text;
}

export function RunStateBadge({ state }: { state: RunState }) {
    return (
        <span className={cn("rounded-4 px-1.5 py-0.5 text-11 font-medium", StateClasses[state])}>
            {state === "running" ? <DominoLoader className="mr-1 text-accent" /> : null}
            {RunStateLabels[state] ?? state}
        </span>
    );
}

const PhaseNodeClasses: Record<BuildPhaseStatus, string> = {
    todo: "border-border bg-transparent text-muted",
    running: "border-accent/70 bg-accent/15 text-accent",
    done: "border-success/60 bg-success/10 text-success",
    failed: "border-error/60 bg-error/10 text-error",
};

function PhaseIcon({ status }: { status: BuildPhaseStatus }) {
    if (status === "done") {
        return <i className="fa fa-solid fa-check text-11" />;
    }
    if (status === "failed") {
        return <i className="fa fa-solid fa-xmark text-11" />;
    }
    if (status === "running") {
        return <DominoLoader className="mt-dominos-node" />;
    }
    return <span className="h-1.5 w-1.5 rounded-full bg-current" />;
}

// The manifest a finished build left, read again once the run ends.
export function useDeliveredManifest(dir: string, run: RunRecord): BuildManifest {
    const [manifest, setManifest] = useState<BuildManifest>(null);
    useEffect(() => {
        setManifest(null);
        if (run == null || run.state !== "success") {
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            const facts = await missionBuilds(dir, false);
            const last = facts?.builds?.find((b) => b.id === run.stepid)?.last ?? null;
            if (!cancelled) {
                setManifest(last);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [dir, run?.id, run?.state]);
    return manifest;
}

// The local build panel (FR-MC-013), as Notulia's: the build's declared phases as a stepper, what the current one does,
// what was delivered or why it stopped, then Show in folder, Retry and Close; Cancel while it runs.
export function BuildRunCard({
    run,
    projectName,
    phases,
    manifest,
    onRetry,
}: {
    run: RunRecord;
    projectName: string;
    phases: BuildPhaseDef[];
    manifest: BuildManifest;
    onRetry?: () => void;
}) {
    const t = useT();
    const log = useRunLog(run);
    const [full, setFull] = useState(false);
    // A cancel holds until the run reads stopped: the process takes a moment to end (#952).
    const lock = usePendingLock(run.state);
    const [error, setError] = useState<string>(null);
    const locked = lock.pending !== "";
    const runLocked = (key: string, fn: () => Promise<boolean | void>) =>
        fireAndForget(async () => {
            setError(null);
            try {
                await lock.run(key, fn);
            } catch (e) {
                setError(serverErrorText(e));
            }
        });
    const view = buildRunView(run, phases, manifest);
    const lines = logTail(log, full ? 2000 : 8);
    const showLines = lines.length > 0 && (view.showLog || full);
    return (
        <section
            className="rounded-6 border border-yellow-500/40 bg-gradient-to-br from-yellow-500/10 to-transparent p-4"
            data-testid="build-run"
            data-state={run.state}
        >
            <div className="mb-3 flex items-center gap-1.5 text-11 font-medium tracking-wide text-muted uppercase">
                <i className="fa fa-solid fa-hammer text-yellow-400" />
                {t("mc.builds.buildLocal")}
                <span className="ml-auto rounded-full border border-border px-2 py-0.5 tracking-normal text-primary normal-case">
                    {buildCardTitle(projectName, { id: run.stepid, title: run.title })}
                </span>
            </div>
            <ol className="flex items-start gap-2" aria-label={t("mc.builds.phasesLabel")}>
                {view.phases.map((p, i) => (
                    <li key={p.id} className="flex flex-1 items-center gap-2 last:flex-none">
                        <div className="flex flex-col items-center gap-1">
                            <span
                                className={cn(
                                    "flex h-7 w-7 items-center justify-center rounded-full border",
                                    PhaseNodeClasses[p.status]
                                )}
                                data-status={p.status}
                            >
                                <PhaseIcon status={p.status} />
                            </span>
                            <span className="text-11 whitespace-nowrap text-muted">{p.title}</span>
                        </div>
                        {i < view.phases.length - 1 ? (
                            <span className="mb-4 h-px flex-1 bg-border" aria-hidden />
                        ) : null}
                    </li>
                ))}
            </ol>
            {view.line ? <p className="mt-3 text-12 text-secondary">{view.line}</p> : null}
            {showLines ? (
                <pre
                    className={cn(
                        "mt-3 overflow-auto rounded-6 border border-border bg-black/30 px-2 py-1.5 font-mono text-11 leading-relaxed whitespace-pre-wrap text-secondary",
                        full ? "max-h-[50vh]" : "max-h-40"
                    )}
                >
                    {lines.join("\n")}
                </pre>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                {run.state === "running" ? (
                    <button
                        type="button"
                        disabled={locked}
                        aria-busy={lock.pending === "cancel"}
                        onClick={() =>
                            runLocked("cancel", async () => {
                                await missionCancel(run.dir, run.id);
                                return true;
                            })
                        }
                        className={cn(PlainButton, BusyButtonClass)}
                        data-testid="build-run-cancel"
                    >
                        {lock.pending === "cancel" ? <DominoLoader className="mr-1.5" /> : null}
                        {lock.pending === "cancel" ? t("mc.run.cancelling") : t("common.cancel")}
                    </button>
                ) : null}
                <button type="button" onClick={() => setFull(!full)} className={cn(PlainButton, "mr-auto")}>
                    {full ? t("mc.run.less") : t("mc.run.wholeLog")}
                </button>
                {view.delivered && run.artifact ? (
                    <button type="button" onClick={() => openPath(pathParent(run.artifact))} className={PlainButton}>
                        <i className="fa fa-solid fa-folder-open mr-1 text-11" />
                        {t("mc.builds.showInFolder")}
                    </button>
                ) : null}
                {run.state !== "running" && run.state !== "success" && onRetry ? (
                    <button
                        type="button"
                        onClick={onRetry}
                        className="molten-btn cursor-pointer rounded-6 px-2 py-1 text-12"
                    >
                        {t("mc.run.retry")}
                        <MoltenWave />
                    </button>
                ) : null}
                {run.state !== "running" ? (
                    <button
                        type="button"
                        disabled={locked}
                        aria-busy={lock.pending === "close"}
                        onClick={() =>
                            runLocked("close", async () => {
                                await missionClose(run.dir, run.id);
                            })
                        }
                        className={cn(PlainButton, BusyButtonClass)}
                        data-testid="build-run-close"
                    >
                        {lock.pending === "close" ? <DominoLoader className="mr-1.5" /> : null}
                        {lock.pending === "close" ? t("mc.run.closing") : t("common.close")}
                    </button>
                ) : null}
            </div>
            {error ? (
                <p className="mt-2 text-right text-12 text-danger" role="alert">
                    {error}
                </p>
            ) : null}
        </section>
    );
}

export function RecentBuilds({ runs }: { runs: RunRecord[] }) {
    const t = useT();
    const builds = (runs ?? []).filter((r) => r.kind === "build").slice(0, 10);
    if (builds.length === 0) {
        return <p className="p-3 text-13 leading-5 text-muted">{t("mc.builds.noLocalBuild")}</p>;
    }
    return (
        <>
            {builds.map((run) => (
                <BuildHistoryRow key={run.id} run={run} />
            ))}
        </>
    );
}

function BuildLog({ run }: { run: RunRecord }) {
    const t = useT();
    const lines = logTail(useRunLog(run), 2000);
    return (
        <pre className="mt-2 max-h-[50vh] overflow-auto rounded-6 border border-border bg-black/30 px-2 py-1.5 font-mono text-11 leading-relaxed whitespace-pre-wrap text-secondary">
            {lines.length === 0 ? t("mc.run.noOutput") : lines.join("\n")}
        </pre>
    );
}

function BuildHistoryRow({ run }: { run: RunRecord }) {
    const t = useT();
    const [log, setLog] = useState(false);
    return (
        <div className="border-b border-border px-3 py-2 last:border-b-0" data-testid="build-history-row">
            <div className="flex flex-wrap items-center gap-2">
                <RunStateBadge state={run.state} />
                <span className="min-w-0 flex-1 truncate text-13 leading-5 text-primary" title={run.command}>
                    {run.title}
                </span>
                {run.commit ? (
                    <code className="text-11 text-muted" title={t("mc.builds.builtFromCommit", { commit: run.commit })}>
                        {run.commit.slice(0, 7)}
                    </code>
                ) : null}
                <span className="text-12 text-muted">{timeAgo(new Date(run.startedat).toISOString())}</span>
                <ArtifactActions run={run} />
                <button type="button" onClick={() => setLog(!log)} className={PlainButton} aria-expanded={log}>
                    {log ? t("mc.run.less") : t("mc.run.log")}
                </button>
            </div>
            {log ? <BuildLog run={run} /> : null}
        </div>
    );
}
