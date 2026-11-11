// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The window's side of Brokk as a kind colleague (FR-BOSS-009, AC72 to AC77, #2203, #2221). The colleague's run (the
// developer's inputs, the stretch, the moments, what was said) has one owner for every tab and window: Electron main
// (emain/moltenterm-colleague-owner.ts). A page keeps no run of its own: it tells the owner what the developer does and
// what only a page knows (the agents at work, the proximity setting, the language), and shows the moments the owner
// raises. The inputs come from the one listener the expressions watch already owns (brokk-expressions.ts): this file adds
// no activity tracker of its own.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import { getApi, getSettingsKeyAtom, globalStore } from "@/app/store/global";
import { atom, PrimitiveAtom } from "jotai";
import { AgentStates } from "../agent-state-store";
import { getLocale } from "../i18n/i18n";
import { Moment, proximityOf, ProximitySettingKey } from "./brokk-colleague";
import { EmptyMomentsUpdate, MomentsUpdate, PageFacts, samePageFacts } from "./brokk-colleague-wire";
import { workingOf } from "./brokk-watch";

// Pointer moves arrive by the hundred: one reading a second is plenty for a stretch counted in minutes.
export const InputEveryMs = 1000;

// What the page says to the owner and hears from it: the preload's moltentermBrokk* in the app, stand-ins in the tests.
export type ColleagueTransport = {
    now: () => number;
    // What only this page knows.
    facts: () => PageFacts;
    // The owner starts to tell this page the moments; the answer is the moments as they now are.
    start: (facts: PageFacts) => Promise<MomentsUpdate>;
    stop: () => void;
    sendFacts: (facts: PageFacts) => void;
    sendInput: (facts: PageFacts) => void;
    // The moment is on screen: the moment as it now is, null when another window has it or it is gone.
    shown: (id: string) => Moment;
    seen: (id: string) => void;
    onMoments: (callback: (update: MomentsUpdate) => void) => () => void;
};

const LiveTransport: ColleagueTransport = {
    now: () => Date.now(),
    facts: () => ({
        working: workingOf(globalStore.get(AgentStates.getInstance().dataAtom)),
        proximity: proximityOf(globalStore.get(getSettingsKeyAtom(ProximitySettingKey as keyof SettingsType))),
        language: getLocale(),
    }),
    start: async (facts) => (await getApi()?.moltentermBrokkStart?.(facts)) ?? EmptyMomentsUpdate,
    stop: () => getApi()?.moltentermBrokkStop?.(),
    sendFacts: (facts) => getApi()?.moltentermBrokkFacts?.(facts),
    sendInput: (facts) => getApi()?.moltentermBrokkInput?.(facts),
    shown: (id) => getApi()?.moltentermBrokkShown?.(id) ?? null,
    seen: (id) => getApi()?.moltentermBrokkSeen?.(id),
    onMoments: (callback) => getApi()?.onMoltentermBrokkMoments?.(callback) ?? (() => {}),
};

export class BrokkColleagueModel {
    private static instance: BrokkColleagueModel = null;

    // The moments waiting to be shown, oldest first (currentMoment picks the one to show).
    momentsAtom = atom([]) as PrimitiveAtom<Moment[]>;

    private transport: ColleagueTransport = LiveTransport;
    private rev = 0;
    private lastInputAt: number = null;
    private reported: PageFacts = null;

    private constructor() {}

    static getInstance(): BrokkColleagueModel {
        if (BrokkColleagueModel.instance == null) {
            BrokkColleagueModel.instance = new BrokkColleagueModel();
        }
        return BrokkColleagueModel.instance;
    }

    static resetInstance(): void {
        BrokkColleagueModel.instance = null;
    }

    // Tests give a transport of their own.
    useTransport(transport: Partial<ColleagueTransport>): void {
        this.transport = { ...LiveTransport, ...transport };
        this.rev = 0;
        this.lastInputAt = null;
        this.reported = null;
        globalStore.set(this.momentsAtom, []);
    }

    // The owner's moments, unless this page holds newer ones: the first answer and the pushes can arrive in either order.
    private receive(update: MomentsUpdate): void {
        if (update == null || !Array.isArray(update.moments) || !(update.rev > this.rev)) {
            return;
        }
        this.rev = update.rev;
        globalStore.set(this.momentsAtom, update.moments);
    }

    // An input of the developer, told by the expressions watch.
    noteInput(): void {
        const now = this.transport.now();
        if (this.lastInputAt != null && now - this.lastInputAt < InputEveryMs) {
            return;
        }
        this.lastInputAt = now;
        const facts = this.transport.facts();
        this.reported = facts;
        this.transport.sendInput(facts);
    }

    private reportFacts(): void {
        const facts = this.transport.facts();
        if (this.reported != null && samePageFacts(this.reported, facts)) {
            return;
        }
        this.reported = facts;
        this.transport.sendFacts(facts);
    }

    // The moment is on screen. The owner decides who has it first: the moment as it now is (its words may have changed
    // with the part of the day), or null.
    noteShown(id: string): Moment {
        let shown: Moment = null;
        try {
            shown = this.transport.shown(id);
        } catch {
            shown = null;
        }
        if (shown == null) {
            return null;
        }
        globalStore.set(
            this.momentsAtom,
            globalStore.get(this.momentsAtom).map((moment) => (moment.id === id ? shown : moment))
        );
        return shown;
    }

    // The group closed on a moment the developer saw: it does not come back, in any window.
    noteSeen(id: string): void {
        this.transport.seen(id);
        const moments = globalStore.get(this.momentsAtom);
        if (moments.some((moment) => moment.id === id)) {
            globalStore.set(
                this.momentsAtom,
                moments.filter((moment) => moment.id !== id)
            );
        }
    }

    // Listens while the avatar is on screen: the owner tells the moments, and the page tells it the agents at work and the
    // setting when they change. Returns the stop.
    start(): () => void {
        const facts = this.transport.facts();
        this.reported = facts;
        const stopMoments = this.transport.onMoments((update) => this.receive(update));
        this.transport
            .start(facts)
            .then((update) => this.receive(update))
            .catch(() => {});
        const stopAgents = globalStore.sub(AgentStates.getInstance().dataAtom, () => this.reportFacts());
        const stopSetting = globalStore.sub(getSettingsKeyAtom(ProximitySettingKey as keyof SettingsType), () =>
            this.reportFacts()
        );
        return () => {
            stopMoments();
            stopAgents();
            stopSetting();
            this.transport.stop();
        };
    }
}
