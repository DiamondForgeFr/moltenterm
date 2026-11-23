// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The window's ribbon with its menu (FR-SHELL-159, #2476): one component in both sidebar modes. Shown, it sits in the
// sidebar's bottom area, unrolled, and its menu opens upward; collapsed, it comes out of the window's left edge rolled
// up, and its menu opens downward. A click, Enter or Space opens the menu of ribbons.

import { atoms } from "@/app/store/global";
import { fireAndForget } from "@/util/util";
import { atom, useAtomValue, useSetAtom, type PrimitiveAtom } from "jotai";
import { lazy, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { AgentStates } from "../agent-state-store";
import { useT, useTCount } from "../i18n/i18n";
import type { WorkspaceRailEntry } from "../workspace-rail-model";
import { showToast } from "../toast-store";
import { chooseContext, openContextInNewWindow } from "./context-actions";
import { ContextRibbon, contextIdOf, waitingElsewhere, makeRibbons } from "./context-model";
import { useContexts } from "./context-store";
import { RibbonButton } from "./ribbon";
import { ribbonLabel, ribbonPaint, waitingAgentsIn } from "./ribbon-model";

// The menu is its own chunk, loaded the first time the ribbon is clicked (NFR-PERF-003).
const RibbonMenu = lazy(() => import("./ribbon-menu").then((m) => ({ default: m.RibbonMenu })));

// Whether the Manage contexts dialog is open (manage-contexts.tsx hosts it once per window).
export const ManageContextsOpenAtom = atom(false) as PrimitiveAtom<boolean>;

export type RibbonMode = "sidebar" | "collapsed";

export function ContextRibbonHost({ mode, entries }: { mode: RibbonMode; entries: WorkspaceRailEntry[] }) {
    const t = useT();
    const tc = useTCount();
    const contexts = useContexts();
    const ws = useAtomValue(atoms.workspace);
    const agents = useAtomValue(AgentStates.getInstance().dataAtom);
    const openManage = useSetAtom(ManageContextsOpenAtom);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const currentId = contextIdOf(contexts, ws?.meta);
    const ribbons = useMemo(
        () => makeRibbons(contexts, entries, currentId, (id) => waitingAgentsIn(agents, id), t),
        [contexts, entries, currentId, agents, t]
    );
    const current = ribbons.find((r) => r.here) ?? ribbons[0];
    const waiting = waitingElsewhere(ribbons);
    const { paint, ink } = ribbonPaint(ws?.color ?? "");

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
                waiting={waiting}
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
