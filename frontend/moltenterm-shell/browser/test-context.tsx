// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The test context chip at the start of the browser's address bar (FR-BRW-017, #962): on a local tab, the branch and
// PR the page is served from; a click opens the version card (#2326, version-card.tsx). It asks wavesrv
// when the tab's server changes, while the tab is shown, and when git changes the served tree; wavesrv answers from
// local reads and the collector's cache, never a gh call.

import { atoms } from "@/app/store/global";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../i18n/i18n";
import { MenuPopover } from "../mission/menu-popover";
import { MissionRouteId, MissionUpdateEvent } from "../mission/mission-client";
import { MissionPaneEvent } from "../pane-status";
import { LaunchEvent } from "../reviews/reviews-launch-client";
import type { LaunchState } from "../reviews/reviews-launch-model";
import { TabActivity, whileShown } from "../tab-activity";
import { isShowing } from "../tab-activity-model";
import { readWorkspaceProject } from "../workspace-project";
import {
    ChipTone,
    chipView,
    launchServesTarget,
    localAppTarget,
    targetKey,
    TestContextAnswer,
    TestContextCommand,
} from "./test-context-model";
import { VersionCard } from "./version-card";

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

export function useTestContext(url: string, workspaceDir: string): { answer: TestContextAnswer; refresh: () => void } {
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
    const refresh = useCallback(() => ask(true), [ask]);
    return { answer: key ? current : null, refresh };
}

// onSwitch: the panel loads another served version in its shown tab (#2326).
export function TestContextChip({ url, onSwitch }: { url: string; onSwitch?: (url: string) => void }) {
    const t = useT();
    const workspace = useAtomValue(atoms.workspace);
    const workspaceDir = readWorkspaceProject(workspace).repo;
    const { answer, refresh } = useTestContext(url, workspaceDir);
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
                    className="flex flex-col"
                    role="dialog"
                    ariaLabel={t("browser.testContext.cardTitle")}
                    focusManaged
                >
                    <VersionCard
                        answer={answer}
                        workspaceDir={workspaceDir}
                        onSwitch={onSwitch}
                        onDone={() => setAnchor(null)}
                        onChanged={refresh}
                    />
                </MenuPopover>
            ) : null}
        </>
    );
}
