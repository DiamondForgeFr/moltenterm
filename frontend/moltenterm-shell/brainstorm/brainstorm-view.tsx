// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the brainstorm layer shows (FR-BOSS-010 AC2 to AC4, AC17, DS-BOSS-011, #2246): a forge-dark scrim dims the
// window under Brokk's group (the group stands above it, in its brainstorm layout), the forge glows at the bottom with
// its embers, and his thought grows in 3D in the free space. A line at the edge says what was critical enough to break
// through the pause. Where the brainstorm is saved, the others and Leave are in the brainstorm panel of his group
// (brainstorm-panel.tsx, AC23, #2285). Once he concluded, the project card stands at the free space's bottom right
// (brainstorm-project.tsx, AC15, #2250). The app stays visible underneath: it is a layer, not a screen.
//
// It loads on demand, the first time the mode opens (brainstorm-layer.tsx): a window that never brainstorms carries
// none of it, and the 3D scene comes later still, behind the stage's own import().

import { globalStore } from "@/app/store/jotaiStore";
import { cn, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { BossBubbleModel } from "../boss/boss-store";
import { tCount, useLocale, useT } from "../i18n/i18n";
import { ProjectCard } from "./brainstorm-project";
import { BrainstormStage } from "./brainstorm-stage";
import { BrainstormModel, BrainstormState } from "./brainstorm-store";
import "./brainstorm.css";

function Breakthrough() {
    const t = useT();
    const model = BrainstormModel.getInstance();
    const breakthrough = useAtomValue(model.breakthroughAtom, { store: globalStore });
    if (breakthrough == null) {
        return null;
    }
    return (
        <div className="mt-bs-edge" role="alert" data-kind={breakthrough.kind} data-testid="brainstorm-edge">
            <i
                className={makeIconClass(
                    breakthrough.kind === "trust" ? "shield-halved" : "triangle-exclamation",
                    false
                )}
                aria-hidden
            />
            <span className="mt-bs-edge-text">{breakthrough.text}</span>
            <button
                type="button"
                className="mt-bs-edge-go cursor-pointer"
                onClick={() => BossBubbleModel.getInstance().showPanel("notifications")}
            >
                {t("boss.brainstorm.edgeShow")}
            </button>
        </div>
    );
}

// The header's Recentre: the whole graph framed, the camera kept by the developer (#2283).
export function recentreBrainstorm(): void {
    BrainstormModel.getInstance().askCamera("recentre");
}

// The Follow Brokk chip: the camera goes back to him (#2283).
export function followBrokk(): void {
    BrainstormModel.getInstance().askCamera("follow");
}

// Shown while the developer holds the camera; it pulses once when Brokk adds a plate out of view after a quiet stretch
// (the glow is a child remade for each pulse, so the button keeps its focus).
function FollowChip({ name }: { name: string }) {
    const t = useT();
    const pulse = useAtomValue(BrainstormModel.getInstance().followPulseAtom, { store: globalStore });
    return (
        <button
            type="button"
            className="mt-bs-follow cursor-pointer"
            data-testid="brainstorm-follow"
            title={t("boss.brainstorm.followTitle", { name })}
            onClick={followBrokk}
        >
            <span
                key={pulse}
                className={cn("mt-bs-follow-glow", pulse > 0 && "is-pulsing")}
                aria-hidden
                data-testid="brainstorm-follow-glow"
            />
            <i className={makeIconClass("location-arrow", false)} aria-hidden />
            {t("boss.brainstorm.follow", { name })}
        </button>
    );
}

// The line over the free space (the mockup's): his thought, how many nodes, how many cross-links, then Recentre and the
// Follow Brokk chip (#2283). Leave the brainstorm and the switch to another one are in the brainstorm panel of his group
// (AC23, #2285).
function Header({ state }: { state: BrainstormState }) {
    const t = useT();
    useLocale();
    const name = useAtomValue(BossBubbleModel.getInstance().nameAtom, { store: globalStore });
    const camera = useAtomValue(BrainstormModel.getInstance().cameraModeAtom, { store: globalStore });
    const nodes = state.graph?.nodes?.length ?? 0;
    const links = state.graph?.links?.length ?? 0;
    const text =
        nodes === 0
            ? t("boss.brainstorm.headerWaiting", { name })
            : t("boss.brainstorm.header", {
                  name,
                  nodes: tCount("boss.brainstorm.nodes", nodes),
                  links: tCount("boss.brainstorm.links", links),
                  camera: t(`boss.brainstorm.camera.${camera}`),
              });
    return (
        <div className="mt-bs-header" data-testid="brainstorm-header">
            <span className="mt-bs-header-text">{text}</span>
            {nodes > 0 ? (
                <button
                    type="button"
                    className="mt-bs-leave mt-bs-recentre cursor-pointer"
                    data-testid="brainstorm-recentre"
                    title={t("boss.brainstorm.recentreTitle")}
                    onClick={recentreBrainstorm}
                >
                    <i className={makeIconClass("crosshairs", false)} aria-hidden />
                    {t("boss.brainstorm.recentre")}
                </button>
            ) : null}
            {camera === "free" ? <FollowChip name={name} /> : null}
        </div>
    );
}

export function BrainstormView({ state, shown }: { state: BrainstormState; shown: boolean }) {
    // A move to another brainstorm starts the stage over: its scene shows the graph as it stands and its overview.
    return (
        <div className={cn("mt-bs-layer", shown && "is-in")} data-testid="brainstorm-layer">
            <div className="mt-bs-scrim" aria-hidden />
            <div className="mt-bs-forge" aria-hidden />
            <BrainstormStage key={state.swap ?? 0} graph={state.graph ?? null} />
            <Header state={state} />
            <Breakthrough />
            <ProjectCard state={state} />
        </div>
    );
}
