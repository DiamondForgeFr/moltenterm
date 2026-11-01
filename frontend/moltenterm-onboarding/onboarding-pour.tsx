// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The first launch, "the pour" (FR-ONB-007, DS-ONB-007): five full-frame scenes in the first-run panel, five heat bars,
// Skip always there, Enter or → to move on and ← to come back, sparks after a pour. The stage takes the detection and
// the actions as props, so it renders without a window; onboarding-view.tsx wires it to wavesrv.

import { MoltentermMarkPath } from "@/util/moltenterm-identity";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useFeatureMatrix } from "../moltenterm-shell/agent-info/agent-features-model";
import { useT } from "../moltenterm-shell/i18n/i18n";
import { MoltenWave } from "../moltenterm-shell/molten-button";
import { canMorph, OnboardingAgents } from "./onboarding-agent-model";
import { CliInstallStatus } from "./onboarding-install-model";
import { morphRequests } from "./onboarding-morph-model";
import { CodexId, headlineAgentNames, keptAgent, newlyReady, pourAgentCards } from "./onboarding-pour-agents";
import {
    heatStates,
    initialPourState,
    isLastScene,
    nextLabelKey,
    pourKeyAction,
    PourRecord,
    pourReduce,
    PourScenes,
    PourStart,
    recordOnLeaving,
    sparksAllowed,
} from "./onboarding-pour-model";
import { AgentsScene, MorphScene, PourScene, StartScene, WorkshopScene } from "./onboarding-pour-scenes";
import { SparkField } from "./onboarding-pour-sparks";
import "./onboarding-pour.css";

const PourBurstDelayMs = 650;

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
    onRecord: (record: PourRecord) => void;
    onCheckAgain: () => void;
    onInstall?: (id: string) => void;
    onAnswerInstall?: (id: string, text: string) => void;
    onCancelInstall?: (id: string) => void;
    onSkip: () => void;
    onStart: (start: PourStart) => void;
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
    onRecord,
    onCheckAgain,
    onInstall,
    onAnswerInstall,
    onCancelInstall,
    onSkip,
    onStart,
}: PourProps) {
    const t = useT();
    const [state, dispatch] = useReducer(pourReduce, initialScene, initialPourState);
    const [readyName, setReadyName] = useState<string>(null);
    const root = useRef<HTMLDivElement>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
    const sparks = useRef<SparkField>(null);
    const matrix = useFeatureMatrix();
    const cards = useMemo(() => pourAgentCards(agents, matrix), [agents, matrix]);
    const previousCards = useRef(cards);
    const sceneId = PourScenes[state.scene];

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

    // An agent that turns ready on Check again heats up with a burst, and the sentence above names it.
    useEffect(() => {
        const ready = newlyReady(previousCards.current, cards);
        if (previousCards.current.length > 0 && ready.length > 0) {
            setReadyName(ready[0].name);
            const el = root.current?.querySelector(`[data-agent="${ready[0].id}"]`);
            if (el != null) {
                burstFrom(el, 36);
            }
        }
        previousCards.current = cards;
    }, [cards, burstFrom]);

    const next = () => {
        if (busy) {
            return;
        }
        if (isLastScene(state.scene)) {
            burst(0.5, 0.9, 90);
            onStart(state.start);
            return;
        }
        const record = recordOnLeaving(state.scene);
        if (record != null) {
            onRecord(record);
        }
        dispatch({ type: "next" });
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

    const kept = keptAgent(agents);
    const morphAgent = kept != null && canMorph(kept) && kept.executable ? kept : null;
    const tool = (agents?.agents ?? []).find((a) => a.id === CodexId)?.name || "Codex";
    const sceneLabel = t(`onboarding.pour.scenes.${sceneId}`);

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
                    disabled={busy}
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
                {sceneId === "workshop" ? <WorkshopScene reduced={reduced} tool={tool} /> : null}
                {sceneId === "morph" ? <MorphScene reduced={reduced} onPoured={(el) => burstFrom(el, 40)} /> : null}
                {sceneId === "start" ? (
                    <StartScene
                        markPath={MoltentermMarkPath}
                        start={state.start}
                        morphAgentName={morphAgent?.name}
                        morphRequest={morphAgent != null ? morphRequests(morphAgent)[0] : undefined}
                        onChoose={(start) => dispatch({ type: "choose", start })}
                    />
                ) : null}
            </section>
            <div className="mt-pour-nav">
                {error ? (
                    <p className="text-12 text-danger" role="alert">
                        {error}
                    </p>
                ) : null}
                <div className="flex justify-center gap-3">
                    {state.scene > 0 ? (
                        <button
                            type="button"
                            disabled={busy}
                            onClick={() => dispatch({ type: "back" })}
                            className="mt-pour-calm cursor-pointer px-[18px] py-[11px] text-15"
                            data-testid="first-run-back"
                        >
                            {t("onboarding.pour.back")}
                        </button>
                    ) : null}
                    <button
                        type="button"
                        disabled={busy}
                        onClick={next}
                        className="molten-btn cursor-pointer rounded-4 px-[22px] py-3 text-15 font-semibold"
                        data-testid="first-run-next"
                    >
                        {busy && isLastScene(state.scene) ? t("onboarding.pour.opening") : t(nextLabelKey(state.scene))}
                        <MoltenWave />
                    </button>
                </div>
            </div>
        </div>
    );
}
