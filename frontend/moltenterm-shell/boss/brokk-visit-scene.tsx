// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's visit (FR-BOSS-009, AC5 to AC7, AC14, #2002): when the visit model says he comes, the avatar grows into a
// full-bleed forge scene at the top of the sidebar. It starts at y = 0 behind the title row, runs to both side edges,
// has no margin, box or card, and its bottom fades into the sidebar's own background. There is no text on it: his face
// carries the severity, its accessible name and its tooltip say the rest. A click anywhere on it, Enter or Space folds
// him back into the avatar and opens his panel in the same gesture; Plus tard, at the bottom left, asks when to come
// back, and Escape takes the default delay. The content below the title row slides down to make room, which the sidebar
// does itself (workspace-sidebar.tsx, sidebar.css).
//
// Loaded on the first visit, never with the window: the clips are Brokk's portrait and stay out of the up-front JavaScript.

import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n/i18n";
import { prefersReducedMotion } from "../molten-motion";
import "./brokk-visit-scene.css";
import { BrokkHubModel } from "./brokk-hub-store";
import type { Visit } from "./brokk-visit";
import {
    LaterOption,
    laterOptions,
    sceneActions,
    sceneClipOf,
    sceneEscapes,
    sceneLabel,
    unmountAfterMs,
} from "./brokk-visit-scene-model";
import BrokkStill from "./portrait/brokk/brokk.jpg";
import { BossBubbleModel } from "./boss-store";
import { useHubSelect } from "./use-brokk-hub";
import { useMotionAllowed } from "./use-brokk-live";

// The four faces: the clips of his listening pose, by the file name the package ships them under. Read as URLs only.
const Clips = import.meta.glob("./portrait/brokk/listening.*.webm", {
    query: "?url",
    import: "default",
    eager: true,
}) as unknown as Record<string, string>;

function clipUrl(name: string): string {
    return Clips[`./portrait/brokk/${name}.webm`];
}

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

// His face is a loop of the clip of the severity. Without motion (the app's setting, the system's, or a window nobody
// sees) it is one still frame of that clip: the package ships no still per expression, so the clip is held at its middle.
function SceneFace({ clip }: { clip: string }) {
    const motion = useMotionAllowed();
    const videoRef = useRef<HTMLVideoElement>(null);
    useEffect(() => {
        const video = videoRef.current;
        if (video == null) {
            return;
        }
        if (motion) {
            void video.play()?.catch(() => {});
            return;
        }
        video.pause();
        const hold = () => {
            if (Number.isFinite(video.duration)) {
                video.currentTime = video.duration / 2;
            }
        };
        if (video.readyState >= 1) {
            hold();
            return;
        }
        video.addEventListener("loadedmetadata", hold, { once: true });
        return () => video.removeEventListener("loadedmetadata", hold);
    }, [motion, clip]);
    return (
        <video
            key={clip}
            ref={videoRef}
            className="mt-brokk-scene-video"
            src={clipUrl(clip)}
            poster={BrokkStill}
            muted
            loop
            playsInline
            preload="auto"
            autoPlay={motion}
            data-testid="brokk-scene-video"
        />
    );
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
    shown,
    rowHeight,
}: {
    visit: Visit;
    name: string;
    shown: boolean;
    rowHeight: string;
}) {
    const t = useT();
    const hub = BrokkHubModel.getInstance().hub;
    const layerRef = useRef<HTMLDivElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const [options, setOptions] = useState<LaterOption[]>(null);
    const label = sceneLabel(t, name, visit.severity);
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
    const actions = sceneActions(hub);
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
                data-severity={visit.severity}
                data-menu={options != null ? "open" : undefined}
            >
                <span className="mt-brokk-scene-art" aria-hidden>
                    <span className="mt-brokk-scene-clip">
                        <SceneFace clip={sceneClipOf(visit.severity)} />
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
                    title={label}
                    tabIndex={tabIndex}
                    onClick={actions.fold}
                />
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
                    <LaterMenu
                        menuRef={menuRef}
                        options={options}
                        onChoose={(id) => leave(() => actions.choose(id))}
                    />
                ) : null}
            </div>
        </div>
    );
}

// The scene at the top of the sidebar: nothing while no visit is up, and the visit's last face while it folds back.
export function BrokkVisitScene({ rowHeight }: { rowHeight: string }) {
    const name = useAtomValue(BossBubbleModel.getInstance().nameAtom, { store: globalStore });
    const visit = useHubSelect((view) => view.visit);
    const last = useRef<Visit>(visit);
    if (visit != null) {
        last.current = visit;
    }
    const life = useSceneLife(visit != null, unmountAfterMs(prefersReducedMotion()));
    if (!life.mounted || last.current == null) {
        return null;
    }
    return <BrokkVisitSceneView visit={last.current} name={name} shown={life.shown && visit != null} rowHeight={rowHeight} />;
}
