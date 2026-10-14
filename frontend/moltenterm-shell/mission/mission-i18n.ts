// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Mission Control's helpers for the interface language (FR-I18N-001): label tables and view names that read the
// dictionaries each time they are used, so a language change shows without a restart.

import * as jotai from "jotai";
import { I18nModel, t } from "../i18n/i18n";
import { translate } from "../i18n/i18n-core";

// A record whose values are translated on each read: `labels.success` gives the text of `<prefix>.success`.
export function labelRecord<K extends string>(prefix: string, keys: readonly K[]): Record<K, string> {
    const record = {} as Record<K, string>;
    for (const key of keys) {
        Object.defineProperty(record, key, { enumerable: true, get: () => t(`${prefix}.${key}`) });
    }
    return record;
}

// A view name (ViewModel.viewName) that follows the interface language.
export function tAtom(key: string): jotai.Atom<string> {
    return jotai.atom((get) => translate(get(I18nModel.getInstance().localeAtom), key));
}
