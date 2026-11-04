// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The tests read every shipped dictionary synchronously, as Electron main does; the app loads them on demand (#1213).

import "./i18n-locales-eager";
