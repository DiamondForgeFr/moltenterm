// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's visit (FR-BOSS-009, AC5 to AC7, AC14, #2002): when the visit model says he comes, the avatar grows into a
// full-bleed forge scene at the top of the sidebar. It starts at y = 0 behind the title row, runs to both side edges,
// has no margin, box or card, and its bottom fades into the sidebar's own background. There is no text on it: his face
// carries the severity, its accessible name and its tooltip say the rest. A click anywhere on it, Enter or Space folds
// him back into the avatar and opens his panel in the same gesture; Plus tard, at the bottom left, asks when to come
// back, and Escape takes the default delay. The content below the title row slides down to make room, which the sidebar
// does itself (workspace-sidebar.tsx, sidebar.css). In a collapsed sidebar, half open for him or unfolded (AC29, AC30,
// #2070), the scene is the banner it shows; there and in a docked sidebar (#2155) it says its one line: the sentence of
// the event that brought him, in his own words (brokk-visit-line.ts). Its accessible name stays the label below.
//
// Loaded on the first visit, never with the window: the clips are Brokk's portrait and stay out of the up-front JavaScript.

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { TransmissionPortrait } from "@diamondforge/character";
import "@diamondforge/character/styles.css";
import { useAtomValue } from "jotai";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n/i18n";
import { TabActivity, whileShown } from "../tab-activity";
import { BossBubbleModel } from "./boss-store";
import { BrokkCalm } from "./brokk-calm";
import { useCaptionText } from "./brokk-caption";
import { BrokkHubModel } from "./brokk-hub-store";
import { BrokkPortrait, rhythmProps } from "./brokk-portrait";
import type { Severity } from "./brokk-queue";
import { reactionCapMs } from "./brokk-state-model";
import type { Visit } from "./brokk-visit";
import { visitLineOf } from "./brokk-visit-line";
import {
    exampleSceneActions,
    LaterOption,
    laterOptions,
    sceneActions,
    SceneClock,
    SceneCue,
    sceneEscapes,
    sceneGestureOf,
    SceneGestures,
    sceneLabel,
    ScenePhase,
    scenePhase,
    ScenePose,
    sceneWaitGestureOf,
    startSceneGestures,
    unmountAfterMs,
} from "./brokk-visit-scene-model";
import "./brokk-visit-scene.css";
import { BrokkVisitWords } from "./brokk-visit-words-store";
import BrokkStill from "./portrait/brokk/brokk.jpg";
import { useHubSelect } from "./use-brokk-hub";
import { useFaceVisible, useReducedMotion } from "./use-brokk-live";

// The scene is mounted from the moment a visit is up until it has folded back, and drawn open one frame after it is
// mounted, so that the movement has a start to play from.
export function useSceneLife(open: boolean, unmountAfter: number): { mounted: boolean; shown: boolean } {
    const [mounted, setMounted] = useState(open);
    const [shown, setShown] = useState(false);
    useEffect(() => {
        if (open) {
            setMounted(true);
            let second = 0;
            const first = requestAnimationFrame(() => {
                second = requestAnimationFrame(() => setShown(true));
            });
            return () => {
                cancelAnimationFrame(first);
                cancelAnimationFrame(second);
            };
        }
        setShown(false);
        const timer = setTimeout(() => setMounted(false), unmountAfter);
        return () => clearTimeout(timer);
    }, [open, unmountAfter]);
    return { mounted, shown };
}

// The line counts minutes of a wait: it is drawn again each minute while the visit is up.
function useMinuteTick(active: boolean): void {
    const [, setTick] = useState(0);
    useEffect(() => {
        if (!active) {
            return;
        }
        return TabActivity.getInstance().every(whileShown(60 * 1000), () => setTick((n) => n + 1), "visit-line");
    }, [active]);
}

const BrowserClock: SceneClock = {
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    random: () => Math.random(),
};

