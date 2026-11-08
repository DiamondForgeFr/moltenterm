// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Every shipped dictionary, loaded up front: Electron main (its menus and dialogs speak at once), the tests and the
// preview server. The renderer takes them on demand instead (i18n-locales-lazy.ts, #1213).

import { Dictionary, provideShippedLanguages } from "./i18n-core";

provideShippedLanguages(
    import.meta.glob("./locales/*.json", { eager: true, import: "default" }) as unknown as Record<string, Dictionary>
);
