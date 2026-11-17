// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The stage of Brokk's thought in 3D (FR-BOSS-010 AC4 to AC6, AC19, DS-BOSS-008, #2246): the canvas and the layer of
// plates over it. three.js and the scene come behind this one import(), in their own chunk, the first time the mode
// opens (build/on-demand-imports.test.ts); the stage mounts only while the mode is open, and its scene is disposed with
// it, so no graphics context exists while the mode is closed.
//
// The stage is also where the developer explores the graph (FR-BOSS-010 AC7a, AC7b, #2283): a drag on the background
// pans, the trackpad's two-finger scroll and the wheel pan, a pinch or Ctrl/⌘ + scroll zooms about the pointer, a double
// click on the background recentres, and while it has the focus + and − zoom, 0 recentres and the arrows pan. A press on
// a plate is the plate's, and Escape goes on to his group, which ends the brainstorm. brainstorm-camera-model.ts reads
// the gestures; the scene moves the camera.
//
// The plates are the developer's too (FR-BOSS-010 AC7, AC20, AC27, #2247): a click focuses one (the camera goes to it),
// a right-click, its handle or the menu key opens its menu, a double click or F2 edits its text in place, Delete removes
// it (the layer's bar offers Undo), and Ctrl/⌘ + Z puts back the developer's last change. With a plate focused, the
// arrows walk the graph's outline instead of panning. While Link to… waits, a click on another plate ties the two.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocale, useT } from "../i18n/i18n";
import { TabActivity, whileShown } from "../tab-activity";
import { dragStarted, NavAction, pressPans, readKey, readWheel } from "./brainstorm-camera-model";
import { BrainstormEditBar, openPlateMenu } from "./brainstorm-edit";
import { isUndoKey, outlineStep, plateMenuOf } from "./brainstorm-edit-model";
import type { BrainstormGraph, NodeKind } from "./brainstorm-graph-model";
import { FreeRect, freeRect } from "./brainstorm-scene-model";
import { BrainstormModel } from "./brainstorm-store";

// The scene's type alone: its module stays behind the import() below.
type BrainstormScene = import("./brainstorm-scene").BrainstormScene;

// The cross-fade that replaces a camera move under reduced motion: must match .mt-bs-stage.is-fading in brainstorm.css.
const CrossFadeMs = 150;
const FreeSpaceEveryMs = 400;

// The box of Brokk's group and of what opened from it (his conversation window, his panel), in the stage's pixels.
function groupBoxOf(stage: HTMLElement): FreeRect {
    const group = document.querySelector("[data-boss-card]");
    if (group == null) {
        return null;
    }
    const origin = stage.getBoundingClientRect();
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const child of Array.from(group.children)) {
        const box = child.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) {
            continue;
        }
        left = Math.min(left, box.left - origin.left);
        top = Math.min(top, box.top - origin.top);
        right = Math.max(right, box.right - origin.left);
        bottom = Math.max(bottom, box.bottom - origin.top);
    }
    return right > left ? { left, top, width: right - left, height: bottom - top } : null;
}

// The free space for the scene, and for the lines over it (its header and its edge line read --bs-free-top).
function placeFree(stage: HTMLElement, scene: BrainstormScene): void {
    const box = stage.getBoundingClientRect();
    const free = freeRect({ width: box.width, height: box.height }, groupBoxOf(stage));
    scene.setFreeRect(free);
    stage.parentElement?.style.setProperty("--bs-free-top", `${Math.round(free.top)}px`);
    stage.parentElement?.style.setProperty("--bs-free-left", `${Math.round(free.left)}px`);
}

// A press on a plate is the plate's (a click, its menu, its text), never a pan; so is one on the layer's bar.
function onPlate(target: EventTarget): boolean {
    return (target as Element)?.closest?.(".mt-bs-plate, .mt-bs-core-title, .mt-bs-editbar") != null;
}

// The node a plate or the core's title stands for; null off them.
function nodeIdOf(target: EventTarget): string {
    const el = (target as Element)?.closest?.<HTMLElement>(".mt-bs-plate, .mt-bs-core-title");
    if (el == null || el.classList.contains("is-leaving")) {
        return null;
    }
    return el.dataset.nodeId || null;
}

