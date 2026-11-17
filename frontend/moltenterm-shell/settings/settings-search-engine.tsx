// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Settings › Browser › Search engine (FR-SHELL-035, #2312): the presets as option rows, each with its mark and one
// neutral line, the recommended one badged, and Custom, which is the address field of the setting just below. The list
// is drawn without a network call.

import { getSettingsKeyAtom } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { EngineMark } from "../browser/engine-mark";
import {
    CustomEngineId,
    DefaultSearchSettingKey,
    effectiveTemplate,
    presetOf,
    RecommendedEngineId,
    searchEngineInfo,
    SearchEnginePresets,
} from "../browser/search-engine-model";
import { useT } from "../i18n/i18n";
import { OptionList, RadioDot } from "../suite/suite";

function chooseEngine(template: string) {
    fireAndForget(() => RpcApi.SetConfigCommand(TabRpcClient, { [DefaultSearchSettingKey]: template } as SettingsType));
}

// Custom is the row of an address no preset has: its text field is the setting's own row, which it brings the focus to.
function focusAddressField() {
    const field = document.querySelector<HTMLElement>(`[data-setting="${DefaultSearchSettingKey}"] input`);
    field?.focus();
}

type EngineRowProps = {
    id: string;
    letters: string;
    name: string;
    line: string;
    recommended?: boolean;
    selected: boolean;
    onSelect: () => void;
};

function EngineRow({ id, letters, name, line, recommended, selected, onSelect }: EngineRowProps) {
    const t = useT();
    return (
        <label
            className="df-option-row [&_.df-option-label]:overflow-visible [&_.df-option-label]:whitespace-normal"
            data-selected={selected ? "" : undefined}
            data-option={id}
            data-testid="search-engine-row"
        >
            <input
                type="radio"
                className="df-sr-only"
                name="search-engine"
                value={id}
                checked={selected}
                onChange={onSelect}
            />
            <RadioDot />
            <EngineMark letters={letters} />
            <span className="df-option-label">
                {name}
                {recommended ? (
                    <span
                        className="ml-2 rounded-4 bg-accent/10 px-1.5 py-0.5 text-11 font-medium text-accent"
                        data-testid="search-engine-recommended"
                    >
                        {t("settings.searchEngine.recommended")}
                    </span>
                ) : null}
                <span className="df-option-meta">{line}</span>
            </span>
            {selected ? <span className="df-option-selected">{t("common.selected")}</span> : null}
        </label>
    );
}

export function SearchEnginePicker() {
    const t = useT();
    const setting = useAtomValue(getSettingsKeyAtom(DefaultSearchSettingKey));
    const current = effectiveTemplate(setting);
    const chosen = presetOf(current);
    const custom = chosen == null ? searchEngineInfo(current) : null;
    return (
        <div className="molten-settings-row flex flex-col" data-testid="settings-search-engine">
            <OptionList aria-label={t("settings.searchEngine.aria")} data-setting-control>
                {SearchEnginePresets.map((p) => (
                    <EngineRow
                        key={p.id}
                        id={p.id}
                        letters={p.letter}
                        name={p.name}
                        line={t(`settings.searchEngine.${p.id}`)}
                        recommended={p.id === RecommendedEngineId}
                        selected={chosen?.id === p.id}
                        onSelect={() => chooseEngine(p.template)}
                    />
                ))}
                <EngineRow
                    id={CustomEngineId}
                    letters={custom?.letter ?? "…"}
                    name={t("settings.searchEngine.custom")}
                    line={
                        custom != null
                            ? `${custom.name} · ${t("settings.searchEngine.customLine")}`
                            : t("settings.searchEngine.customLine")
                    }
                    selected={custom != null}
                    onSelect={focusAddressField}
                />
            </OptionList>
        </div>
    );
}
