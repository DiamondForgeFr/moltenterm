// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hold = vi.fn();
const setMeta = vi.fn();
const gate = { allowed: true };
// A wavesrv of the test: the mode's state, and whether it refuses (the brainstorm is switched off).
const server = vi.hoisted(() => ({ open: false, version: 1, refuse: false }));

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return {
        atoms: { uiContext: atom({ windowid: "w1" }) },
        getApi: () => ({ moltentermSystemNotifyHold: hold }),
    };
});
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: (...args: any[]) => setMeta(...args) } }));
vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: {
        wshRpcCall: async (command: string) => {
            if (server.refuse) {
                throw new Error("brainstorms with Brokk exist only on gold, dev and local builds");
            }
            if (command === "moltenbrainstormclose" && server.open) {
                server.open = false;
                server.version++;
            }
            return { allowed: true, open: server.open, version: server.version };
        },
    },
}));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => () => {} }));
vi.mock("../build/current-build", () => ({ currentBrainstormAllowed: () => gate.allowed }));
vi.mock("../i18n/i18n", () => ({
    t: (key: string) => key,
    tCount: (key: string, count: number) => `${key}:${count}`,
}));
vi.mock("../notifications-model", () => ({ notificationTitle: (e: any) => e.title }));
vi.mock("../toast-store", () => ({ showToast: () => {} }));
vi.mock("../agent-state-store", async () => {
    const { atom } = await import("jotai");
    const dataAtom = atom({ states: {}, versions: {} });
    return { AgentStates: { getInstance: () => ({ dataAtom }) } };
});
vi.mock("../notifications-store", async () => {
    const { atom } = await import("jotai");
    const { globalStore } = await import("@/app/store/jotaiStore");
    const entriesAtom = atom([]);
    return {
        MoltentermNotifications: { getInstance: () => ({ entriesAtom, entries: () => globalStore.get(entriesAtom) }) },
    };
});
vi.mock("../tab-activity", async () => {
    const { atom } = await import("jotai");
    const onScreenAtom = atom(true);
    return { TabActivity: { getInstance: () => ({ onScreenAtom }) } };
});
vi.mock("../sidebar/sidebar-store", async () => {
    const { atom } = await import("jotai");
    const { globalStore } = await import("@/app/store/jotaiStore");
    const hiddenAtom = atom(false);
    const windowMetaAtom = atom({});
    return {
        SidebarModel: {
            getInstance: () => ({
                hiddenAtom,
                windowMetaAtom,
                isEnabled: () => true,
                isHidden: () => globalStore.get(hiddenAtom),
                setHidden: (hidden: boolean) => globalStore.set(hiddenAtom, hidden),
            }),
        },
    };
});
vi.mock("../boss/boss-store", async () => {
    const { atom } = await import("jotai");
    const { globalStore } = await import("@/app/store/jotaiStore");
    const cardOpenAtom = atom(false);
    const boss = {
        cardOpenAtom,
        nameAtom: atom("Brokk"),
        openCard: () => globalStore.set(cardOpenAtom, true),
        closeCard: () => globalStore.set(cardOpenAtom, false),
        pinCard: () => {},
        showPanel: vi.fn(),
    };
    return { BossBubbleModel: { getInstance: () => boss } };
});
vi.mock("../boss/brokk-session", async () => {
    const session = {
        listenAnswers: () => () => {},
        listenTaken: () => () => {},
        addLocalLine: () => {},
        setLead: () => {},
    };
    return { BrokkSession: { getInstance: () => session } };
});

import { globalStore } from "@/app/store/jotaiStore";
import { BossBubbleModel } from "../boss/boss-store";
import { SidebarModel } from "../sidebar/sidebar-store";
import { bootBrainstorm, BrainstormStateAtom, forgetBrainstorm, loadBrainstorm } from "./brainstorm-boot";
import { brainstormHolds, setBrainstormHold } from "./brainstorm-hold";
import { BrainstormModel, SidebarSlidMetaKey } from "./brainstorm-store";

const boss = BossBubbleModel.getInstance() as any;
const sidebar = SidebarModel.getInstance() as any;

async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
        await Promise.resolve();
    }
}

// The model loads once, as in a window; each test then takes a fresh instance of it.
beforeAll(async () => {
    await loadBrainstorm();
    await settle();
});

