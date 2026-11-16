// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The version card (FR-BRW-017, #2326): the popover of the address bar's chip on a local tab. Where you are (the
// ticket, its state, the agent, the branch), what to test when a test is asked, the pull request in the Integration
// panel's words, the versions served now with the current one marked, and "Stop this server". It asks wavesrv for the
// served versions when it opens and while it shows; everything else comes from the chip's answer and the Integration
// panel's stores (version-card-model.ts).

import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n/i18n";
import { errorPhrase, joinPhrases, type Phrase, phrase, useWordPhrase } from "../i18n/phrase";
import { MissionRouteId } from "../mission/mission-client";
import { MoltenWave } from "../molten-button";
import { openWebLink } from "../open-web-link";
import { useNewViewHint, usePanelOrigin } from "../panel-cta";
import { useMinuteNow } from "../reviews/reviews-agent-bar";
import { SentenceClasses, ToneMarks } from "../reviews/reviews-card";
import { ReviewsModel } from "../reviews/reviews-store";
import { upcomingGet } from "../reviews/reviews-upcoming-client";
import { useWorkspaceProjectDirs, useWorkspaceReviews } from "../reviews/reviews-workspace";
import { StateMark } from "../state-mark";
import { DominoLoader } from "../suite/suite";
import { TabActivity, whileShown } from "../tab-activity";
import type { DetailRow, TestContextAnswer } from "./test-context-model";
import {
    type PrView,
    ServedStopCommand,
    type ServedStopResult,
    type ServedVersions,
    ServedVersionsCommand,
    stopOutcomePhrase,
    type TestAsk,
    type VersionCardData,
    versionCardData,
    type VersionLine,
} from "./version-card-model";

const ServedVersionsRpcTimeoutMs = 20000;
// A stop reads the port twice (15 s each at most on a busy computer) and waits for the server's grace, then a kill.
const ServedStopRpcTimeoutMs = 60000;
const ServedVersionsPollMs = 5000;
const ServedVersionsUnfocusedPollMs = 15000;

// What the developer ticked on a test's steps, kept while the window lives, by checkout and pull request.
const TickedSteps = new Map<string, Set<number>>();

function askServedVersions(dirs: string[], fresh: boolean): Promise<ServedVersions> {
    return TabRpcClient.wshRpcCall(
        ServedVersionsCommand,
        { workspacedirs: dirs, fresh },
        { route: MissionRouteId, timeout: ServedVersionsRpcTimeoutMs }
    );
}

function stopServed(line: VersionLine): Promise<ServedStopResult> {
    return TabRpcClient.wshRpcCall(
        ServedStopCommand,
        { port: line.server.port, pid: line.server.pid, root: line.version.root },
        { route: MissionRouteId, timeout: ServedStopRpcTimeoutMs }
    );
}

// The versions served now: asked when the card opens and every few seconds while it shows.
function useServedVersions(dirs: string[]): { served: ServedVersions; refresh: () => void } {
    const [served, setServed] = useState<ServedVersions>(null);
    const key = dirs.join("\n");
    const ask = useCallback(
        (fresh: boolean) => {
            fireAndForget(async () => {
                try {
                    setServed(await askServedVersions(key ? key.split("\n") : [], fresh));
                } catch {
                    // wavesrv restarting: the card keeps what it showed.
                }
            });
        },
        [key]
    );
    useEffect(() => {
        ask(true);
        return TabActivity.getInstance().every(
            whileShown(ServedVersionsPollMs, ServedVersionsUnfocusedPollMs),
            (reason) => ask(reason === "resume"),
            "browser-served-versions"
        );
    }, [ask]);
    return { served, refresh: useCallback(() => ask(true), [ask]) };
}

