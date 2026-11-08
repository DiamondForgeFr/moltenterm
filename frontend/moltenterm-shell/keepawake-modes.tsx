// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The two ways to turn keep-awake on, as two independent switches (FR-SHELL-023 AC14, FR-BOSS-009 AC45, #2089). Manual
// keeps this computer awake for the workspace the window shows until the developer turns it off; Automatic keeps it
// awake whenever an agent works anywhere. Brokk's panel and the status bar cup's menu draw them the same way, under the
// line that says whether the computer is kept awake, never above it.

import { cn, fireAndForget } from "@/util/util";
import { useId } from "react";
import { useT } from "./i18n/i18n";
import { coffeeOf, KeepAwakeState } from "./keepawake-model";
import { KeepAwakeModel } from "./keepawake-store";

function ModeRow({
    label,
    hint,
    on,
    mode,
    onToggle,
    className,
}: {
    label: string;
    hint: string;
    on: boolean;
    mode: "manual" | "automatic";
    onToggle: () => void;
    className?: string;
}) {
    const hintId = useId();
    return (
        <div className={cn("flex items-center gap-2 py-2", className)} data-testid={`keepawake-mode-${mode}`}>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-12 text-primary">{label}</span>
                <span id={hintId} className="text-11 text-muted">
                    {hint}
                </span>
            </span>
            <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={label}
                aria-describedby={hintId}
                data-testid={`keepawake-switch-${mode}`}
                className={cn(
                    "relative h-4 w-7 shrink-0 cursor-pointer rounded-full border transition-colors duration-120 ease-mt",
                    on ? "border-accent bg-accent/80" : "border-border bg-surface-2"
                )}
                onClick={onToggle}
            >
                <span
                    className={cn(
                        "absolute top-[1px] h-3 w-3 rounded-full bg-primary transition-[left] duration-120 ease-mt",
                        on ? "left-[13px]" : "left-[1px]"
                    )}
                />
            </button>
        </div>
    );
}

export function KeepAwakeModes({
    state,
    workspaceId,
    name,
    rowClass,
}: {
    state: KeepAwakeState;
    workspaceId: string;
    name: string;
    // Added to both rows: the padding the surface wants.
    rowClass?: string;
}) {
    const t = useT();
    const manualOn = workspaceId != null && coffeeOf(state, workspaceId) != null;
    const toggleManual = () => {
        if (workspaceId == null) {
            return;
        }
        fireAndForget(async () => {
            try {
                await KeepAwakeModel.getInstance().setCoffee(workspaceId, !manualOn);
            } catch (err) {
                console.log("keep-awake manual:", err);
            }
        });
    };
    const toggleAutomatic = () => {
        fireAndForget(async () => {
            try {
                await KeepAwakeModel.getInstance().setAutomatic(!state.automatic);
            } catch (err) {
                console.log("keep-awake automatic:", err);
            }
        });
    };
    return (
        <div
            data-testid="keepawake-modes"
            data-manual={manualOn ? "on" : "off"}
            data-automatic={state.automatic ? "on" : "off"}
        >
            <ModeRow
                mode="manual"
                label={t("keepawake.mode.manual")}
                hint={t("keepawake.mode.manualHint", { name })}
                on={manualOn}
                onToggle={toggleManual}
                className={rowClass}
            />
            <ModeRow
                mode="automatic"
                label={t("keepawake.mode.automatic")}
                hint={t("keepawake.mode.automaticHint")}
                on={state.automatic}
                onToggle={toggleAutomatic}
                className={cn("border-t border-line", rowClass)}
            />
        </div>
    );
}