// His living face (#2025, #2262): the package's portrait that drives him elsewhere, waiting in the listening pose with
// the idles it draws by chance at the rhythm of brokk-portrait.ts. The face of the severity plays once as he arrives; a
// grave visit adds his sigh now and then while he waits (startSceneGestures), never over an idle under way.
export function SceneLive({ severity, clock = BrowserClock }: { severity: Severity; clock?: SceneClock }) {
    const arrival = sceneGestureOf(severity);
    const wait = sceneWaitGestureOf(severity);
    const [cue, setCue] = useState<SceneCue>(null);
    const gestures = useRef<SceneGestures>(null);
    useEffect(() => {
        const started = startSceneGestures(clock, { arrival, wait }, reactionCapMs, setCue);
        gestures.current = started;
        return () => {
            started.stop();
            gestures.current = null;
        };
    }, [arrival, wait, clock]);
    const onGesture = (name: string, phase: "start" | "end") => gestures.current?.heard(name, phase);
    return (
        <TransmissionPortrait
            {...BrokkPortrait}
            {...rhythmProps("normal")}
            bare
            className="mt-brokk-scene-portrait"
            alt=""
            state={ScenePose}
            expression={cue}
            onGesture={onGesture}
        />
    );
}

// Under reduced motion (the app's setting or the system's, read from its atom) his face is the calm loop of his listening
// pose with slow blinks, with no gesture of the severity (#2224): the scene's accessible name and, where it shows one,
// its line carry the severity instead. A window nobody sees mounts nothing.
function SceneFace({ severity }: { severity: Severity }) {
    const visible = useFaceVisible();
    const calm = useReducedMotion();
    if (!visible) {
        return null;
    }
    if (calm) {
        return <BrokkCalm pose={ScenePose} poster={BrokkStill} />;
    }
    return <SceneLive severity={severity} />;
}

// Plus tard (AC7): the delays of the severity, the first being what Escape takes.
export function LaterMenu({
    options,
    onChoose,
    menuRef,
}: {
    options: LaterOption[];
    onChoose: (id: LaterOption["id"]) => void;
    menuRef?: React.RefObject<HTMLDivElement>;
}) {
    const t = useT();
    return (
        <div
            ref={menuRef}
            className="mt-brokk-later-menu"
            role="menu"
            aria-label={t("boss.visit.later.menu")}
            data-testid="brokk-later-menu"
        >
            {options.map((option) => (
                <button
                    key={option.id}
                    type="button"
                    role="menuitem"
                    className={cn("mt-brokk-later-choice", option.isDefault && "is-default")}
                    data-choice={option.id}
                    onClick={() => onChoose(option.id)}
                >
                    {t(option.labelKey)}
                </button>
            ))}
        </div>
    );
}

