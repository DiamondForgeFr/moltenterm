// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The test context chip at the start of the browser's address bar (FR-BRW-017, #962): on a local tab, the branch and
// PR the page is served from, with the details and "Open in Reviews" in a popover opened by a click. It asks wavesrv
// when the tab's server changes, while the tab is shown, and when git changes the served tree; wavesrv answers from
// local reads and the collector's cache, never a gh call.

import { atoms } from "@/app/store/global";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/i18n";
import { checkIconState, CiIcon } from "../mission/ci-icon";
import type { CheckState } from "../mission/github";
import { MenuPopover } from "../mission/menu-popover";
import { MissionRouteId, MissionUpdateEvent } from "../mission/mission-client";
import { MoltenWave } from "../molten-button";
import { openWebLink } from "../open-web-link";
import { MissionPaneEvent } from "../pane-status";
import { LaunchEvent } from "../reviews/reviews-launch-client";
import type { LaunchState } from "../reviews/reviews-launch-model";
import { ReviewsModel } from "../reviews/reviews-store";
import { TabActivity, whileShown } from "../tab-activity";
import { isShowing } from "../tab-activity-model";
import { readWorkspaceProject } from "../workspace-project";
import {
    ChipTone,
    chipView,
    detailRows,
    launchServesTarget,
    localAppTarget,
    prStateText,
    reasonText,
    reviewsTarget,
    targetKey,
    TestContextAnswer,
    TestContextCommand,
} from "./test-context-model";

const TestContextRpcTimeoutMs = 15000;
const TestContextPollMs = 5000;
const TestContextUnfocusedPollMs = 15000;

const ToneClasses: Record<ChipTone, string> = {
    pr: "text-secondary",
    future: "text-secondary",
    branch: "text-secondary",
    unknown: "text-muted",
};

const ToneGlyph: Record<ChipTone, string> = {
    pr: "fa-code-pull-request",
    future: "fa-code-branch",
    branch: "fa-code-branch",
    unknown: "fa-circle-question",
};

function askTestContext(url: string, workspaceDir: string, fresh: boolean): Promise<TestContextAnswer> {
    return TabRpcClient.wshRpcCall(
        TestContextCommand,
        { url, workspacedir: workspaceDir || undefined, fresh },
        { route: MissionRouteId, timeout: TestContextRpcTimeoutMs }
    );
}

export function useTestContext(url: string, workspaceDir: string): TestContextAnswer {
    const key = targetKey(localAppTarget(url));
    const [answer, setAnswer] = useState<{ key: string; value: TestContextAnswer }>(null);
    const keyRef = useRef(key);
    keyRef.current = key;
    const urlRef = useRef(url);
    urlRef.current = url;
    const ask = useCallback(
        (fresh: boolean) => {
            if (!key) {
                return;
            }
            fireAndForget(async () => {
                try {
                    const value = await askTestContext(urlRef.current, workspaceDir, fresh);
                    if (keyRef.current === key) {
                        setAnswer({ key, value });
                    }
                } catch {
                    // wavesrv restarting: the chip keeps what it showed.
                }
            });
        },
        [key, workspaceDir]
    );
    useEffect(() => {
        if (!key) {
            return;
        }
        ask(true);
        return TabActivity.getInstance().every(
            whileShown(TestContextPollMs, TestContextUnfocusedPollMs),
            (reason) => ask(reason === "resume"),
            "browser-test-context"
        );
    }, [key, ask]);
    useEffect(() => {
        if (!key || !workspaceDir) {
            return;
        }
        // A Reviews Launch that replaces the version on this port keeps the tab's URL: nothing else tells the chip
        // that another checkout now serves it (#1003).
        return waveEventSubscribeSingle({
            eventType: LaunchEvent as WaveEventName,
            scope: workspaceDir,
            handler: (event) => {
                const state = event.data as LaunchState;
                if (launchServesTarget(state, key)) {
                    ask(true);
                }
            },
        });
    }, [key, workspaceDir, ask]);
    const current = answer?.key === key ? answer.value : null;
    const root = current?.root ?? "";
    const project = current?.project ?? "";
    useEffect(() => {
        if (!root) {
            return;
        }
        const unsubscribes = [
            waveEventSubscribeSingle({
                eventType: MissionPaneEvent as WaveEventName,
                scope: root,
                handler: () => isShowing(TabActivity.getInstance().state()) && ask(false),
            }),
        ];
        if (project) {
            unsubscribes.push(
                waveEventSubscribeSingle({
                    eventType: MissionUpdateEvent as WaveEventName,
                    scope: project,
                    handler: () => ask(false),
                })
            );
        }
        return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
    }, [root, project, ask]);
    return key ? current : null;
}

