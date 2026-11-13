// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { atom, createStore } from "jotai";
import dictionary from "../../frontend/moltenterm-shell/i18n/locales/en.json";

// The failure each fixture case makes the mocked side effects raise.
export const Fixture = { mode: "" };
const failure = (what: string) => new Error(`${what}: fixture failure`);

export const t = (key: string, vars: Record<string, unknown> = {}) => {
    const value = key.split(".").reduce((current, part) => current?.[part], dictionary as any);
    return String(value ?? key).replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? `{${name}}`));
};
export const useT = () => t;
const localeAtom = atom("en");
export const I18nModel = { getInstance: () => ({ localeAtom }) };
export const serverErrorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const cn = (...parts: unknown[]) => parts.filter(Boolean).join(" ");
export const fireAndForget = (fn: () => Promise<unknown>) => void fn().catch(() => {});

export const FoundAgent = {
    id: "claude", name: "Claude Code", path: "/fixture", invocation: "/morph <request>", format: "skill",
    installed: true, found: true, executable: "claude", guides: [{ kind: "morph", installed: true, foreign: false }],
};
export const listOnboardingAgents = async () => {
    if (Fixture.mode === "agent-list" || Fixture.mode === "morph-list") throw failure("Unable to list the agents");
    return { agents: [FoundAgent], version: "1" };
};
export const installDeclinedAgent = async () => {};
export const ensureMorphDir = async () => { throw failure("Unable to prepare the folder"); };
export const scanProjectCandidates = async () => { throw failure("Unable to scan the projects"); };
export const onboardingUpdate = async () => ({});
export const setPanelPage = async () => {};
export const openBesidePanel = async () => "fixture";

const objectAtom = atom({ oid: "fixture", meta: {}, tabids: [], blockids: [] });
export const getWaveObjectAtom = () => objectAtom;
export const makeORef = (_type: string, id: string) => id;
export const atoms = {
    workspace: atom<any>({ oid: "fixture", name: "Fixture", meta: {} }),
    workspaceId: atom(""),
    staticTabId: atom(""),
    activeTabId: atom(""),
};
export const globalStore = createStore();
export const NullAtom = atom(null);
export const WOS = {
    makeORef: (_type: string, id: string) => id,
    getWaveObjectAtom: () => objectAtom,
    getObjectValue: () => null,
    reloadWaveObject: async () => null,
    setObjectValue: () => {},
};
export const getBlockComponentModel = () => null;
export const getSettingsKeyAtom = () => atom(null);
export const getConnStatusAtom = () => atom(null);
export const getOrefMetaKeyAtom = () => atom(null);
export const getFocusedBlockId = () => "";
export const getPrefixedSettings = () => ({});
export const newLayoutNode = () => ({});
export const LayoutTreeActionType = {};
export const createBlock = async () => "";
export const createBlockSplitHorizontally = async () => {};
export const deepCompareReturnPrev = (_prev: unknown, next: unknown) => next;
export const isBlank = (value: string) => !value?.trim?.();
export const isLocalConnName = () => false;
export const isWslConnName = () => false;
export const sortByDisplayOrder = <T,>(items: T[]) => items;
export const base64ToString = () => "";
export const base64ToArrayBuffer = () => new ArrayBuffer(0);
export const boundNumber = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export const atomWithThrottle = <T,>(initial: T) => atom(initial);
export const BlockService = { GetControllerStatus: async () => null };
export const ObjectService = { GetObjects: async () => [] };
export const lazy = () => () => null;
export const tCount = (_key: string, count: number) => String(count);
export const useTCount = () => (_key: string, count: number) => String(count);
export const useLocale = () => "en";
export const translate = (_language: string, key: string) => t(key);
export const serverText = (_text: unknown, fallback: string) => fallback;
export const makeIconClass = (name: string) => name;
export const formatShortcutById = (id: string) => id;
export const replaceBlock = async () => {};
export const WorkspaceService = { UpdateWorkspace: async () => {} };
const clientAtom = atom({ meta: {} });
export const ClientModel = { getInstance: () => ({ clientAtom }) };
export const uxCloseBlock = () => {};
export const getActiveTabModel = () => null;
export const getLayoutModelForStaticTab = () => null;
export const getApi = () => ({});
export const openLink = async () => {};
const modsAtom = atom([]);
export const MoltenHost = { getInstance: () => ({ modsAtom }) };
export const openSettingsSection = () => {};
export const focusMoltentermView = () => {};
export const MoltentermSessionsView = "sessions";
export const openWorkspaceEditor = () => {};
export const readRecentFolders = () => [];
export const readWorkspaceFolder = () => "";
export const chooseMoltentermPath = async () => "";
export const findProjectRoot = async () => "";
export const linkWorkspaceProject = async () => {};
export const readProjectFacts = async () => ({ name: "Fixture", hasPipeline: false });
export const setWorkspaceFolder = async () => {};
export const formatKeys = (key: string) => key;
export const modifierLabel = (key: string) => key;
export const ShortcutsSheetKey = "shortcuts";
export const typeCommandWhenReady = async () => false;
export default () => null;
