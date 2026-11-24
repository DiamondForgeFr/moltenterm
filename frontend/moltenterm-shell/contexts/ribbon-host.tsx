// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The window's ribbon with its menu (FR-SHELL-159, #2476): one component in both sidebar modes. Shown, it sits in the
// sidebar's bottom area, unrolled, and its menu opens upward; collapsed, it comes out of the window's left edge rolled
// up, and its menu opens downward. A click, Enter or Space opens the menu of ribbons.

import { atoms, getSettingsKeyAtom } from "@/app/store/global";
import { fireAndForget } from "@/util/util";
import { atom, useAtomValue, useSetAtom, type PrimitiveAtom } from "jotai";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { workspaceColourStops } from "../accent";
import { AgentStates } from "../agent-state-store";
import { useT, useTCount } from "../i18n/i18n";
import { SidebarHeatSettingKey } from "../sidebar/sidebar-heat";
import type { WorkspaceRailEntry } from "../workspace-rail-model";
import { showToast } from "../toast-store";
import { chooseContext, openContextInNewWindow } from "./context-actions";
import { ContextRibbon, contextIdOf, makeRibbons, shapeSubjects, waitingElsewhere } from "./context-model";
import { assignContextShapes, useContexts } from "./context-store";
import { RibbonButton } from "./ribbon";
import {
    ribbonHeatLevel,
    ribbonLabel,
    waitingAgentsIn,
    windowRibbonPaint,
    workingAgentsIn,
} from "./ribbon-model";
import { isShapeId, shapesToAssign, type ShapeSubject } from "./ribbon-shapes";

// The menu is its own chunk, loaded the first time the ribbon is clicked (NFR-PERF-003).
const RibbonMenu = lazy(() => import("./ribbon-menu").then((m) => ({ default: m.RibbonMenu })));

// Whether the Manage contexts dialog is open (manage-contexts.tsx hosts it once per window).
export const ManageContextsOpenAtom = atom(false) as PrimitiveAtom<boolean>;

export type RibbonMode = "sidebar" | "collapsed";

// Contexts stored before shapes existed get theirs once (FR-SHELL-159): the first keeps the V point and the others draw
// distinct ones. Every window may ask at start; wavesrv keeps the first answer for each context, so they agree. Asked
// once for each list of contexts that lack one, so a refusal never loops.
function useShapeMigration(subjects: readonly ShapeSubject[]) {
    const asked = useRef("");
    useEffect(() => {
        const missing = subjects.filter((s) => !isShapeId(s.context.shape ?? "")).map((s) => s.context.id);
        const key = missing.join(",");
        if (subjects.length < 2 || missing.length === 0 || asked.current === key) {
            return;
        }
        asked.current = key;
        fireAndForget(async () => {
            try {
                await assignContextShapes(shapesToAssign(subjects));
            } catch (e) {
                console.log("contexts: giving the ribbons their shapes", e);
            }
        });
    }, [subjects]);
}

export function ContextRibbonHost({ mode, entries }: { mode: RibbonMode; entries: WorkspaceRailEntry[] }) {
    const t = useT();
    const tc = useTCount();
    const contexts = useContexts();
    const ws = useAtomValue(atoms.workspace);
    const agents = useAtomValue(AgentStates.getInstance().dataAtom);
    const heatSetting = useAtomValue(getSettingsKeyAtom(SidebarHeatSettingKey));
    const openManage = useSetAtom(ManageContextsOpenAtom);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const currentId = contextIdOf(contexts, ws?.meta);
    const ribbons = useMemo(
        () =>
            makeRibbons(
                contexts,
                entries,
                currentId,
                (id) => waitingAgentsIn(agents, id),
                t,
                (id) => workingAgentsIn(agents, id)
            ),
        [contexts, entries, currentId, agents, t]
    );
    const subjects = useMemo(() => shapeSubjects(contexts, entries), [contexts, entries]);
    useShapeMigration(subjects);
    const current = ribbons.find((r) => r.here) ?? ribbons[0];
    const waiting = waitingElsewhere(ribbons);
    const { paint, ink } = windowRibbonPaint(workspaceColourStops(ws));
    // The reflection belongs to the sidebar's heat: with that setting off, no light is drawn on the ribbon.
    const heat = heatSetting === false ? 0 : ribbonHeatLevel(current?.working ?? 0);

    const close = useCallback((restoreFocus: boolean) => {
        setOpen(false);
        if (restoreFocus) {
            buttonRef.current?.focus();
        }
    }, []);
    const fail = (e: unknown) => {
        console.log("contexts:", e);
        showToast({
            id: "contexts-failed",
            kind: "error",
            title: t("contexts.menu.failed", { error: e instanceof Error ? e.message : String(e) }),
        });
    };
    const onChoose = (ribbon: ContextRibbon) => {
        close(false);
        fireAndForget(async () => {
            try {
                await chooseContext(ribbon);
            } catch (e) {
                fail(e);
            }
        });
    };
    const onOpenInWindow = (ribbon: ContextRibbon) => {
        close(false);
        fireAndForget(async () => {
            try {
                await openContextInNewWindow(ribbon.context.id, entries, ribbon.context.last ?? "");
            } catch (e) {
                fail(e);
            }
        });
    };

    if (current == null) {
        return null;
    }
    return (
        <>
            <RibbonButton
                ref={buttonRef}
                rolled={mode === "collapsed"}
                open={open}
                emblem={current.emblem}
                name={current.name}
                paint={paint}
                ink={ink}
                shape={current.shape}
                waiting={waiting}
                heat={heat}
                label={ribbonLabel(current.name, waiting, t, tc)}
                title={t("contexts.ribbon.title", { name: current.name })}
                onClick={() => setOpen((v) => !v)}
            />
            {open && buttonRef.current != null ? (
                <Suspense fallback={null}>
                    <RibbonMenu
                        anchor={buttonRef.current}
                        placement={mode === "collapsed" ? "bottom-start" : "top-start"}
                        ribbons={ribbons}
                        onChoose={onChoose}
                        onOpenInWindow={onOpenInWindow}
                        onManage={() => {
                            close(false);
                            openManage(true);
                        }}
                        onClose={close}
                    />
                </Suspense>
            ) : null}
        </>
    );
}
