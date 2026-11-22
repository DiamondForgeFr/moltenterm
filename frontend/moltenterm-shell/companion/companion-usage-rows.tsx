// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The choice of the plan usage's rows (FR-SHELL-018, #2462): a switch per window the provider reports, the last row that
// shows kept on, and how many rows are hidden. It is the "Rows shown" section of the usage block's settings popover while
// arranging (companion-block-settings.tsx) and, outside the arranging mode, the popover of a tool of the block's tools.
// The switches are the settings popover's own (companion-dashboard.css).

import { cn } from "@/util/util";
import { useId, useRef, useState } from "react";
import { useT, useTCount } from "../i18n/i18n";
import { MenuPopover } from "../mission/menu-popover";
import { BlockTool } from "./companion-block";
import type { UsageWindowChoice } from "./companion-gauges-model";
import { TipScopeAttr } from "./companion-tips-model";
import { hiddenCount, onlyShown } from "./companion-usage-rows-model";

export function UsageRowsChoice({
    choices,
    onSet,
    separated,
}: {
    choices: readonly UsageWindowChoice[];
    onSet: (id: string, hide: boolean) => void;
    // After other options, under a hairline (the settings popover); alone in its own popover otherwise.
    separated?: boolean;
}) {
    const t = useT();
    const tCount = useTCount();
    const headingId = useId();
    const [said, setSaid] = useState("");
    const hidden = hiddenCount(choices);
    const note =
        hidden > 0
            ? tCount("companion.gauges.rows.hidden", hidden, { count: hidden })
            : t("companion.gauges.rows.allShown");
    return (
        <div
            className={cn("mt-cb-rows", separated && "mt-cb-rows-separated")}
            role="group"
            aria-labelledby={headingId}
            data-testid="companion-usage-rows"
        >
            <h4 id={headingId} className="mt-cb-settings-title">
                {t("companion.gauges.rows.title")}
            </h4>
            {choices.length === 0 ? (
                <p className="mt-cb-rows-note" data-testid="companion-usage-rows-none">
                    {t("companion.gauges.rows.none")}
                </p>
            ) : (
                choices.map((choice) => (
                    <RowSwitch
                        key={choice.id}
                        choice={choice}
                        last={choice.shown && onlyShown(choices, choice.id)}
                        onSet={(hide) => {
                            onSet(choice.id, hide);
                            setSaid(
                                t(hide ? "companion.gauges.rows.nowHidden" : "companion.gauges.rows.nowShown", {
                                    label: choice.label,
                                })
                            );
                        }}
                    />
                ))
            )}
            {choices.length > 0 ? (
                <p className="mt-cb-rows-note" data-testid="companion-usage-rows-note">
                    {note}
                </p>
            ) : null}
            <div role="status" aria-live="polite" className="sr-only" data-testid="companion-usage-rows-said">
                {said}
            </div>
        </div>
    );
}

// A switch is on while its row shows. The one that is the last on stays on: it is focusable and says why, and a press on
// it does nothing.
function RowSwitch({
    choice,
    last,
    onSet,
}: {
    choice: UsageWindowChoice;
    last: boolean;
    onSet: (hide: boolean) => void;
}) {
    const t = useT();
    const whyId = useId();
    return (
        <button
            type="button"
            role="switch"
            aria-checked={choice.shown}
            aria-disabled={last || undefined}
            aria-describedby={last ? whyId : undefined}
            data-tip={last ? t("companion.gauges.rows.lastOne") : undefined}
            className="mt-cb-setting"
            data-testid={`companion-usage-row-${choice.id}`}
            onClick={() => {
                if (last) {
                    return;
                }
                onSet(choice.shown);
            }}
        >
            <span className="mt-cb-setting-label">{choice.label}</span>
            {last ? (
                <span id={whyId} className="sr-only">
                    {t("companion.gauges.rows.lastOne")}
                </span>
            ) : null}
            <span className="mt-cb-switch" data-on={choice.shown ? "" : undefined} aria-hidden="true" />
        </button>
    );
}

// The block's tool outside the arranging mode: a list icon, with the number of rows hidden once there are some, which
// opens the same choice in a popover of the companion's look. Escape closes the popover alone and gives the focus back.
export function UsageRowsTool({
    choices,
    name,
    onSet,
}: {
    choices: readonly UsageWindowChoice[];
    name: string;
    onSet: (id: string, hide: boolean) => void;
}) {
    const t = useT();
    const tCount = useTCount();
    const [open, setOpen] = useState(false);
    const button = useRef<HTMLButtonElement>(null);
    const hidden = hiddenCount(choices);
    const label =
        hidden > 0
            ? tCount("companion.gauges.rows.toolHidden", hidden, { count: hidden })
            : t("companion.gauges.rows.tool");
    return (
        <>
            <BlockTool
                label={label}
                buttonRef={button}
                opens={{ open }}
                onClick={() => setOpen(!open)}
                testId="companion-usage-rows-tool"
            >
                <i className="fa fa-solid fa-list-check" aria-hidden="true" />
                {hidden > 0 ? (
                    <span className="tabular-nums" data-testid="companion-usage-rows-count">
                        {hidden}
                    </span>
                ) : null}
            </BlockTool>
            {open && button.current != null ? (
                <MenuPopover
                    anchor={button.current}
                    onClose={() => setOpen(false)}
                    placement="bottom-end"
                    role="dialog"
                    ariaLabel={t("companion.gauges.rows.dialog", { name })}
                    className="mt-cb-settings"
                    focusManaged
                >
                    <div
                        className="mt-cb-settings-body"
                        {...{ [TipScopeAttr]: "" }}
                        data-testid="companion-usage-rows-popover"
                        onKeyDown={(e) => {
                            if (e.key !== "Escape") {
                                return;
                            }
                            e.stopPropagation();
                            setOpen(false);
                        }}
                    >
                        <UsageRowsChoice choices={choices} onSet={onSet} />
                    </div>
                </MenuPopover>
            ) : null}
        </>
    );
}
