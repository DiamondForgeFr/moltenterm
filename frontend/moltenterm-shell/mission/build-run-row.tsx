// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The local build in the overview's "In progress" band (FR-MC-013, #2188), as Notulia's panel was: the build's declared
// phases as a bar with the current one named, what it does, what was delivered or why it stopped; Log, and Cancel while it
// runs, Retry and Close once it failed. A failed build keeps its row and its log open until the developer closes it. It
// loads with the band, when a build runs.

import { fireAndForget } from "@/util/util";
import { useState } from "react";
import { useT } from "../i18n/i18n";
import { serverErrorText } from "../i18n/server-text";
import { MoltenWave } from "../molten-button";
import { DominoLoader } from "../suite/suite";
import { BuildManifest, BuildPhaseDef } from "./builds-model";
import { missionCancel, missionClose } from "./mission-client";
import { RunRecord } from "./mission-model";
import { usePendingLock } from "./pending-action";
import { LogToggle, RowButtonClass, RowCtaClass, RunLogArea, RunRow } from "./run-row";
import { buildBandRow } from "./run-row-model";
import { useRunLog } from "./runs-view";

function BuildRunLog({ run }: { run: RunRecord }) {
    return <RunLogArea log={useRunLog(run)} testId="build-run-log" />;
}

export function BuildRunRow({
    run,
    phases,
    manifest,
    runs,
    trunk,
    now,
    onRetry,
}: {
    run: RunRecord;
    phases: BuildPhaseDef[];
    manifest: BuildManifest;
    runs: readonly RunRecord[];
    trunk: string;
    now: number;
    onRetry?: () => void;
}) {
    const t = useT();
    const [logOpen, setLogOpen] = useState<boolean>(null);
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
    const row = buildBandRow(run, phases, manifest, runs, trunk, now);
    const stopped = run.state !== "running";
    const open = logOpen ?? stopped;
    return (
        <RunRow
            row={row}
            now={now}
            testId="build-run"
            phasesLabel={t("mc.builds.phasesLabel")}
            actions={
                <>
                    <LogToggle open={open} onToggle={() => setLogOpen(!open)} />
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
                            className={RowButtonClass}
                            data-testid="build-run-cancel"
                        >
                            {lock.pending === "cancel" ? <DominoLoader /> : null}
                            {lock.pending === "cancel" ? t("mc.run.cancelling") : t("common.cancel")}
                        </button>
                    ) : null}
                    {stopped && onRetry ? (
                        <button type="button" onClick={onRetry} className={RowCtaClass} data-testid="build-run-retry">
                            {t("mc.run.retry")}
                            <MoltenWave />
                        </button>
                    ) : null}
                    {stopped ? (
                        <button
                            type="button"
                            disabled={locked}
                            aria-busy={lock.pending === "close"}
                            onClick={() =>
                                runLocked("close", async () => {
                                    await missionClose(run.dir, run.id);
                                })
                            }
                            className={RowButtonClass}
                            data-testid="build-run-close"
                        >
                            {lock.pending === "close" ? <DominoLoader /> : null}
                            {lock.pending === "close" ? t("mc.run.closing") : t("common.close")}
                        </button>
                    ) : null}
                </>
            }
            extra={
                error ? (
                    <p className="mt-2 mr-4 text-right text-12 text-danger" role="alert">
                        {error}
                    </p>
                ) : null
            }
        >
            {open ? <BuildRunLog run={run} /> : null}
        </RunRow>
    );
}
