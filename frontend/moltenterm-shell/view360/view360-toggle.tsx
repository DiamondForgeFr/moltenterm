// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The tab bar's "360" toggle (FR-SHELL-066, DS-SHELL-117): it shows whether the tab on screen is in 360 view and
// switches it by hand; its right-click menu sets On, Off or drops the manual choice. A small "A" says the tab follows
// the automatic setting, and an automatic switch plays one short glow on it.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { atoms, WOS } from "@/app/store/global";
import { getLayoutModelForStaticTab } from "@/layout/lib/layoutModelHooks";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useState, type MouseEvent } from "react";
import { useLocale } from "../i18n/i18n";
import { normalizeView360Setting } from "./view360-decision";
import type { View360Model } from "./view360-model";
import { View360Text } from "./view360-text";
import "./view360.css";

function TwoPanelsIcon() {
    return (
        <svg className="mt-v360-icon" width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">
            <rect
                x="0.75"
                y="0.75"
                width="5"
                height="10.5"
                rx="1.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
            />
            <rect
                x="8.25"
                y="0.75"
                width="5"
                height="10.5"
                rx="1.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
            />
        </svg>
    );
}

function ToggleButton({ view360 }: { view360: View360Model }) {
    useLocale();
    const decision = useAtomValue(view360.decisionAtom);
    const columnCount = useAtomValue(view360.columnCountAtom);
    const manual = useAtomValue(view360.manualAtom);
    const setting = normalizeView360Setting(useAtomValue(view360.settingAtom));
    const signal = useAtomValue(view360.signalAtom);
    const [mountSignal] = useState(signal);
    const single = columnCount < 2;
    const on = decision.active;
    const auto = decision.source === "auto";

    let title: string;
    if (single) {
        title = View360Text.tooltipSingle;
    } else {
        const origin =
            decision.source === "manual"
                ? View360Text.tooltipManual
                : auto
                  ? View360Text.tooltipAuto
                  : View360Text.tooltipSetting;
        title = `${on ? View360Text.tooltipOn : View360Text.tooltipOff}\n${origin}`;
    }

    const onClick = () => {
        if (single) {
            return;
        }
        view360.setManual(!on);
    };
    const onContextMenu = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        ContextMenuModel.getInstance().showContextMenu(
            [
                {
                    label: View360Text.menuOn,
                    type: "checkbox",
                    checked: manual === true,
                    click: () => view360.setManual(true),
                },
                {
                    label: View360Text.menuOff,
                    type: "checkbox",
                    checked: manual === false,
                    click: () => view360.setManual(false),
                },
                { type: "separator" },
                {
                    label: View360Text.menuFollow,
                    type: "checkbox",
                    checked: manual == null,
                    click: () => view360.setManual(null),
                },
            ],
            e
        );
    };

    return (
        <button
            type="button"
            className={cn("mt-v360-toggle cursor-pointer", on && "is-on", single && "is-disabled")}
            title={title}
            aria-pressed={on}
            aria-disabled={single}
            data-testid="mt-v360-toggle"
            data-setting={setting}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            // The toggle never takes the focus from the terminal.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClick}
            onContextMenu={onContextMenu}
        >
            <TwoPanelsIcon />
            <span className="mt-v360-label">{View360Text.toggleLabel}</span>
            {auto && !single && <span className="mt-v360-auto">{View360Text.toggleAutoMark}</span>}
            {signal !== mountSignal && <span key={signal} className="mt-v360-glow" aria-hidden="true" />}
        </button>
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
