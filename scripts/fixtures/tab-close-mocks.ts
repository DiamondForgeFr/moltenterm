// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext } from "react";
import dictionary from "../../frontend/moltenterm-shell/i18n/locales/en.json";

export const WaveEnvContext = createContext(null);
export const useWaveEnv = () => useContext(WaveEnvContext);
export const cn = (...parts: unknown[]) => parts.filter(Boolean).join(" ");
export const t = (key: string) => key.split(".").reduce((value, part) => value?.[part], dictionary as any) ?? key;
export const useT = () => t;