// The outline has one stop for Tab: the node last walked to, else the centre (a roving focus).
function rove(plates: HTMLElement, id: string): void {
    if (plates == null) {
        return;
    }
    let found = false;
    for (const el of Array.from(plates.querySelectorAll<HTMLElement>("[role='listitem']"))) {
        const mine = el.dataset.nodeId === id;
        el.tabIndex = mine ? 0 : -1;
        found ||= mine;
    }
    if (!found) {
        plates.querySelector<HTMLElement>(".mt-bs-core-title[role='listitem']")?.setAttribute("tabindex", "0");
    }
}

// A gesture read by the camera model, on the scene; `at` is the pointer's place on the stage for a zoom about it.
function apply(scene: BrainstormScene, action: NavAction, at: { x: number; y: number } = null): void {
    if (scene == null || action == null) {
        return;
    }
    switch (action.kind) {
        case "pan":
            scene.pan(action.dx, action.dy);
            return;
        case "zoom":
            if (at != null) {
                scene.zoomAt(action.factor, at.x, at.y);
            } else {
                scene.zoomStep(action.factor);
            }
            return;
        case "recentre":
            scene.recentre();
            return;
    }
}

type Drag = { id: number; x: number; y: number; lastX: number; lastY: number; panning: boolean };

export function BrainstormStage({ graph }: { graph: BrainstormGraph }) {
    const t = useT();
    const locale = useLocale();
    const model = BrainstormModel.getInstance();
    const still = useAtomValue(atoms.prefersReducedMotionAtom, { store: globalStore });
    const talkAt = useAtomValue(model.talkAtAtom, { store: globalStore });
    const cameraAsk = useAtomValue(model.cameraAskAtom, { store: globalStore });
    const editing = useAtomValue(model.editingAtom, { store: globalStore });
    const linking = useAtomValue(model.linkingAtom, { store: globalStore });
    // The node the keyboard last walked to: the outline's one stop for Tab.
    const roverRef = useRef<string>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const platesRef = useRef<HTMLDivElement>(null);
    const sceneRef = useRef<BrainstormScene>(null);
    const dragRef = useRef<Drag>(null);
    // The header's asks made before this stage mounted are not this stage's.
    const askSeenRef = useRef(globalStore.get(model.cameraAskAtom)?.seq ?? 0);
    const tRef = useRef(t);
    tRef.current = t;
    const [ready, setReady] = useState(false);
    const [fading, setFading] = useState(0);
    const [panning, setPanning] = useState(false);

    useEffect(() => {
        let live = true;
        let scene: BrainstormScene = null;
        let observer: ResizeObserver = null;
        let stopFollow: () => void = null;
        void import("./brainstorm-scene")
            .then((mod) => {
                const stage = stageRef.current;
                if (!live || stage == null || canvasRef.current == null || platesRef.current == null) {
                    return;
                }
                try {
                    scene = mod.makeBrainstormScene({
                        canvas: canvasRef.current,
                        plates: platesRef.current,
                        kindLabel: (kind: NodeKind) => tRef.current(`boss.brainstorm.kinds.${kind}`),
                        gripLabel: (text: string) => tRef.current("boss.brainstorm.plate.menu", { text }),
                        onCrossFade: () => setFading((n) => n + 1),
                        onCameraMode: (mode) => {
                            globalStore.set(model.cameraModeAtom, mode);
                            if (mode !== "free") {
                                globalStore.set(model.followPulseAtom, 0);
                            }
                        },
                        onFollowPulse: () => globalStore.set(model.followPulseAtom, (n) => n + 1),
                    });
                } catch (e) {
                    // No WebGL: the stage stays empty and the conversation goes on (the flat view is #2247's).
                    console.log("brainstorm: the 3D scene could not start", e);
                    return;
                }
                sceneRef.current = scene;
                const resize = () => {
                    const box = stage.getBoundingClientRect();
                    scene.setSize(box.width, box.height);
                    placeFree(stage, scene);
                };
                resize();
                if (typeof ResizeObserver !== "undefined") {
                    observer = new ResizeObserver(resize);
                    observer.observe(stage);
                }
                // What opened from his group changes the free space (his conversation window grows with the talk).
                stopFollow = TabActivity.getInstance().every(
                    whileShown(FreeSpaceEveryMs),
                    () => placeFree(stage, scene),
                    "brainstorm-free-space"
                );
                scene.start();
                setReady(true);
            })
            .catch((e) => console.log("brainstorm: the 3D scene could not be loaded", e));
        return () => {
            live = false;
            stopFollow?.();
            observer?.disconnect();
            scene?.dispose();
            sceneRef.current = null;
            // The next stage starts with Brokk holding the camera: no Follow Brokk chip left from this one.
            globalStore.set(model.cameraModeAtom, "overview");
            globalStore.set(model.followPulseAtom, 0);
            // An edit or a link left open belongs to this stage's plates.
            model.cancelEdit();
            model.cancelLink();
        };
    }, []);

    // The wheel and the pinch: a listener that may prevent the page's own scroll and zoom (React's is passive).
    useEffect(() => {
        const stage = stageRef.current;
        if (stage == null) {
            return;
        }
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const box = stage.getBoundingClientRect();
            apply(sceneRef.current, readWheel(e, box.height), { x: e.clientX - box.left, y: e.clientY - box.top });
        };
        stage.addEventListener("wheel", onWheel, { passive: false });
        return () => stage.removeEventListener("wheel", onWheel);
    }, []);

    useEffect(() => {
        if (cameraAsk == null || cameraAsk.seq <= askSeenRef.current || sceneRef.current == null) {
            return;
        }
        askSeenRef.current = cameraAsk.seq;
        if (cameraAsk.kind === "recentre") {
            sceneRef.current.recentre();
        } else {
            sceneRef.current.followBrokk();
        }
    }, [cameraAsk, ready]);

    useEffect(() => {
        sceneRef.current?.setStill(still);
    }, [still, ready]);

    useEffect(() => {
        // The history of the same state says which plates a merge folded, and whose change it was (#2247).
        sceneRef.current?.setGraph(graph, Date.now(), globalStore.get(model.stateAtom)?.history ?? null);
        rove(platesRef.current, roverRef.current);
    }, [graph, ready]);

    // Edit text (AC27): the plate's text becomes editable in place; its end saves or cancels through the model.
    useEffect(() => {
        if (editing == null || sceneRef.current == null) {
            return;
        }
        sceneRef.current.beginEdit(editing, (text) => {
            if (text == null) {
                model.cancelEdit();
                return;
            }
            void model.saveText(editing, text);
        });
    }, [editing, ready]);

    // Link to… marks the plate it starts from.
    useEffect(() => {
        const plates = platesRef.current;
        if (plates == null) {
            return;
        }
        plates.querySelectorAll(".is-link-source").forEach((el) => el.classList.remove("is-link-source"));
        if (linking != null) {
            sceneRef.current?.nodeElement(linking)?.classList.add("is-link-source");
        }
    }, [linking, ready]);

    useEffect(() => {
        sceneRef.current?.talked(talkAt);
    }, [talkAt, ready]);

    useEffect(() => {
        sceneRef.current?.relabel();
    }, [locale, ready]);

    useLayoutEffect(() => {
        if (fading === 0) {
            return;
        }
        const timer = window.setTimeout(() => stageRef.current?.classList.remove("is-fading"), CrossFadeMs);
        stageRef.current?.classList.add("is-fading");
        return () => window.clearTimeout(timer);
    }, [fading]);

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!pressPans(e.button, onPlate(e.target))) {
            return;
        }
        if (e.button === 1) {
            // The middle button's own scroll mode would take the drag.
            e.preventDefault();
        }
        dragRef.current = {
            id: e.pointerId,
            x: e.clientX,
            y: e.clientY,
            lastX: e.clientX,
            lastY: e.clientY,
            panning: false,
        };
    };

    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (drag == null || drag.id !== e.pointerId) {
            return;
        }
        if (!drag.panning) {
            if (!dragStarted(e.clientX - drag.x, e.clientY - drag.y)) {
                return;
            }
            drag.panning = true;
            e.currentTarget.setPointerCapture?.(e.pointerId);
            setPanning(true);
        }
        sceneRef.current?.pan(e.clientX - drag.lastX, e.clientY - drag.lastY);
        drag.lastX = e.clientX;
        drag.lastY = e.clientY;
    };

    const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
        if (dragRef.current?.id !== e.pointerId) {
            return;
        }
        dragRef.current = null;
        setPanning(false);
        if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
        }
    };

    // The node's element takes the focus, and becomes the outline's stop for Tab.
    const focusPlate = (id: string) => {
        const el = sceneRef.current?.nodeElement(id);
        if (el == null) {
            return;
        }
        roverRef.current = id;
        rove(platesRef.current, id);
        el.focus({ preventScroll: true });
    };

    const nodeOf = (id: string) => {
        const graph = globalStore.get(model.stateAtom)?.graph;
        return { graph, node: graph?.nodes?.find((n) => n.id === id) ?? null };
    };

    // A click on a plate: its handle opens its menu; while Link to… waits it ties the two; otherwise it focuses the node.
    const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
        const id = nodeIdOf(e.target);
        const linkingNow = globalStore.get(model.linkingAtom);
        if (id == null) {
            if (linkingNow != null && !(e.target as Element)?.closest?.(".mt-bs-editbar")) {
                model.cancelLink();
            }
            return;
        }
        if ((e.target as Element)?.closest?.(".mt-bs-plate-grip") != null) {
            if (openPlateMenu(id, e)) {
                roverRef.current = id;
                rove(platesRef.current, id);
            }
            return;
        }
        if (globalStore.get(model.editingAtom) === id) {
            return;
        }
        if (linkingNow != null) {
            void model.linkTo(id);
            return;
        }
        focusPlate(id);
        sceneRef.current?.focusNode(id);
    };

    // A right-click on a plate, or the menu key while it has the focus (the menu host turns it into this event).
    const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
        const id = nodeIdOf(e.target);
        if (id == null || globalStore.get(model.editingAtom) === id) {
            return;
        }
        if (openPlateMenu(id, e)) {
            roverRef.current = id;
            rove(platesRef.current, id);
        }
    };

    const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
        const id = nodeIdOf(e.target);
        if (id != null) {
            const { graph, node } = nodeOf(id);
            if (plateMenuOf(node, graph?.centre ?? "")?.edit) {
                model.startEdit(id);
            }
            return;
        }
        if (onPlate(e.target)) {
            return;
        }
        sceneRef.current?.recentre();
    };

    // A key on a focused plate: the arrows, Home and End walk the outline (AC20), Enter focuses the node (or finishes
    // Link to…), F2 edits its text, Delete removes it and gives the focus to its parent. True when the key was the plate's.
    const plateKey = (e: React.KeyboardEvent<HTMLDivElement>, id: string): boolean => {
        const { graph, node } = nodeOf(id);
        const next = outlineStep(graph?.nodes, graph?.centre ?? "", id, e.key);
        if (next != null) {
            e.preventDefault();
            e.stopPropagation();
            focusPlate(next);
            sceneRef.current?.revealNode(next);
            return true;
        }
        const menu = plateMenuOf(node, graph?.centre ?? "");
        if (e.key === "Enter") {
            if (globalStore.get(model.linkingAtom) != null) {
                void model.linkTo(id);
            } else {
                sceneRef.current?.focusNode(id);
            }
        } else if (e.key === "F2" && menu?.edit) {
            model.startEdit(id);
        } else if ((e.key === "Delete" || e.key === "Backspace") && menu?.remove) {
            void model.remove(id).then((removed) => removed && focusPlate(node.from));
        } else {
            return false;
        }
        e.preventDefault();
        e.stopPropagation();
        return true;
    };

    // Escape is not read here: it goes on to his group, which ends the brainstorm (Link to… takes it first, in its bar).
    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.nativeEvent.isComposing) {
            return;
        }
        if (isUndoKey(e)) {
            e.preventDefault();
            e.stopPropagation();
            void model.undoLast();
            return;
        }
        const id = e.altKey || e.ctrlKey || e.metaKey ? null : nodeIdOf(e.target);
        if (id != null && plateKey(e, id)) {
            return;
        }
        const action = readKey(e);
        if (action == null) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        apply(sceneRef.current, action);
    };

    return (
        <div
            ref={stageRef}
            className={cn("mt-bs-stage", ready && "is-ready", panning && "is-panning", linking != null && "is-linking")}
            data-testid="brainstorm-stage"
            tabIndex={0}
            role="group"
            aria-label={t("boss.brainstorm.stageLabel")}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            onClick={onClick}
            onContextMenu={onContextMenu}
            onDoubleClick={onDoubleClick}
            onKeyDown={onKeyDown}
        >
            <canvas ref={canvasRef} className="mt-bs-canvas" aria-hidden data-testid="brainstorm-canvas" />
            <div
                ref={platesRef}
                className="mt-bs-plates"
                role="list"
                aria-label={t("boss.brainstorm.graphLabel")}
                data-testid="brainstorm-plates"
            />
            <BrainstormEditBar />
        </div>
    );
}