export function TestContextChip({ url }: { url: string }) {
    const t = useT();
    const workspace = useAtomValue(atoms.workspace);
    const workspaceDir = readWorkspaceProject(workspace).dir;
    const answer = useTestContext(url, workspaceDir);
    const [anchor, setAnchor] = useState<HTMLElement>(null);
    const view = chipView(answer, t);
    if (view == null) {
        return null;
    }
    return (
        <>
            <button
                type="button"
                title={view.title}
                aria-label={view.title}
                aria-expanded={anchor != null}
                onClick={(e) => setAnchor(anchor == null ? e.currentTarget : null)}
                data-testid="browser-test-context"
                data-tone={view.tone}
                className={cn(
                    "flex h-6 max-w-[35%] min-w-0 shrink cursor-pointer items-center gap-1.5 rounded-4 border border-border px-2 text-12 hover:bg-hover hover:text-primary",
                    ToneClasses[view.tone]
                )}
            >
                <i className={cn("fa fa-solid shrink-0 text-11", ToneGlyph[view.tone])} aria-hidden />
                <span className="truncate">{view.label}</span>
                {answer.dirty ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden /> : null}
            </button>
            {anchor != null ? (
                <MenuPopover
                    anchor={anchor}
                    onClose={() => setAnchor(null)}
                    className="flex w-80 flex-col gap-2.5"
                    role="dialog"
                    ariaLabel={t("browser.testContext.title")}
                >
                    <TestContextDetails answer={answer} workspaceDir={workspaceDir} onDone={() => setAnchor(null)} />
                </MenuPopover>
            ) : null}
        </>
    );
}

function TestContextDetails({
    answer,
    workspaceDir,
    onDone,
}: {
    answer: TestContextAnswer;
    workspaceDir: string;
    onDone: () => void;
}) {
    const t = useT();
    const rows = detailRows(answer, t);
    const target = reviewsTarget(answer, workspaceDir);
    const ciState = answer.pr?.ci && answer.pr.ci !== "none" ? checkIconState(answer.pr.ci as CheckState) : null;
    return (
        <div className="flex flex-col gap-2.5" data-testid="browser-test-context-details">
            <div className="text-12 font-semibold text-primary">
                {answer.known ? t("browser.testContext.title") : t("browser.testContext.unknown")}
            </div>
            {!answer.known ? <p className="text-12 leading-5 text-secondary">{reasonText(answer, t)}</p> : null}
            {rows.length > 0 ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-12">
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
            ) : null}
            {answer.known ? (
                <div className="flex flex-col gap-1 rounded-4 border border-border px-2.5 py-2 text-12">
                    {answer.pr != null ? (
                        <div className="flex min-w-0 items-center gap-1.5 text-primary">
                            <i className="fa fa-solid fa-code-pull-request text-11 text-accent" aria-hidden />
                            <span className="shrink-0 font-medium">#{answer.pr.number}</span>
                            <span className="truncate" title={answer.pr.title}>
                                {answer.pr.title}
                            </span>
                        </div>
                    ) : null}
                    <div className="flex items-center gap-1.5 text-secondary" data-testid="browser-test-context-pr">
                        {ciState ? <CiIcon state={ciState} /> : null}
                        <span>{prStateText(answer, t)}</span>
                    </div>
                </div>
            ) : null}
            {answer.known && !answer.sameproject ? (
                <p className="text-11 leading-4 text-muted">
                    {t("browser.testContext.otherProject", { name: answer.name || "" })}
                </p>
            ) : null}
            {target != null || answer.pr != null ? (
                <div className="flex flex-wrap items-center gap-2">
                    {target != null ? (
                        <button
                            type="button"
                            className="molten-btn cursor-pointer rounded-4 px-3 py-1.5 text-12"
                            data-testid="browser-test-context-reviews"
                            onClick={() => {
                                onDone();
                                fireAndForget(() =>
                                    ReviewsModel.getInstance().openReviews(target.dir, target.number, target.branch)
                                );
                            }}
                        >
                            {t("browser.testContext.openInReviews")}
                            <MoltenWave />
                        </button>
                    ) : null}
                    {answer.pr != null ? (
                        <button
                            type="button"
                            className="cursor-pointer rounded-4 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                            onClick={() => {
                                onDone();
                                fireAndForget(() => openWebLink(answer.pr.url));
                            }}
                        >
                            {t("browser.testContext.openPr")}
                        </button>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
