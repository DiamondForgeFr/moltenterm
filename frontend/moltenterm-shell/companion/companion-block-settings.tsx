// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The settings of a block while arranging (FR-SHELL-018, #2459): the gear on the block opens a compact popover, of the
// companion's popover look, with the block's own options (companion-block-options.ts lists them: every block's Show and
// Full width, the plan usage's form and attaching, the milestone block's groups, the files' list). It takes the focus
// when it opens, closes on Escape (and only it: the mode stays) or a press outside, and gives the focus back to the gear.
// Loaded with the arranging mode, out of the startup bundle.

import { useId, useRef, useState } from "react";
import { useT } from "../i18n/i18n";
import { MenuPopover } from "../mission/menu-popover";
import { SegmentedControl } from "../segmented-control";
import { BlockTool } from "./companion-block";
import { BlockOption, optionsOf, optionValue, PrefDefaults } from "./companion-block-options";
import type { CompanionPrefs } from "./companion-files-model";
import type { CompanionSectionId, SectionPlacement } from "./companion-layout";

export type BlockSettingsProps = {
    id: CompanionSectionId;
    // The block's name as the arranging mode says it.
    name: string;
    placement: SectionPlacement;
    prefs: CompanionPrefs;
    defaults?: PrefDefaults;
    // An option was set: the arranging mode drafts a layout option, saves a preference, and announces it.
    onChange: (option: BlockOption, value: boolean) => void;
};

export function BlockSettings(props: BlockSettingsProps) {
    const t = useT();
    const [open, setOpen] = useState(false);
    const button = useRef<HTMLButtonElement>(null);
    return (
        <>
            <BlockTool
                label={t("companion.arrange.settings", { name: props.name })}
                buttonRef={button}
                opens={{ open }}
                marker="settings"
                onClick={() => setOpen(!open)}
                testId="companion-arrange-settings"
            >
                <i className="fa fa-solid fa-gear" aria-hidden="true" />
            </BlockTool>
            {open && button.current != null ? (
                <MenuPopover
                    anchor={button.current}
                    onClose={() => setOpen(false)}
                    placement="bottom-end"
                    role="dialog"
                    ariaLabel={t("companion.arrange.settingsOf", { name: props.name })}
                    className="mt-cb-settings"
                    focusManaged
                >
                    <SettingsBody {...props} onClose={() => setOpen(false)} />
                </MenuPopover>
            ) : null}
        </>
    );
}

export function SettingsBody({
    id,
    name,
    placement,
    prefs,
    defaults,
    onChange,
    onClose,
}: BlockSettingsProps & { onClose: () => void }) {
    return (
        <div
            className="mt-cb-settings-body"
            data-testid="companion-settings"
            onKeyDown={(e) => {
                if (e.key !== "Escape") {
                    return;
                }
                // The popover closes, not the arranging mode around it.
                e.stopPropagation();
                onClose();
            }}
        >
            <h3 className="mt-cb-settings-title">{name}</h3>
            {optionsOf(id).map((option) => (
                <SettingRow
                    key={option.key}
                    option={option}
                    name={name}
                    value={optionValue(option, placement, prefs, defaults)}
                    disabled={option.key === "minimal" && placement.attached === true}
                    onChange={onChange}
                />
            ))}
        </div>
    );
}

// A yes or a no is a switch; the form of the plan usage is two words to choose between. The form waits while the block is
// attached to the main agent, which always draws its rows only: the choice is kept for the day it is detached (#2450).
function SettingRow({
    option,
    name,
    value,
    disabled,
    onChange,
}: {
    option: BlockOption;
    name: string;
    value: boolean;
    disabled: boolean;
    onChange: (option: BlockOption, value: boolean) => void;
}) {
    const t = useT();
    const helpId = useId();
    if (option.kind === "choice") {
        return (
            <div className="mt-cb-setting" data-testid={`companion-setting-${option.key}`}>
                <span className="mt-cb-setting-label">{t(option.labelKey)}</span>
                <fieldset disabled={disabled} className="m-0 min-w-0 border-0 p-0 disabled:opacity-40">
                    <SegmentedControl<"full" | "minimal">
                        popovers
                        label={t("companion.arrange.form", { name })}
                        segments={[
                            {
                                value: "full",
                                label: t("companion.arrange.formFull"),
                                title: t("companion.arrange.formFullHelp"),
                            },
                            {
                                value: "minimal",
                                label: t("companion.arrange.formMinimal"),
                                title: t("companion.arrange.formMinimalHelp"),
                            },
                        ]}
                        selected={value ? "minimal" : "full"}
                        onSelect={(form) => onChange(option, form === "minimal")}
                    />
                </fieldset>
            </div>
        );
    }
    return (
        <button
            type="button"
            role="switch"
            aria-checked={value}
            aria-describedby={option.helpKey != null ? helpId : undefined}
            className="mt-cb-setting"
            data-testid={`companion-setting-${option.key}`}
            onClick={() => onChange(option, !value)}
        >
            <span className="mt-cb-setting-label">{t(option.labelKey)}</span>
            {option.helpKey != null ? (
                <span id={helpId} className="sr-only">
                    {t(option.helpKey)}
                </span>
            ) : null}
            <span className="mt-cb-switch" data-on={value ? "" : undefined} aria-hidden="true" />
        </button>
    );
}