export function VersionCard({
    answer,
    workspaceDir,
    onSwitch,
    onDone,
    onChanged,
}: {
    answer: TestContextAnswer;
    workspaceDir: string;
    onSwitch?: (url: string) => void;
    onDone: () => void;
    onChanged?: () => void;
}) {
    const t = useT();
    const projects = useWorkspaceReviews();
    const dirs = useWorkspaceProjectDirs();
    const asks = useAtomValue(ReviewsModel.getInstance().rebaseAsksAtom);
    const now = useMinuteNow();
    const origin = usePanelOrigin();
    const { served, refresh } = useServedVersions(dirs);
    const lastProject = useRef("");
    const [stopAsk, setStopAsk] = useState<string>(null);
    const [stopping, setStopping] = useState<string>(null);
    const [outcome, setOutcome] = useState<{ text: Phrase; bad: boolean }>(null);
    const data = useMemo(
        () => versionCardData({ answer, served, projects, asks, now, t }, workspaceDir, lastProject.current),
        [answer, served, projects, asks, now, t, workspaceDir]
    );
    if (data.projectKey) {
        lastProject.current = data.projectKey;
    }
    const currentDir = data.mine.find((line) => line.current)?.version.projectdir ?? "";
    const upcomingKnown = projects.find((p) => p.dir === currentDir)?.ctx.upcoming != null;
    useEffect(() => {
        // The agents on the branches come with the upcoming work, which the sidebar asks only while PRs are listed.
        if (currentDir && !upcomingKnown) {
            upcomingGet(currentDir).catch(() => {});
        }
    }, [currentDir, upcomingKnown]);
    const confirmStop = (line: VersionLine) => {
        setStopping(line.key);
        fireAndForget(async () => {
            try {
                const result = await stopServed(line);
                setOutcome({ text: stopOutcomePhrase(result, line), bad: !!result.refused || !!result.still });
            } catch (e) {
                setOutcome({
                    text: joinPhrases([phrase("browser.testContext.stop.failed"), errorPhrase(e)]),
                    bad: true,
                });
            } finally {
                setStopping(null);
                setStopAsk(null);
                refresh();
                onChanged?.();
            }
        });
    };
    return (
        <VersionCardView
            data={data}
            stopAsk={stopAsk}
            stopping={stopping}
            outcome={outcome}
            onSwitch={
                onSwitch == null
                    ? null
                    : (line) => {
                          onDone();
                          onSwitch(line.url);
                      }
            }
            onAskStop={(line) => {
                setOutcome(null);
                setStopAsk(line?.key ?? null);
            }}
            onConfirmStop={confirmStop}
            onOpenReviews={(e, target) => {
                onDone();
                fireAndForget(() =>
                    ReviewsModel.getInstance().openReviews(target.dir, target.number, target.branch, origin(e))
                );
            }}
            onOpenPr={(url) => {
                onDone();
                fireAndForget(() => openWebLink(url));
            }}
        />
    );
}

type ReviewsTarget = { dir: string; number?: number; branch?: string };

export type VersionCardViewProps = {
    data: VersionCardData;
    stopAsk: string;
    stopping: string;
    outcome: { text: Phrase; bad: boolean };
    onSwitch: (line: VersionLine) => void;
    onAskStop: (line: VersionLine) => void;
    onConfirmStop: (line: VersionLine) => void;
    onOpenReviews: (e: React.MouseEvent, target: ReviewsTarget) => void;
    onOpenPr: (url: string) => void;
};

export function VersionCardView(props: VersionCardViewProps) {
    const { data } = props;
    const t = useT();
    const word = useWordPhrase();
    const [othersOpen, setOthersOpen] = useState(false);
    const [detailsOpen, setDetailsOpen] = useState(false);
    return (
        <div className="flex w-[22rem] max-w-full flex-col gap-3 text-12" data-testid="browser-version-card">
            <WhereYouAre data={data} />
            <PrSection {...props} />
            {data.test != null ? <TestSteps test={data.test} stepsKey={data.stepsKey} /> : null}
            <section className="flex flex-col gap-1.5" aria-label={t("browser.testContext.versions.title")}>
                <h4 className="text-11 font-semibold text-muted">
                    {data.projectName
                        ? t("browser.testContext.versions.titleOf", { name: data.projectName })
                        : t("browser.testContext.versions.title")}
                </h4>
                {props.outcome != null ? (
                    <p
                        role="status"
                        className={cn(
                            "text-11 leading-4",
                            props.outcome.bad ? "text-[var(--mt-state-warning)]" : "text-secondary"
                        )}
                        data-testid="browser-version-outcome"
                    >
                        {word(props.outcome.text)}
                    </p>
                ) : null}
                {data.mine.length > 0 ? (
                    <ul className="flex flex-col gap-0.5" data-testid="browser-versions-mine">
                        {data.mine.map((line) => (
                            <VersionRow key={line.key} line={line} {...props} />
                        ))}
                    </ul>
                ) : null}
                {data.versionsUnknown ? (
                    <p className="text-11 leading-4 text-muted">{t("browser.testContext.versions.unreadable")}</p>
                ) : data.known && data.mine.length <= 1 ? (
                    <p className="text-11 leading-4 text-muted">
                        {t("browser.testContext.versions.noOther", { name: data.projectName || data.branch })}
                    </p>
                ) : null}
                {data.others.length > 0 ? (
                    <div className="flex flex-col gap-0.5">
                        <FoldButton
                            open={othersOpen || !data.known}
                            onToggle={() => setOthersOpen(!othersOpen)}
                            label={t("browser.testContext.versions.others", { count: data.others.length })}
                            testId="browser-versions-others-toggle"
                        />
                        {othersOpen || !data.known ? (
                            <ul className="flex flex-col gap-0.5" data-testid="browser-versions-others">
                                {data.others.map((line) => (
                                    <VersionRow key={line.key} line={line} {...props} />
                                ))}
                            </ul>
                        ) : null}
                    </div>
                ) : null}
            </section>
            {data.details.length > 0 ? (
                <section className="flex flex-col gap-1.5">
                    <FoldButton
                        open={detailsOpen}
                        onToggle={() => setDetailsOpen(!detailsOpen)}
                        label={t("browser.testContext.details")}
                        testId="browser-version-details-toggle"
                    />
                    {detailsOpen ? <Details rows={data.details} /> : null}
                </section>
            ) : null}
        </div>
    );
}