beforeEach(() => {
    BrainstormModel.resetInstance();
    setBrainstormHold(false);
    hold.mockClear();
    setMeta.mockClear();
    server.open = false;
    server.version = 1;
    server.refuse = false;
    gate.allowed = true;
    globalStore.set(boss.cardOpenAtom, false);
    globalStore.set(sidebar.hiddenAtom, false);
    globalStore.set(sidebar.windowMetaAtom, {});
});

// The mode is on in wavesrv and this view took the screen: the pause is on, the sidebar slid in, his card is open.
async function modeIsOn(): Promise<BrainstormModel> {
    const model = BrainstormModel.getInstance();
    server.open = true;
    server.version++;
    await model.refresh();
    expect(model.isOpen()).toBe(true);
    expect(brainstormHolds()).toBe(true);
    expect(sidebar.isHidden()).toBe(true);
    expect(globalStore.get(boss.cardOpenAtom)).toBe(true);
    globalStore.set(sidebar.windowMetaAtom, { [SidebarSlidMetaKey]: true });
    return model;
}

// FR-BOSS-011 AC3. The developer turns the brainstorm off in one window; the mode is open in another, and wavesrv, which
// refuses the brainstorm from then on, can no longer tell that window that the mode ended.
describe("a window where the mode is open when the brainstorm is switched off elsewhere", () => {
    it("lets go of the pause, the slid sidebar and his card, and forgets the mode", async () => {
        const model = await modeIsOn();
        server.refuse = true;
        gate.allowed = false;
        forgetBrainstorm();
        expect(model.isOpen()).toBe(false);
        expect(globalStore.get(BrainstormStateAtom)).toBeNull();
        expect(brainstormHolds()).toBe(false);
        expect(hold).toHaveBeenLastCalledWith(false);
        expect(globalStore.get(boss.cardOpenAtom)).toBe(false);
        expect(sidebar.isHidden()).toBe(false);
        expect(setMeta).toHaveBeenLastCalledWith(expect.anything(), {
            oref: "window:w1",
            meta: { [SidebarSlidMetaKey]: null },
        });
    });

    it("holds nothing and changes nothing where the mode was not open", async () => {
        forgetBrainstorm();
        expect(globalStore.get(BrainstormStateAtom)).toBeNull();
        expect(hold).not.toHaveBeenCalled();
        expect(brainstormHolds()).toBe(false);
        expect(setMeta).not.toHaveBeenCalled();
    });

    it("releases once, however many times the view is told", async () => {
        await modeIsOn();
        forgetBrainstorm();
        forgetBrainstorm();
        expect(hold.mock.calls.map((c) => c[0])).toEqual([true, false]);
    });
});

// The brainstorm could not be ended first (wavesrv did not answer): it is still open there when the switch is turned off,
// and when it is turned on again.
describe("the switch turned off and on while wavesrv still has the mode open", () => {
    it("releases at once, shows the mode again when the view watches again, and one end releases it", async () => {
        const model = await modeIsOn();

        server.refuse = true;
        gate.allowed = false;
        forgetBrainstorm();
        expect(brainstormHolds()).toBe(false);
        expect(model.isOpen()).toBe(false);

        server.refuse = false;
        gate.allowed = true;
        globalStore.set(boss.cardOpenAtom, false);
        globalStore.set(sidebar.hiddenAtom, false);
        const stop = bootBrainstorm();
        await settle();
        expect(model.isOpen()).toBe(true);
        expect(brainstormHolds()).toBe(true);
        expect(hold.mock.calls.map((c) => c[0])).toEqual([true, false, true]);

        await model.end();
        expect(model.isOpen()).toBe(false);
        expect(brainstormHolds()).toBe(false);
        expect(hold).toHaveBeenLastCalledWith(false);
        stop();
    });

    it("holds once when the mode is read twice", async () => {
        const model = await modeIsOn();
        await model.refresh();
        await model.refresh();
        expect(hold.mock.calls.map((c) => c[0])).toEqual([true]);
    });

    it("leaves the layer hidden when the mode was ended meanwhile", async () => {
        const model = await modeIsOn();
        server.refuse = true;
        gate.allowed = false;
        forgetBrainstorm();
        server.refuse = false;
        server.open = false;
        gate.allowed = true;
        const stop = bootBrainstorm();
        await settle();
        expect(model.isOpen()).toBe(false);
        expect(brainstormHolds()).toBe(false);
        stop();
    });
});
