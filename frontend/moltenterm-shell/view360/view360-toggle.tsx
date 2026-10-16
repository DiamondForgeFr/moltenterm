// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The tab bar's "360" toggle (FR-SHELL-066, DS-SHELL-117, #733): it shows whether the tab on screen is in 360 view and
// what holds it on. A click turns the view on on demand, or leaves it: at once when every panel fits, after a
// confirmation when the sizes must be readjusted, never while the panels do not fit even at their readable minimums
// (a message says how many columns to close). A small "A" says the automatic decision holds the view on, and an
// automatic switch plays one short glow on it.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { atoms, WOS } from "@/app/store/global";
import { getLayoutModelForStaticTab } from "@/layout/lib/layoutModelHooks";
import { cn, fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useEffect, useRef, useState, type MouseEvent } from "react";
import { useRestoreFocus } from "../busy-close";
import { DialogFrame, useEscape } from "../dialog-frame";
import { useLocale, useT } from "../i18n/i18n";
import { MoltenWave } from "../molten-button";
import { openSettingsSection } from "../settings/settings-open";
import { normalizeView360Setting, type View360Decision, type View360Exit } from "./view360-decision";
import { CarpetIcon } from "./view360-icon";
import type { View360Model } from "./view360-model";
import { View360Text } from "./view360-text";
import "./view360.css";

const AccentButton = "molten-btn cursor-pointer rounded-6 px-3 py-1.5 text-12";
const PlainButton =
    "cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary";

// The tooltip: the state, what holds it (or keeps it off), and what a click does.
function toggleTitle(decision: View360Decision, single: boolean): string {
    if (single) {
        return View360Text.tooltipSingle;
    }
    if (decision.active) {
        const held =
            decision.source === "manual"
                ? View360Text.heldManual
                : decision.source === "auto"
                  ? View360Text.heldAuto
                  : View360Text.heldSetting;
        return `${View360Text.tooltipOn}\n${held}\n${View360Text.clickOff}`;
    }
    const off = decision.source === "manual" ? View360Text.offManual : View360Text.offAuto;
    return `${View360Text.tooltipOff}\n${off}\n${View360Text.clickOn}`;
}

function ExitDialog({ view360, exit }: { view360: View360Model; exit: View360Exit }) {
    const t = useT();
    const stayRef = useRef<HTMLButtonElement>(null);
    useRestoreFocus();
    useEffect(() => {
        stayRef.current?.focus();
    }, []);
    useEscape(true, () => view360.closeExitAsk());
    if (exit.kind === "blocked") {
        const count = exit.extraColumns;
        return (
            <DialogFrame
                role="molten-view360-blocked"
                title={t("view360.ui.blockedTitle")}
                trapFocus
                onBackdrop={() => view360.closeExitAsk()}
                buttons={
                    <button
                        ref={stayRef}
                        type="button"
                        className={AccentButton}
                        data-testid="mt-v360-blocked-ok"
                        onClick={() => view360.closeExitAsk()}
                    >
                        {t("view360.ui.blockedOk")}
                        <MoltenWave />
                    </button>
                }
            >
                <p data-testid="mt-v360-blocked-text">
                    {count === 1 ? t("view360.ui.blockedOne") : t("view360.ui.blockedMany", { count })}
                </p>
            </DialogFrame>
        );
    }
    return (
        <DialogFrame
            role="molten-view360-readjust"
            title={t("view360.ui.readjustTitle")}
            trapFocus
            onBackdrop={() => view360.closeExitAsk()}
            buttons={
                <>
                    <button
                        ref={stayRef}
                        type="button"
                        className={PlainButton}
                        data-testid="mt-v360-readjust-stay"
                        onClick={() => view360.closeExitAsk()}
                    >
                        {t("view360.ui.readjustStay")}
                    </button>
                    <button
                        type="button"
                        className={AccentButton}
                        data-testid="mt-v360-readjust-confirm"
                        onClick={() => view360.readjustAndLeave()}
                    >
                        {t("view360.ui.readjustConfirm")}
                        <MoltenWave />
                    </button>
                </>
            }
        >
            <p>{t("view360.ui.readjustText")}</p>
        </DialogFrame>
    );
}

function ToggleButton({ view360 }: { view360: View360Model }) {
    useLocale();
    const decision = useAtomValue(view360.decisionAtom);
    const columnCount = useAtomValue(view360.columnCountAtom);
    const setting = normalizeView360Setting(useAtomValue(view360.settingAtom));
    const signal = useAtomValue(view360.signalAtom);
    const exitAsk = useAtomValue(view360.exitAskAtom);
    const [mountSignal] = useState(signal);
    const single = columnCount < 2;
    const on = decision.active;
    const autoHeld = on && decision.source === "auto";

    const onClick = () => {
        if (single) {
            return;
        }
        view360.setActive(!on);
    };
    const onContextMenu = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const menu: ContextMenuItem[] = [];
        if (!single) {
            menu.push(
                {
                    label: on ? View360Text.menuLeave : View360Text.menuOn,
                    click: () => view360.setActive(!on),
                },
                { type: "separator" }
            );
        }
        menu.push({
            label: View360Text.menuSettings,
            click: () => fireAndForget(() => openSettingsSection("appearance")),
        });
        ContextMenuModel.getInstance().showContextMenu(menu, e);
    };

    return (
        <>
            <button
                type="button"
                className={cn("mt-v360-toggle cursor-pointer", on && "is-on", single && "is-disabled")}
                title={toggleTitle(decision, single)}
                aria-pressed={on}
                aria-disabled={single}
                data-testid="mt-v360-toggle"
                data-setting={setting}
                data-source={decision.source}
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                // The toggle never takes the focus from the terminal.
                onMouseDown={(e) => e.preventDefault()}
                onClick={onClick}
                onContextMenu={onContextMenu}
            >
                <CarpetIcon />
                <span className="mt-v360-label">{View360Text.toggleLabel}</span>
                {autoHeld && !single && <span className="mt-v360-auto">{View360Text.toggleAutoMark}</span>}
                {signal !== mountSignal && <span key={signal} className="mt-v360-glow" aria-hidden="true" />}
            </button>
            {exitAsk != null && <ExitDialog view360={view360} exit={exitAsk} />}
        </>
    );
}

function ToggleForTab({ tabId }: { tabId: string }) {
    const tab = useAtomValue(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
    const view360 = tab != null ? getLayoutModelForStaticTab()?.moltenView360 : null;
    if (view360 == null) {
        return null;
    }
    return <ToggleButton view360={view360} />;
}

export const View360Toggle = memo(() => {
    const staticTabId = useAtomValue(atoms.staticTabId);
    if (!staticTabId) {
        return null;
    }
    return <ToggleForTab tabId={staticTabId} />;
});
View360Toggle.displayName = "View360Toggle";
