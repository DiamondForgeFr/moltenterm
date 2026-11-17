// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The developer's choice of which providers the usage grid shows (FR-BOSS-009, AC97, #2341): "Always show" pins a
// provider, "Hide" leaves out one that is paid and does not matter, "Automatic" gives it back to the rules. The choices
// are MoltenTerm's settings (boss:usageshow, boss:usagehide), never a project's files.

import { getSettingsKeyAtom } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { writeSettings } from "../command-panel/bindings";
import { t } from "../i18n/i18n";
import { UsageChoice, UsageChoices, withChoice } from "./brokk-usage-model";

export const UsageShowKey = "boss:usageshow";
export const UsageHideKey = "boss:usagehide";

// The lists as the settings hold them: anything that is not a list of ids is no choice.
export function choicesOf(show: unknown, hide: unknown): UsageChoices {
    const ids = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id !== "") : [];
    return { show: ids(show), hide: ids(hide) };
}

export function readChoices(): UsageChoices {
    return choicesOf(
        globalStore.get(getSettingsKeyAtom(UsageShowKey)),
        globalStore.get(getSettingsKeyAtom(UsageHideKey))
    );
}

// An empty list is the setting taken away, so a settings file with no choice holds no key.
export function choiceSettings(choices: UsageChoices): Record<string, string[]> {
    return {
        [UsageShowKey]: choices.show.length > 0 ? choices.show : null,
        [UsageHideKey]: choices.hide.length > 0 ? choices.hide : null,
    };
}

export function chooseUsage(provider: string, choice: UsageChoice): Promise<void> {
    return writeSettings(choiceSettings(withChoice(readChoices(), provider, choice)));
}

// The menu of a row of the grid: the three choices, the current one marked.
export function usageChoiceMenu(provider: string, name: string, current: UsageChoice): ContextMenuItem[] {
    const entry = (choice: UsageChoice): ContextMenuItem => ({
        label: t(`usageWeek.choice.${choice}`, { name }),
        type: "radio",
        checked: current === choice,
        click: () => {
            if (choice !== current) {
                void chooseUsage(provider, choice);
            }
        },
    });
    return [entry("show"), entry("hide"), entry("auto")];
}
