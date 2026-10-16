// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { atom } from "jotai";
import dictionary from "../../frontend/moltenterm-shell/i18n/locales/en.json";

export const FallbackLanguage = "en";
export const t = (key: string, vars: Record<string, unknown> = {}) => {
    const value = key.split(".").reduce((current, part) => current?.[part], dictionary as any);
    return String(value ?? key).replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? `{${name}}`));
};
export const useT = () => t;
export const useLocale = () => "en";
export const getLocale = () => "en";
export const translate = (_language: string, key: string, vars?: Record<string, unknown>) => t(key, vars);
export const translateCount = (_language: string, key: string, count: number) => t(key, { count });
export const formatNumber = (value: number) => String(value);
export const hasKey = (key: string) => t(key) !== key;
export const serverErrorText = (error: unknown) => error instanceof Error ? error.message : String(error);
export const serverText = (_text: unknown, fallback: string) => fallback;
export const cn = (...parts: unknown[]) => parts.filter(Boolean).join(" ");
export const makeIconClass = (name: string) => name;
export const fireAndForget = (fn: () => Promise<unknown>) => void fn().catch(() => {});
export const NullAtom = atom(null);
const objectAtom = atom({ oid: "fixture", meta: {}, tabids: [], blockids: [] });
export const getWaveObjectAtom = () => objectAtom;
export const loadAndPinWaveObject = async () => {};
export const makeORef = (_type: string, id: string) => id;
export const getLayoutModelForStaticTab = () => null;
export const getApi = () => ({});
export const ObjectService = { GetObjects: async () => [] };
export const WorkspaceService = { GetWorkspace: async () => ({ oid: "fixture", name: "Fixture", tabids: [] }) };
export const BusyCloseRequestAtom = atom(null);
export const askBusyClose = async () => false;
export const busyCloseEnabled = () => false;
export const busyDialogOpen = () => false;
export const closingTerminalOf = () => null;
export const isTerminalMeta = () => true;
export const readRunning = async () => [];
export const listenMainBusyAsks = () => () => {};
export const registerNotificationGesture = () => () => {};
export const recordingTabClose = (_id: string, close: () => void) => close();
export const worktreePlan = async () => { throw new Error("Unable to read the worktree: fixture failure"); };
export const removeWorktree = async () => { throw new Error("Unexpected destructive action in contrast fixture"); };
export const resolveKeptWorktreeNotice = () => {};
const host = {
    modsAtom: atom([{ id: "fixture-mod", name: "Example mod", state: "failed", commands: [], error: "Unable to activate the mod: fixture failure" }]),
    checkBudgets: () => {},
};
export const MoltenHost = { getInstance: () => host };
