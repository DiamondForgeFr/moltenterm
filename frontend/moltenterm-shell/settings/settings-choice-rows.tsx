// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The option rows a select setting with few choices shows (#1408 moved them out of settings-screen.tsx so the
// keep-awake popover draws the very same control as Preferences › Energy).

import { useT } from "../i18n/i18n";
import { OptionList, OptionRow } from "../suite/suite";
import { effectiveSetting, SettingChoice, SettingEntry } from "./settings-catalog";
import { settingsOptionIcon } from "./settings-icons";

export function ChoiceRows({
    entry,
    name,
    choices,
    value,
    onSet,
}: {
    entry: SettingEntry;
    name: string;
    choices: SettingChoice[];
    value: unknown;
    onSet: (v: unknown) => void;
}) {
    const t = useT();
    const shown = effectiveSetting(entry, value);
    const current = shown == null ? "" : String(shown);
    return (
        <OptionList aria-label={entry.label} data-setting-control>
            {choices.map((c) => (
                <OptionRow
                    key={c.value}
                    name={name}
                    value={c.value}
                    label={c.label}
                    icon={settingsOptionIcon(entry.key, c.value)}
                    selected={c.value === current}
                    selectedLabel={t("common.selected")}
                    onSelect={() => onSet(c.value === "" ? null : c.value)}
                />
            ))}
        </OptionList>
    );
}
