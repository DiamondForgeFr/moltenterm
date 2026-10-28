// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The renderer's shipped dictionaries, each its own chunk loaded on demand (#1213, NFR-PERF-003): the startup bundle
// carries none, the app awaits the active language before its first render and loads another when it is chosen.

import { Dictionary, provideShippedLanguages } from "./i18n-core";

provideShippedLanguages(
    import.meta.glob("./locales/*.json", { import: "default" }) as unknown as Record<string, () => Promise<Dictionary>>
);
