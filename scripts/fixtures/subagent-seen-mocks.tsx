// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { atom, useAtomValue } from "jotai";
import type { ReactNode } from "react";
import { globalStore } from "../../frontend/app/store/jotaiStore";

export const companion = atom<any>(null);
export const activity = atom<"active" | "visible" | "hidden" | "minimized">("active");
const parent = atom(null);
export const AgentStates = { getInstance: () => ({ blockAtom: () => parent }) };
export const useCompanionFollow = () => useAtomValue(companion);
const tabActivity = {
    stateAtom: activity,
    state: () => globalStore.get(activity),
    start: () => {},
    every: () => () => {},
};
export const TabActivity = { getInstance: () => tabActivity };
export const whileShown = () => ({});
export const waveEventSubscribeSingle = () => {};
export const TabRpcClient = {};
export const fireAndForget = () => {};
export const createBlock = () => {};
export const cn = (...values: unknown[]) => values.filter(Boolean).join(" ");
export const useT = () => (key: string) => key;
export const t = (key: string) => key;
export const useLocale = () => "en";
export const getLocale = () => "en";
export const agentDisplayName = () => "parent";
export const AgentGlyph = () => null;
export const WorkingDominoes = () => null;
export const DialogFrame = ({ children }: { children: ReactNode }) => <div>{children}</div>;
export const Fact = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
export const PlainButton = "";
export const SectionTitle = "";
