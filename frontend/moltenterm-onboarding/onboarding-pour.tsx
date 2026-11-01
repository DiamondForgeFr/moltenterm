// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The first launch, "the pour" (FR-ONB-007, DS-ONB-007): six full-frame scenes in the first-run panel (#1709), six heat
// bars, Skip always there, Later on the project and the view, Enter or → to move on and ← to come back, sparks after a
// pour. The stage takes the detection and the actions as props, so it renders without a window; onboarding-view.tsx
// wires it to wavesrv.

import { MoltentermMarkPath } from "@/util/moltenterm-identity";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useFeatureMatrix } from "../moltenterm-shell/agent-info/agent-features-model";
import { useT } from "../moltenterm-shell/i18n/i18n";
import { MoltenWave } from "../moltenterm-shell/molten-button";
import { OnboardingAgents } from "./onboarding-agent-model";
import {
    defaultAgentId,
    FirstViewPlan,
    firstViewPlan,
    projectTarget,
    ProjectDraft,
    ProjectResult,
    readyAgents,
    suggestedNameKey,
} from "./onboarding-first-view-model";
import { CliInstallStatus } from "./onboarding-install-model";
import {
    chipOf,
    FirstViewScene,
    PlaceScene,
    ProjectChip,
    ProjectScene,
    ReadyScene,
    viewParts,
} from "./onboarding-pour-build";
import { headlineAgentNames, newlyReady, pourAgentCards } from "./onboarding-pour-agents";
import {
    heatStates,
    initialPourState,
    isLastScene,
    nextLabelKey,
    offersLater,
    pourKeyAction,
    PourRecord,
    pourReduce,
    PourScenes,
    recordOnLeaving,
    sparksAllowed,
} from "./onboarding-pour-model";
import { AgentsScene, PourScene } from "./onboarding-pour-scenes";
import { SparkField } from "./onboarding-pour-sparks";
import { ProjectCandidate, WorkspaceColours } from "./onboarding-project-model";
import "./onboarding-pour.css";

const PourBurstDelayMs = 650;
const NoProjectColour = WorkspaceColours[0];

export type PourProps = {
    reduced: boolean;
    busy: boolean;
    error?: string;
    // null while the detection runs
    agents: OnboardingAgents;
    agentsError?: string;
    checking: boolean;
    // the installs Install started, by agent id
    installs?: Record<string, CliInstallStatus>;
    initialScene?: number;
    // the project scene: the home folder (paths show with ~), the folder new projects go in, and the candidates
    home?: string;
    projectsFolder?: string;
    candidates?: ProjectCandidate[];
    scanning?: boolean;
    // the workspace's name as shown, for a run without a project
    workspaceName?: string;
    now?: number;
    onRecord: (record: PourRecord) => void;
    onCheckAgain: () => void;
    onInstall?: (id: string) => void;
    onAnswerInstall?: (id: string, text: string) => void;
    onCancelInstall?: (id: string) => void;
    onSkip: () => void;
    // leaving the project scene creates or links its project; null keeps the scene (the error says why)
    onLeaveProject?: (draft: ProjectDraft) => Promise<ProjectResult>;
    onLaterProject?: () => void;
    // the computer's folder chooser; null when cancelled
    onChooseFolder?: (purpose: "where" | "find", current: string) => Promise<string>;
    // the end: the view to make, or null when it was left for later
    onStart: (plan: FirstViewPlan) => void;
};

