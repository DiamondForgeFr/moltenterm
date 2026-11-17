// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Starting and following a project's declared builds (FR-MC-006, DS-MC-005): the trust prompt the first run of a
// project's commands asks for, the log a run's panels read, and the list of recent builds. The build's row in the
// overview's band is build-run-row.tsx (#2188).

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
import { BuildManifest } from "./builds-model";
import { missionBuilds, missionLog, missionRun, missionTrust } from "./mission-client";
import { logTail, RunRecord, RunState, RunStateLabels, UntrustedInfo } from "./mission-model";
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

// The folder a build was delivered to, in the system's file manager.
export function showBuildInFolder(run: RunRecord) {
    openPath(pathParent(run.artifact));
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
