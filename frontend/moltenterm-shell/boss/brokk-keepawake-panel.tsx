// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Garder éveillé panel of Brokk's group (FR-BOSS-009, AC10, AC19 and AC44 to AC47, #2032, #2089). It leads with the
// real state: whether this computer is kept awake and what by, mode by mode, whatever the switches say. Under it, the
// two ways to turn keep-awake on, Manual (until the developer turns it off, for the workspace the window shows) and
// Automatic (whenever an agent works anywhere), as independent switches that each say what they do. Then the reasons
// with the Show and Stop of the cup's menu, and the link to Preferences › Energy, where how keep-awake behaves is set.
// The workspace's mark in the rail and the status bar's cup stay as they are; while Brokk is closed, the cup shows as a
// small mark on his title-bar face, from the same state as the first line.

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { cn, fireAndForget, makeIconClass } from "@/util/util";
import { useAtomValue } from "jotai";
import { useT } from "../i18n/i18n";
import { HoldRow } from "../keepawake-cup";
import {
    AutomaticSetting,
    coffeeSupported,
    keepAwakeActive,
    keepAwakeCountLabel,
    keepAwakeHolds,
    keepAwakeStatus,
} from "../keepawake-model";
import { KeepAwakeModes } from "../keepawake-modes";
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
    const now = useNow(keepAwakeActive(state));
    const supported = coffeeSupported(platform);
    const holds = keepAwakeHolds(state, now);
    const status = keepAwakeStatus(state, now);
    const name = workspaceShownName(workspace?.name, t) || t("keepawake.thisWorkspace");
    return (
        <PanelFrame id="keepawake" title={t("boss.group.panels.keepawake")} onClose={onClose}>
            <div data-testid="brokk-keepawake" data-awake={status.awake ? "true" : "false"}>
                {supported ? (
                    <>
                        <div className="flex items-start gap-2 py-2" data-testid="brokk-keepawake-status">
                            <i
                                className={cn(
                                    makeIconClass("mug-hot", true),
                                    "mt-[3px] w-3 text-center text-11",
                                    status.awake ? "text-[var(--color-awake)]" : "text-muted"
                                )}
                                aria-hidden
                            />
                            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span
                                    className={cn("text-12", status.awake ? "text-primary" : "text-muted")}
                                    data-testid="brokk-keepawake-state"
                                >
                                    {status.headline}
                                </span>
                                <span className="text-11 text-muted" data-testid="brokk-keepawake-cause">
                                    {status.cause}
                                </span>
                            </span>
                        </div>
                        <div className="border-t border-line">
                            <KeepAwakeModes state={state} workspaceId={workspace?.oid} name={name} />
                        </div>
                        {holds.length > 0 ? (
                            <div className="border-t border-line py-2" data-testid="brokk-keepawake-reason">
                                <div className="text-11 text-muted">{t("boss.group.keepAwake.reason")}</div>
                                <ul
                                    className="mt-1 flex flex-col gap-1"
                                    aria-label={keepAwakeCountLabel(holds.length)}
                                    data-testid="brokk-keepawake-holds"
                                >
                                    {holds.map((hold) => (
                                        <HoldRow key={hold.key} hold={hold} onClose={onLeave} />
                                    ))}
                                </ul>
                            </div>
                        ) : null}
                        <div className="border-t border-line py-2">
                            <button
                                type="button"
                                data-testid="brokk-keepawake-more"
                                className="cursor-pointer text-11 text-muted hover:text-primary"
                                onClick={() => {
                                    onLeave();
                                    fireAndForget(() => openSettingsKey("general", AutomaticSetting));
                                }}
                            >
                                {t("keepawake.popover.moreSettings")}
                            </button>
                        </div>
                    </>
                ) : (
                    <div className="py-3 text-12 text-muted" data-testid="brokk-keepawake-unsupported">
                        {t("boss.group.keepAwake.unsupported")}
                    </div>
                )}
            </div>
        </PanelFrame>
    );
}
