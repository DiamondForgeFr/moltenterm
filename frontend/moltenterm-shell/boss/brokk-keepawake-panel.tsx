// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Garder éveillé panel of Brokk's group (FR-BOSS-009, AC10 and AC19, #2032): the keep-awake line of #2003 opened out.
// The switch turns coffee mode on or off for the workspace the window shows, until its work ends, as the cup's click did.
// Under it, the reason: what keeps this computer awake now, with the Show and Stop of the cup's menu; then the sleep policy
// and the link to Preferences. The workspace's mark in the rail and the status bar's cup stay as they are; while Brokk is
// closed, the cup shows as a small mark on his title-bar face.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
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
import { PanelFrame } from "./brokk-panel-frame";

export function BrokkKeepAwakePanel({ onLeave, onClose }: { onLeave: () => void; onClose: () => void }) {
    const t = useT();
    const platform = usePlatform();
    const model = KeepAwakeModel.getInstance();
    const state = useAtomValue(model.stateAtom, { store: globalStore });
    const workspace = useAtomValue(atoms.workspace, { store: globalStore });
    const coffee = useAtomValue(model.coffeeAtom(workspace?.oid), { store: globalStore });
    const active = keepAwakeActive(state);
    const now = useNow(active);
    const supported = coffeeSupported(platform);
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
        <PanelFrame id="keepawake" title={t("boss.group.panels.keepawake")} onClose={onClose}>
            <div data-testid="brokk-keepawake" data-on={on ? "true" : "false"}>
                {supported ? (
                    <div className="flex items-center gap-2 py-2">
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
                            role="switch"
                            aria-checked={on}
                            aria-label={t("keepawake.coffeeFor", { name })}
                            data-testid="brokk-keepawake-switch"
                            className={cn(
                                "relative h-4 w-7 shrink-0 cursor-pointer rounded-full border transition-colors duration-120 ease-mt",
                                on ? "border-accent bg-accent/80" : "border-border bg-surface-2"
                            )}
                            onClick={toggle}
                        >
                            <span
                                className={cn(
                                    "absolute top-[1px] h-3 w-3 rounded-full bg-primary transition-[left] duration-120 ease-mt",
                                    on ? "left-[13px]" : "left-[1px]"
                                )}
                            />
                        </button>
                    </div>
                ) : (
                    <div className="py-3 text-12 text-muted" data-testid="brokk-keepawake-unsupported">
                        {t("boss.group.keepAwake.unsupported")}
                    </div>
                )}
                {supported ? (
                    <>
                        <div className="border-t border-line py-2" data-testid="brokk-keepawake-reason">
                            <div className="text-11 text-muted">{t("boss.group.keepAwake.reason")}</div>
                            {holds.length > 0 ? (
                                <ul
                                    className="mt-1 flex flex-col gap-1"
                                    aria-label={keepAwakeCountLabel(holds.length)}
                                    data-testid="brokk-keepawake-holds"
                                >
                                    {holds.map((hold) => (
                                        <HoldRow key={hold.key} hold={hold} onClose={onLeave} />
                                    ))}
                                </ul>
                            ) : (
                                <div className="mt-0.5 text-12 text-secondary" data-testid="brokk-keepawake-noreason">
                                    {t("boss.group.keepAwake.noReason")}
                                </div>
                            )}
                        </div>
                        <div
                            className="border-t border-line py-2 text-12 text-secondary"
                            data-testid="brokk-keepawake-until"
                        >
                            {t("boss.group.keepAwake.until")}
                        </div>
                        <div className="border-t border-line py-2">
                            <PolicyChoices />
                            <button
                                type="button"
                                data-testid="brokk-keepawake-more"
                                className="mt-2 cursor-pointer text-11 text-muted hover:text-primary"
                                onClick={() => {
                                    onLeave();
                                    fireAndForget(() => openSettingsKey("general", SleepPolicySetting));
                                }}
                            >
                                {t("keepawake.popover.moreSettings")}
                            </button>
                        </div>
                    </>
                ) : null}
            </div>
        </PanelFrame>
    );
}
