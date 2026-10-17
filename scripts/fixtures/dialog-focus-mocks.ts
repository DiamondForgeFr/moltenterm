// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { atom } from "jotai";
import dictionary from "../../frontend/moltenterm-shell/i18n/locales/en.json";

export const fixture = {
    fail: false,
    plansPending: false,
    pending: [] as { resolve: (value?: any) => void; reject: (error: Error) => void }[],
    writes: [] as string[],
};
export const t = (key: string, vars: Record<string, unknown> = {}) => {
    const value = key.split(".").reduce((current, part) => current?.[part], dictionary as any);
    return String(value ?? key).replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? `{${name}}`));
};
export const useT = () => t;
export const translate = (_language: string, key: string, vars?: Record<string, unknown>) => t(key, vars);
export const hasKey = (key: string) => t(key) !== key;
export const serverErrorText = (error: Error) => error.message;
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
export const getApi = () => ({ resetWorkspace: () => fixture.writes.push("reset") });
export const ObjectService = { GetObjects: async () => [] };
export const WorkspaceService = { GetWorkspace: async () => ({ oid: "fixture", name: "Fixture", tabids: [] }) };
export const BusyCloseRequestAtom = atom(null);
export const askBusyClose = async () => false;
export const busyCloseEnabled = () => false;
export const busyDialogOpen = () => false;
export const closingTerminalOf = () => null;
export const isTerminalMeta = () => true;
export const readRunning = async () => [];
export const readWorkspaceRunning = async () => [];
export const listenMainBusyAsks = () => () => {};
export const registerNotificationGesture = () => () => {};
export const recordingTabClose = (_id: string, close: () => void) => close();
export const worktreePlan = async () => {
    if (fixture.plansPending) await new Promise((resolve, reject) => fixture.pending.push({ resolve, reject }));
    if (fixture.fail) throw new Error("Fixture plan failed");
    return {
        path: "/fixture/tree", real: "/fixture/tree", branch: "fixture", changes: [], changecount: 0,
        ignored: [], ignoredcount: 0, ignoredfilecount: 0, unpushed: 0, merged: true, terminals: [],
    };
};
export const removeWorktree = async () => {
    fixture.writes.push("remove");
    return new Promise((resolve, reject) => fixture.pending.push({ resolve, reject }));
};
export const resolveKeptWorktreeNotice = () => {};
