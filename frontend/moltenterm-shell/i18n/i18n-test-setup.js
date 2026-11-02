// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The tests read every shipped dictionary synchronously, as Electron main does; the app loads them on demand (#1213).

import "./i18n-locales-eager";
