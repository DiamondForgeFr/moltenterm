// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The keep-awake line of Brokk's panel (FR-BOSS-009, AC9 and AC10, #2003): it replaces the cup of the window row. The
// switch turns coffee mode on or off for the workspace the window shows, until its work ends, as the cup's click did.
// Under it, on demand, what keeps this computer awake now with the Show and Stop of the cup's menu, the sleep policy and
// the link to Preferences. The workspace's mark in the rail and the status bar's cup stay as they are.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { useState } from "react";
import { useT } from "../i18n/i18n";
import { HoldRow, PolicyChoices } from "../keepawake-cup";
import {
    coffeeSupported,
    keepAwakeActive,
    keepAwakeCountLabel,
    keepAwakeHolds,
    SleepPolicySetting,
} from "../keepawake-model";
import { KeepAwakeModel } from "../keepawake-store";
import { useNow, usePlatform } from "../keepawake-ui";
import { openSettingsKey } from "../settings/settings-open";
import { workspaceShownName } from "../workspace-default-name";

export function BrokkKeepAwakeLine({ onLeave }: { onLeave: () => void }) {
    const t = useT();
    const platform = usePlatform();
    const model = KeepAwakeModel.getInstance();
    const state = useAtomValue(model.stateAtom, { store: globalStore });
    const workspace = useAtomValue(atoms.workspace, { store: globalStore });
    const coffee = useAtomValue(model.coffeeAtom(workspace?.oid), { store: globalStore });
    const [open, setOpen] = useState(false);
    const active = keepAwakeActive(state);
    const now = useNow(active && open);
    if (!coffeeSupported(platform)) {
        return null;
    }
    const on = coffee != null;
    const holds = keepAwakeHolds(state, now);
    const name = workspaceShownName(workspace?.name, t) || t("keepawake.thisWorkspace");
    const toggle = () => {
        if (workspace?.oid == null) {
            return;
        }
        fireAndForget(async () => {
            try {
                await model.setCoffee(workspace.oid, !on);
            } catch (err) {
                console.log("keep-awake coffee:", err);
            }
        });
    };
    return (
        <div className="border-t border-line-strong" data-testid="brokk-keepawake" data-on={on ? "true" : "false"}>
            <div className="flex items-center gap-2 px-3 py-1.5">
                <i
                    className={cn(
                        makeIconClass("mug-hot", true),
                        "w-3 text-center text-11",
                        active ? "text-[var(--color-awake)]" : "text-muted"
                    )}
                    aria-hidden
                />
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-12 text-primary">{t("keepawake.coffeeFor", { name })}</span>
                    <span className="truncate text-11 text-muted" data-testid="brokk-keepawake-state">
                        {active ? keepAwakeCountLabel(holds.length) : t("keepawake.cupIdle")}
                    </span>
                </span>
                <button
                    type="button"
                    className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-6 text-11 text-muted hover:bg-hover hover:text-primary"
                    aria-expanded={open}
                    aria-label={t("boss.panel.keepAwake.details")}
                    title={t("boss.panel.keepAwake.details")}
                    data-testid="brokk-keepawake-details"
                    onClick={() => setOpen(!open)}
                >
                    <i className={makeIconClass(open ? "chevron-up" : "chevron-down", true)} aria-hidden />
                </button>
                <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={t("keepawake.coffeeFor", { name })}
                    data-testid="brokk-keepawake-switch"
                    className={cn(
                        "relative h-4 w-7 shrink-0 cursor-pointer rounded-full border transition-colors",
                        on ? "border-accent bg-accent/80" : "border-border bg-surface-2"
                    )}
                    onClick={toggle}
                >
                    <span
                        className={cn(
                            "absolute top-[1px] h-3 w-3 rounded-full bg-primary transition-[left]",
                            on ? "left-[13px]" : "left-[1px]"
                        )}
                    />
                </button>
            </div>
            {open ? (
                <div className="flex flex-col gap-2 pb-2" data-testid="brokk-keepawake-body">
                    {holds.length > 0 ? (
                        <ul className="flex flex-col gap-1 px-3" aria-label={keepAwakeCountLabel(holds.length)}>
                            {holds.map((hold) => (
                                <HoldRow key={hold.key} hold={hold} onClose={onLeave} />
                            ))}
                        </ul>
                    ) : null}
                    <PolicyChoices />
                    <div className="px-3">
                        <button
                            type="button"
                            data-testid="brokk-keepawake-more"
                            className="cursor-pointer text-11 text-muted hover:text-primary"
                            onClick={() => {
                                onLeave();
                                fireAndForget(() => openSettingsKey("general", SleepPolicySetting));
                            }}
                        >
                            {t("keepawake.popover.moreSettings")}
                        </button>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
