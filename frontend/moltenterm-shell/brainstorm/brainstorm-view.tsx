// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the brainstorm layer shows (FR-BOSS-010 AC2 to AC4, AC9, AC17, DS-BOSS-011, #2246): a forge-dark scrim dims the
// window under Brokk's group (the group stands above it, untouched), the forge glows at the bottom with its embers, and
// his thought grows in 3D in the free space. A small plate says the brainstorm is saved, and when; another line at the
// edge says what was critical enough to break through the pause. The app stays visible underneath: it is a layer, not a
// screen.
//
// It loads on demand, the first time the mode opens (brainstorm-layer.tsx): a window that never brainstorms carries
// none of it, and the 3D scene comes later still, behind the stage's own import().

import { globalStore } from "@/app/store/jotaiStore";
import { cn, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { BossBubbleModel } from "../boss/boss-store";
import { tCount, useLocale, useT } from "../i18n/i18n";
import { BrainstormStage } from "./brainstorm-stage";
import { BrainstormModel, BrainstormState } from "./brainstorm-store";
import "./brainstorm.css";

function savedTime(at: number, locale: string): string {
    try {
        return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(at));
    } catch {
        return new Date(at).toLocaleTimeString();
    }
}

function SavedPlate({ state }: { state: BrainstormState }) {
    const t = useT();
    const locale = useLocale();
    const brainstorm = state.brainstorm;
    let line: string;
    let tone = "ok";
    // A brainstorm resumed after a restart was saved when it last changed.
    const savedAt = state.savedat || brainstorm?.updated || 0;
    if (state.saveerror) {
        line = t("boss.brainstorm.saved.failed");
        tone = "failed";
    } else if (brainstorm == null || !savedAt) {
        line = t("boss.brainstorm.saved.nothing");
        tone = "waiting";
    } else {
        line = t("boss.brainstorm.saved.at", { time: savedTime(savedAt, locale) });
    }
    return (
        <div className="mt-bs-saved" role="status" data-testid="brainstorm-saved" data-tone={tone}>
            <div className="mt-bs-saved-head">
                <i className={makeIconClass("folder-open", false)} aria-hidden />
                {t("boss.brainstorm.saved.title")}
            </div>
            <div className="mt-bs-saved-line" data-testid="brainstorm-saved-line">
                {line}
            </div>
            {brainstorm != null ? (
                <div className="mt-bs-saved-folder" title={brainstorm.dir} data-testid="brainstorm-saved-folder">
                    {brainstorm.slug}/
                </div>
            ) : null}
            <div className="mt-bs-saved-hint">{t("boss.brainstorm.leaveHint")}</div>
        </div>
    );
}

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

// The header's Leave the brainstorm button (#2257).
export function leaveBrainstorm(): void {
    void BrainstormModel.getInstance().end();
}

// The line over the free space (the mockup's): his thought, how many nodes, how many cross-links.
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
    // The one way out with the pointer (#2257): a click on the dim never ends the brainstorm.
    return (
        <div className="mt-bs-header" data-testid="brainstorm-header">
            <button
                type="button"
                className="mt-bs-leave cursor-pointer"
                data-testid="brainstorm-leave"
                onClick={leaveBrainstorm}
            >
                <i className={makeIconClass("arrow-right-from-bracket", false)} aria-hidden />
                {t("boss.brainstorm.leave")}
            </button>
            <span className="mt-bs-header-text">{text}</span>
        </div>
    );
}

export function BrainstormView({ state, shown }: { state: BrainstormState; shown: boolean }) {
    return (
        <div className={cn("mt-bs-layer", shown && "is-in")} data-testid="brainstorm-layer">
            <div className="mt-bs-scrim" aria-hidden />
            <div className="mt-bs-forge" aria-hidden />
            <BrainstormStage graph={state.graph ?? null} />
            <Header state={state} />
            <SavedPlate state={state} />
            <Breakthrough />
        </div>
    );
}
