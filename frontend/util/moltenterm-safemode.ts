// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Safe mode (FR-MORPH-003) starts Moltenterm with no mod loaded, so that a mod that breaks the workspace can always
// be repaired. It is set by this environment variable, or by the argument the "Restart in Safe Mode" menu item
// relaunches the app with (emain/moltenterm-safemode.ts).
export const MoltentermSafeModeVarName = "MOLTENTERM_SAFE_MODE";
export const MoltentermSafeModeArg = "--molten-safe-mode";