export function BrokkVisitSceneView({
    visit,
    name,
    phase,
    rowHeight,
    line,
}: {
    visit: Visit;
    name: string;
    phase: ScenePhase;
    rowHeight: string;
    // Brokk is on, in a collapsed or a docked sidebar (#2155): the scene says its one line, the sentence of the event.
    // Without it the scene has no text but Plus tard.
    line?: string;
}) {
    const t = useT();
    const lineId = useId();
    const hub = BrokkHubModel.getInstance().hub;
    const layerRef = useRef<HTMLDivElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const [options, setOptions] = useState<LaterOption[]>(null);
    const label = sceneLabel(t, name, visit.severity, visit.example === true);
    const shown = phase === "open";
    const tabIndex = shown ? 0 : -1;

    // Where the avatar is, relative to the scene: the scene grows from it and folds back into it.
    useLayoutEffect(() => {
        const layer = layerRef.current;
        const avatar = document.querySelector("[data-brokk-avatar='row']");
        if (layer == null || avatar == null) {
            return;
        }
        const from = avatar.getBoundingClientRect();
        const to = layer.getBoundingClientRect();
        if (to.width === 0 || to.height === 0) {
            return;
        }
        layer.style.setProperty("--mt-brokk-from-x", `${from.left - to.left}px`);
        layer.style.setProperty("--mt-brokk-from-y", `${from.top - to.top}px`);
        layer.style.setProperty("--mt-brokk-from-sx", String(from.width / to.width));
        layer.style.setProperty("--mt-brokk-from-sy", String(from.height / to.height));
    }, [shown]);

    useEffect(() => {
        if (options != null) {
            menuRef.current?.querySelector<HTMLElement>("button.is-default")?.focus({ preventScroll: true });
        }
    }, [options]);

    // The focus the scene held goes back to the avatar that takes his place; a developer who was elsewhere is left there.
    const leave = (act: () => void) => {
        const held = layerRef.current?.contains(document.activeElement) === true;
        act();
        if (held) {
            requestAnimationFrame(() =>
                document.querySelector<HTMLElement>("[data-brokk-avatar]")?.focus({ preventScroll: true })
            );
        }
    };
    const actions = visit.example === true ? exampleSceneActions(() => hub.closeExample()) : sceneActions(hub);
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (!sceneEscapes(e.key, e.nativeEvent.isComposing)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        leave(actions.escape);
    };

    return (
        <div
            ref={layerRef}
            className="mt-brokk-scene-layer"
            style={{ "--mt-brokk-row": rowHeight } as React.CSSProperties}
            data-testid="brokk-scene-layer"
            onKeyDown={onKeyDown}
        >
            <div
                className="mt-brokk-scene"
                data-testid="brokk-scene"
                data-open={shown ? "true" : "false"}
                data-phase={phase}
                data-severity={visit.severity}
                data-menu={options != null ? "open" : undefined}
            >
                <span className="mt-brokk-scene-art" aria-hidden>
                    <span className="mt-brokk-scene-clip">
                        <SceneFace severity={visit.severity} />
                    </span>
                    <span className="mt-brokk-scene-shade" />
                    <span className="mt-brokk-scene-glow" />
                    <span className="mt-brokk-scene-embers">
                        <i />
                        <i />
                        <i />
                    </span>
                    <span className="mt-brokk-scene-topfade" />
                </span>
                <button
                    type="button"
                    className="mt-brokk-scene-hit"
                    data-testid="brokk-scene-hit"
                    aria-label={label}
                    aria-describedby={line ? lineId : undefined}
                    title={label}
                    tabIndex={tabIndex}
                    onClick={actions.fold}
                />
                {line ? (
                    <span id={lineId} className="mt-brokk-scene-line" data-testid="brokk-scene-line">
                        {line}
                    </span>
                ) : null}
                <button
                    type="button"
                    className="mt-brokk-later"
                    data-testid="brokk-later"
                    aria-haspopup="menu"
                    aria-expanded={options != null}
                    tabIndex={tabIndex}
                    onClick={() => setOptions(laterOptions(visit.severity, Date.now()))}
                >
                    {t("boss.visit.later.label")}
                </button>
                {options != null ? (
                    <LaterMenu menuRef={menuRef} options={options} onChoose={(id) => leave(() => actions.choose(id))} />
                ) : null}
            </div>
        </div>
    );
}

// The scene at the top of the sidebar: nothing while no visit is up, and the visit's last face while it folds back.
export function BrokkVisitScene({ rowHeight, line = false }: { rowHeight: string; line?: boolean }) {
    const name = useAtomValue(BossBubbleModel.getInstance().nameAtom, { store: globalStore });
    const list = useAtomValue(BossBubbleModel.getInstance().toHandleAtom, { store: globalStore });
    const visit = useHubSelect((view) => view.visit);
    const text = useCaptionText();
    useMinuteTick(line && visit != null);
    const wording = BrokkVisitWords.getInstance();
    const over = visit == null;
    useEffect(() => {
        if (over) {
            wording.rest();
        }
    }, [over, wording]);
    const last = useRef<Visit>(visit);
    const words = useRef("");
    if (visit != null) {
        last.current = visit;
        words.current = line ? text(visitLineOf(visit, list.items, Date.now(), wording.pick)) : "";
    }
    const reduced = useReducedMotion();
    const life = useSceneLife(visit != null, unmountAfterMs(reduced));
    if (!life.mounted || last.current == null) {
        return null;
    }
    return (
        <BrokkVisitSceneView
            visit={last.current}
            name={name}
            phase={scenePhase(visit != null, life.shown)}
            rowHeight={rowHeight}
            line={line && words.current !== "" ? words.current : undefined}
        />
    );
}