export function OnboardingPour({
    reduced,
    busy,
    error,
    agents,
    agentsError,
    checking,
    installs,
    initialScene,
    home,
    projectsFolder,
    candidates,
    scanning,
    workspaceName,
    now,
    onRecord,
    onCheckAgain,
    onInstall,
    onAnswerInstall,
    onCancelInstall,
    onSkip,
    onLeaveProject,
    onLaterProject,
    onChooseFolder,
    onStart,
}: PourProps) {
    const t = useT();
    const [state, dispatch] = useReducer(pourReduce, initialScene, initialPourState);
    const [readyName, setReadyName] = useState<string>(null);
    const [installedId, setInstalledId] = useState<string>(null);
    const [leaving, setLeaving] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const sparks = useRef<SparkField>(null);
    const matrix = useFeatureMatrix();
    const cards = useMemo(() => pourAgentCards(agents, matrix), [agents, matrix]);
    const previousCards = useRef(cards);
    const sceneId = PourScenes[state.scene];
    const found = candidates ?? [];
    const ready = useMemo(() => readyAgents(agents), [agents]);
    const agentId = defaultAgentId(ready, state.agent, installedId);

    useEffect(() => {
        root.current?.focus({ preventScroll: true });
    }, []);

    useEffect(() => {
        const el = canvas.current;
        const host = root.current;
        if (el == null || host == null) {
            return;
        }
        const field = new SparkField(el);
        sparks.current = field;
        const observer = new ResizeObserver((entries) => {
            const box = entries[0]?.contentRect;
            if (box != null) {
                field.resize(box.width, box.height, window.devicePixelRatio);
            }
        });
        observer.observe(host);
        const onVisibility = () => {
            if (document.hidden) {
                field.stop();
            }
        };
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            observer.disconnect();
            document.removeEventListener("visibilitychange", onVisibility);
            field.stop();
            sparks.current = null;
        };
    }, []);

    useEffect(() => {
        sparks.current?.setEnabled(sparksAllowed(reduced, false));
    }, [reduced]);

    // The folder new projects go in, and the first candidate found, until the user chooses.
    useEffect(() => {
        if (!state.project.location && projectsFolder) {
            dispatch({ type: "project", patch: { location: projectsFolder } });
        }
    }, [projectsFolder, state.project.location]);
    useEffect(() => {
        if (!state.project.found && found.length > 0) {
            dispatch({ type: "project", patch: { found: found[0].path } });
        }
    }, [found, state.project.found]);

    const burst = useCallback((fx: number, fy: number, count: number) => {
        sparks.current?.burst(fx, fy, count);
    }, []);

    // A burst from an element of the stage: the rects are read on an event, never in an animation frame.
    const burstFrom = useCallback(
        (el: Element, count: number) => {
            const host = root.current?.getBoundingClientRect();
            if (el == null || host == null || host.width === 0 || host.height === 0) {
                return;
            }
            const box = el.getBoundingClientRect();
            burst((box.left - host.left + box.width / 2) / host.width, (box.top - host.top + 8) / host.height, count);
        },
        [burst]
    );

    useEffect(() => {
        if (sceneId === "pour") {
            const timer = setTimeout(() => burst(0.5, 0.42, 70), PourBurstDelayMs);
            return () => clearTimeout(timer);
        }
        if (sceneId === "start") {
            burst(0.5, 0.3, 50);
        }
    }, [sceneId, state.visit, burst]);

    // An agent that turns ready on Check again heats up with a burst, and the sentence above names it; one the user
    // installed here becomes the first view's agent.
    useEffect(() => {
        const turned = newlyReady(previousCards.current, cards);
        if (previousCards.current.length > 0 && turned.length > 0) {
            setReadyName(turned[0].name);
            if (installs?.[turned[0].id] != null) {
                setInstalledId(turned[0].id);
            }
            const el = root.current?.querySelector(`[data-agent="${turned[0].id}"]`);
            if (el != null) {
                burstFrom(el, 36);
            }
        }
        previousCards.current = cards;
    }, [cards, burstFrom]);

    const projectChip: ProjectChip = state.projectSet
        ? { name: state.projectSet.name, colour: state.projectSet.colour }
        : { name: workspaceName || t("onboarding.pour.view.myWorkspace"), colour: NoProjectColour };
    const viewName = state.named ? state.viewName : t(suggestedNameKey(state.tools));
    const blocked = sceneId === "project" && projectTarget(state.project) === "";

    const leaveProject = async () => {
        if (onLeaveProject == null) {
            dispatch({ type: "next" });
            return;
        }
        setLeaving(true);
        try {
            const result = await onLeaveProject(state.project);
            if (result != null) {
                dispatch({ type: "projectSet", result });
                dispatch({ type: "next" });
            }
        } finally {
            setLeaving(false);
        }
    };

    const next = () => {
        if (busy || leaving || blocked) {
            return;
        }
        if (isLastScene(state.scene)) {
            burst(0.5, 0.9, 90);
            onStart(
                state.viewSkipped
                    ? null
                    : firstViewPlan({
                          tools: state.tools,
                          agentId,
                          typedName: state.viewName,
                          named: state.named,
                          place: state.place,
                      })
            );
            return;
        }
        if (sceneId === "project") {
            void leaveProject();
            return;
        }
        const record = recordOnLeaving(state.scene);
        if (record != null) {
            onRecord(record);
        }
        dispatch({ type: "next" });
    };

    const later = () => {
        if (busy || leaving) {
            return;
        }
        if (sceneId === "project") {
            onLaterProject?.();
            dispatch({ type: "laterProject" });
            return;
        }
        dispatch({ type: "laterView" });
    };

    const choose = async (purpose: "where" | "find") => {
        const current = purpose === "where" ? state.project.location : state.project.found;
        const path = await onChooseFolder?.(purpose, current);
        if (!path) {
            return;
        }
        dispatch({ type: "project", patch: purpose === "where" ? { location: path } : { found: path } });
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        const target = e.target as HTMLElement;
        const action = pourKeyAction(e.key, {
            onButton: target.closest?.("button, a") != null,
            inField: target.closest?.("input, textarea, [contenteditable='true']") != null,
            modifier: e.metaKey || e.ctrlKey || e.altKey || e.shiftKey,
        });
        if (action == null) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        if (action === "next") {
            next();
            return;
        }
        dispatch({ type: "back" });
    };

    const sceneLabel = t(`onboarding.pour.scenes.${sceneId}`);
    // A project chosen among the candidates, or Look elsewhere, shows in the list.
    const listed =
        state.project.found && !found.some((c) => c.path === state.project.found)
            ? [{ path: state.project.found, name: chipOf(state.project.found)?.name ?? state.project.found }, ...found]
            : found;
    const working = busy || leaving;

    return (
        <div
            ref={root}
            className="mt-pour"
            tabIndex={-1}
            onKeyDown={onKeyDown}
            data-mt-dark-surface=""
            data-reduced={reduced ? "" : undefined}
            data-scene={sceneId}
            data-testid="first-run-pour"
            role="region"
            aria-label={t("onboarding.viewName")}
        >
            <canvas ref={canvas} className="mt-pour-sparks" aria-hidden />
            <div className="mt-pour-top">
                <div className="mt-pour-heat" aria-hidden>
                    {heatStates(state.scene).map((heat, i) => (
                        <span key={i} data-heat={heat} />
                    ))}
                </div>
                <span className="sr-only" aria-live="polite">
                    {t("onboarding.pour.progress", { n: state.scene + 1, total: PourScenes.length, scene: sceneLabel })}
                </span>
                <button
                    type="button"
                    disabled={working}
                    onClick={onSkip}
                    className="cursor-pointer border-0 bg-transparent px-2 py-1.5 text-13 text-muted hover:text-secondary"
                    data-testid="first-run-skip"
                >
                    {t("onboarding.pour.skip")}
                </button>
            </div>
            <section
                key={`${sceneId}-${state.visit}`}
                className="mt-pour-scene"
                aria-label={sceneLabel}
                data-testid={`pour-scene-${sceneId}`}
            >
                {sceneId === "pour" ? (
                    <PourScene markPath={MoltentermMarkPath} names={headlineAgentNames(agents)} />
                ) : null}
                {sceneId === "agents" ? (
                    <AgentsScene
                        cards={cards}
                        list={agents}
                        loading={agents == null && !agentsError}
                        error={agentsError}
                        checking={checking}
                        open={state.open}
                        ready={readyName}
                        installs={installs ?? {}}
                        onToggle={(id) => dispatch({ type: "toggle", card: id })}
                        onInstall={(id) => {
                            if (state.open !== id) {
                                dispatch({ type: "toggle", card: id });
                            }
                            onInstall?.(id);
                        }}
                        onAnswer={(id, text) => onAnswerInstall?.(id, text)}
                        onCancel={(id) => onCancelInstall?.(id)}
                        onCheck={onCheckAgain}
                    />
                ) : null}
                {sceneId === "project" ? (
                    <ProjectScene
                        draft={state.project}
                        home={home}
                        candidates={listed}
                        scanning={!!scanning}
                        now={now ?? Date.now()}
                        onPatch={(patch) => dispatch({ type: "project", patch })}
                        onChooseWhere={() => void choose("where")}
                        onLookElsewhere={() => void choose("find")}
                    />
                ) : null}
                {sceneId === "view" ? (
                    <FirstViewScene
                        tools={state.tools}
                        name={viewName}
                        named={state.named}
                        agents={ready}
                        agentId={agentId}
                        project={projectChip}
                        reduced={reduced}
                        onTool={(kind) => dispatch({ type: "tool", kind })}
                        onPreset={(id) => dispatch({ type: "preset", id })}
                        onName={(text) => dispatch({ type: "name", text })}
                        onAgent={(id) => dispatch({ type: "agent", id })}
                        onPoured={(el) => burstFrom(el, 30)}
                    />
                ) : null}
                {sceneId === "place" ? (
                    <PlaceScene
                        name={viewName}
                        place={state.place}
                        project={projectChip}
                        onPlace={(place) => dispatch({ type: "place", place })}
                    />
                ) : null}
                {sceneId === "start" ? (
                    <ReadyScene
                        markPath={MoltentermMarkPath}
                        recap={{
                            project: state.projectSet,
                            view: state.viewSkipped
                                ? null
                                : {
                                      name: viewName,
                                      parts: viewParts(ready.find((a) => a.id === agentId)?.name, state.tools, t),
                                  },
                            place: state.place,
                            workspace: projectChip.name,
                        }}
                    />
                ) : null}
            </section>
            <div className="mt-pour-nav">
                {error ? (
                    <p className="text-12 text-danger" role="alert" data-testid="first-run-error">
                        {error}
                    </p>
                ) : null}
                <div className="flex justify-center gap-3">
                    {state.scene > 0 ? (
                        <button
                            type="button"
                            disabled={working}
                            onClick={() => dispatch({ type: "back" })}
                            className="mt-pour-calm cursor-pointer px-[18px] py-[11px] text-15"
                            data-testid="first-run-back"
                        >
                            {t("onboarding.pour.back")}
                        </button>
                    ) : null}
                    {offersLater(state.scene) ? (
                        <button
                            type="button"
                            disabled={working}
                            onClick={later}
                            className="mt-pour-ghost cursor-pointer px-2.5 py-[11px] text-13"
                            data-testid="first-run-later"
                        >
                            {t("onboarding.pour.later")}
                        </button>
                    ) : null}
                    <button
                        type="button"
                        disabled={working}
                        aria-disabled={blocked}
                        onClick={next}
                        className="molten-btn cursor-pointer rounded-4 px-[22px] py-3 text-15 font-semibold aria-disabled:opacity-50"
                        data-testid="first-run-next"
                    >
                        {working && (isLastScene(state.scene) || sceneId === "project")
                            ? t(isLastScene(state.scene) ? "onboarding.pour.opening" : "onboarding.pour.settingUp")
                            : t(nextLabelKey(state.scene))}
                        <MoltenWave />
                    </button>
                </div>
            </div>
        </div>
    );
}