// The PR's state mark on the title line: the Integration card's, its dominoes while something works on it, a check
// once merged.
function PrMark({ pr }: { pr: PrView }) {
    if (pr == null) {
        return null;
    }
    if (pr.tone === "merged") {
        return <i className="fa fa-solid fa-check shrink-0 text-11 text-[var(--mt-state-ready)]" aria-hidden />;
    }
    if (pr.working) {
        return (
            <span className="-mx-1 inline-flex shrink-0 scale-75" aria-hidden>
                <DominoLoader />
            </span>
        );
    }
    return <StateMark kind={ToneMarks[pr.tone]} testId="browser-version-mark" />;
}

function WhereYouAre({ data }: { data: VersionCardData }) {
    const t = useT();
    if (!data.known) {
        return (
            <header className="flex flex-col gap-1">
                <h3 className="text-13 font-semibold text-primary">{t("browser.testContext.unknown")}</h3>
                <p className="leading-5 text-secondary">{data.reason}</p>
            </header>
        );
    }
    return (
        <header className="flex flex-col gap-1" data-testid="browser-version-where">
            <div className="flex min-w-0 items-center gap-2">
                <PrMark pr={data.pr} />
                <h3
                    className="min-w-0 text-13 leading-5 font-semibold text-primary [overflow-wrap:anywhere]"
                    data-testid="browser-version-title"
                >
                    {data.title || data.branch}
                    {data.ticket > 0 ? <span className="ml-1.5 font-normal text-muted">#{data.ticket}</span> : null}
                </h3>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-11 text-secondary">
                {data.agents.length > 0 ? (
                    <span
                        className="inline-flex items-center gap-1"
                        title={t("browser.testContext.agentTitle")}
                        data-testid="browser-version-agents"
                    >
                        <i className="fa fa-solid fa-robot text-10 text-muted" aria-hidden />
                        {data.agents.join(", ")}
                    </span>
                ) : null}
                {/* Without a ticket title the branch is the title: said once. */}
                {data.title ? (
                    <span className="inline-flex min-w-0 items-center gap-1 font-mono">
                        <i className="fa fa-solid fa-code-branch text-10 text-muted" aria-hidden />
                        <span className="truncate">{data.branch}</span>
                    </span>
                ) : null}
                {data.dirty ? (
                    <span className="inline-flex items-center gap-1 text-[var(--mt-state-warning)]">
                        <span className="h-1.5 w-1.5 rounded-full bg-[var(--mt-state-warning)]" aria-hidden />
                        {t("browser.testContext.uncommitted")}
                    </span>
                ) : null}
            </div>
        </header>
    );
}

function PrSection({ data, onOpenReviews, onOpenPr }: VersionCardViewProps) {
    const t = useT();
    const hint = useNewViewHint();
    if (!data.known) {
        return null;
    }
    const pr = data.pr;
    const target: ReviewsTarget =
        pr?.reviewsDir != null
            ? { dir: pr.reviewsDir, number: pr.number }
            : data.upcoming != null
              ? { dir: data.upcoming.dir, branch: data.upcoming.branch }
              : null;
    return (
        <section
            className="flex flex-col gap-2 rounded-4 border border-border px-2.5 py-2"
            data-testid="browser-version-pr"
        >
            {pr != null ? (
                <div className="flex min-w-0 items-baseline gap-1.5 leading-4" title={pr.title}>
                    <span className="shrink-0 font-medium text-primary">#{pr.number}</span>
                    <span
                        className={cn(
                            "min-w-0 truncate font-medium",
                            pr.tone === "merged" ? "text-[var(--mt-state-ready)]" : SentenceClasses[pr.tone]
                        )}
                        data-testid="browser-version-pr-state"
                        data-tone={pr.tone}
                    >
                        {pr.sentence}
                        {pr.why ? <span className="font-normal text-secondary"> · {pr.why}</span> : null}
                    </span>
                </div>
            ) : (
                <p className="leading-4 text-secondary">{data.noPr}</p>
            )}
            {data.otherProject ? (
                <p className="text-11 leading-4 text-muted">
                    {t("browser.testContext.otherProject", { name: data.projectName })}
                </p>
            ) : null}
            {/* Stories 2 and 3 of #2325 add Annotate and Approve to this row. */}
            {target != null || pr != null ? (
                <div className="flex flex-wrap items-center gap-2">
                    {target != null ? (
                        <button
                            type="button"
                            className="molten-btn cursor-pointer rounded-4 px-3 py-1.5 text-12"
                            data-testid="browser-test-context-reviews"
                            title={hint(t("browser.testContext.openInReviews"))}
                            onClick={(e) => onOpenReviews(e, target)}
                        >
                            {t("browser.testContext.openInReviews")}
                            <MoltenWave />
                        </button>
                    ) : null}
                    {pr != null ? (
                        <button
                            type="button"
                            className="cursor-pointer rounded-4 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                            onClick={() => onOpenPr(pr.url)}
                        >
                            {t("browser.testContext.openPr")}
                        </button>
                    ) : null}
                </div>
            ) : null}
        </section>
    );
}

function TestSteps({ test, stepsKey }: { test: TestAsk; stepsKey: string }) {
    const t = useT();
    const [ticked, setTicked] = useState<Set<number>>(() => new Set(TickedSteps.get(stepsKey) ?? []));
    const toggle = (i: number) => {
        const next = new Set(ticked);
        if (next.has(i)) {
            next.delete(i);
        } else {
            next.add(i);
        }
        TickedSteps.set(stepsKey, next);
        setTicked(next);
    };
    return (
        <section className="flex flex-col gap-1.5" data-testid="browser-version-test">
            <h4 className="text-11 font-semibold text-muted">{t("browser.testContext.whatToTest")}</h4>
            {test.noSteps ? (
                <p className="leading-4 text-secondary">{t("browser.testContext.testNoSteps")}</p>
            ) : (
                <ul className="flex flex-col gap-1">
                    {test.steps.map((step, i) => (
                        <li key={i}>
                            <label className="flex cursor-pointer items-start gap-2 leading-4 text-primary">
                                <input
                                    type="checkbox"
                                    className="mt-0.5 shrink-0 cursor-pointer accent-[var(--mt-action)]"
                                    checked={ticked.has(i)}
                                    onChange={() => toggle(i)}
                                />
                                <span className={cn("[overflow-wrap:anywhere]", ticked.has(i) && "text-muted")}>
                                    {step}
                                </span>
                            </label>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

function VersionRow({
    line,
    stopAsk,
    stopping,
    onSwitch,
    onAskStop,
    onConfirmStop,
}: { line: VersionLine } & VersionCardViewProps) {
    const t = useT();
    const port = line.server?.port ?? 0;
    const meta = [line.title, line.agents.join(", "), port > 0 ? t("browser.testContext.versions.port", { port }) : ""]
        .filter((part) => part !== "")
        .join(" · ");
    const canOpen = !line.current && onSwitch != null && line.url !== "";
    const asking = stopAsk === line.key;
    const busy = stopping === line.key;
    const body = (
        <>
            <span className="flex min-w-0 items-center gap-1.5 text-primary">
                <span className="truncate font-mono">{line.branch}</span>
                {line.main ? (
                    <span className="shrink-0 rounded-4 border border-border px-1 text-10 text-muted">
                        {t("browser.testContext.versions.main")}
                    </span>
                ) : null}
                {line.dirty ? (
                    <span
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--mt-state-warning)]"
                        title={t("browser.testContext.uncommitted")}
                        aria-label={t("browser.testContext.uncommitted")}
                        role="img"
                    />
                ) : null}
                {line.current ? (
                    <span className="shrink-0 text-11 text-muted">{t("browser.testContext.versions.here")}</span>
                ) : null}
            </span>
            {meta ? <span className="block truncate text-11 text-secondary">{meta}</span> : null}
        </>
    );
    return (
        <li className="flex flex-col gap-1" data-testid="browser-version-row" data-current={line.current || undefined}>
            <div
                className={cn(
                    "flex min-w-0 items-center gap-1 rounded-4 pr-1",
                    line.current && "mt-selected-action bg-hover"
                )}
                aria-current={line.current ? "true" : undefined}
            >
                {canOpen ? (
                    <button
                        type="button"
                        className="min-w-0 flex-1 cursor-pointer rounded-4 px-2 py-1.5 text-left hover:bg-hover"
                        title={t("browser.testContext.versions.openTitle", { branch: line.branch, port })}
                        onClick={() => onSwitch(line)}
                        data-testid="browser-version-open"
                    >
                        {body}
                    </button>
                ) : (
                    <div className="min-w-0 flex-1 px-2 py-1.5">{body}</div>
                )}
                {/* A project linked to no workspace: wavesrv would refuse the stop, so none is offered. */}
                {line.stoppable ? (
                    <button
                        type="button"
                        className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-4 text-muted hover:bg-hover hover:text-primary"
                        title={t("browser.testContext.stop.button")}
                        aria-label={t("browser.testContext.stop.buttonFor", { branch: line.branch })}
                        aria-expanded={asking}
                        disabled={busy}
                        onClick={() => onAskStop(asking ? null : line)}
                        data-testid="browser-version-stop"
                    >
                        <i className="fa fa-solid fa-stop text-10" aria-hidden />
                    </button>
                ) : null}
            </div>
            {asking ? (
                <StopConfirm line={line} busy={busy} onConfirm={onConfirmStop} onCancel={() => onAskStop(null)} />
            ) : null}
        </li>
    );
}

function StopConfirm({
    line,
    busy,
    onConfirm,
    onCancel,
}: {
    line: VersionLine;
    busy: boolean;
    onConfirm: (line: VersionLine) => void;
    onCancel: () => void;
}) {
    const t = useT();
    const cancelRef = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        cancelRef.current?.focus();
    }, []);
    return (
        <div
            role="group"
            className="mx-2 flex flex-col gap-2 rounded-4 border border-border bg-surface-2 px-2.5 py-2"
            data-testid="browser-version-stop-confirm"
        >
            <p className="leading-4 text-primary">
                {t("browser.testContext.stop.confirm", {
                    process: line.server.process || t("browser.testContext.stop.unknownProcess"),
                    branch: line.branch,
                    port: line.server.port,
                })}
            </p>
            <p className="text-11 leading-4 text-muted">{t("browser.testContext.stop.scope")}</p>
            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    className="molten-btn molten-btn-destructive cursor-pointer rounded-4 px-3 py-1.5 text-12"
                    disabled={busy}
                    onClick={() => onConfirm(line)}
                    data-testid="browser-version-stop-yes"
                >
                    {busy ? t("browser.testContext.stop.stopping") : t("browser.testContext.stop.confirmYes")}
                    <MoltenWave />
                </button>
                <button
                    ref={cancelRef}
                    type="button"
                    className="cursor-pointer rounded-4 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                    disabled={busy}
                    onClick={onCancel}
                >
                    {t("browser.testContext.stop.cancel")}
                </button>
            </div>
        </div>
    );
}

function FoldButton({
    open,
    onToggle,
    label,
    testId,
}: {
    open: boolean;
    onToggle: () => void;
    label: string;
    testId: string;
}) {
    return (
        <button
            type="button"
            className="flex cursor-pointer items-center gap-1.5 self-start rounded-4 px-1 py-0.5 text-11 text-muted hover:text-primary"
            aria-expanded={open}
            onClick={onToggle}
            data-testid={testId}
        >
            <i className={cn("fa fa-solid text-10", open ? "fa-chevron-down" : "fa-chevron-right")} aria-hidden />
            {label}
        </button>
    );
}

function Details({ rows }: { rows: DetailRow[] }) {
    return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-1" data-testid="browser-test-context-details">
            {rows.map((row) => (
                <div key={row.label} className="contents">
                    <dt className="text-muted">{row.label}</dt>
                    <dd
                        className="min-w-0 font-mono [overflow-wrap:anywhere] text-primary"
                        title={row.title ?? row.value}
                    >
                        {row.value}
                    </dd>
                </div>
            ))}
        </dl>
    );
}
