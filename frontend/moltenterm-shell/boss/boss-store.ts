// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the foreman's avatar tells and the panel it opens (FR-BOSS-001 and FR-BOSS-009, #2002, #2003): the rows To handle,
// the count they make, the peek the avatar's tooltip shows, the one cue when the count rises, and the panel, which shows
// only when the developer asks for it and goes back to where the focus was when he hides it.
// Where the avatar sits and when Brokk comes are the hub's (brokk-hub-store.ts). Nothing here takes the focus or opens
// anything by itself: it only listens.

import { getSettingsKeyAtom, globalStore, WOS } from "@/app/store/global";
import { atom, Atom, PrimitiveAtom } from "jotai";
import { selectAtom } from "jotai/utils";
import { AgentStates } from "../agent-state-store";
import { I18nModel } from "../i18n/i18n";
import { keepAwakeActive } from "../keepawake-model";
import { KeepAwakeModel } from "../keepawake-store";
import { MoltentermNotifications } from "../notifications-store";
import { SharedReadiedAtom, SharedReviewsAnswersAtom } from "../reviews/reviews-state-atoms";
import { DurableSessions } from "../sessions/sessions-store";
import { FocusTarget, focusTargetOf, restoreFocus } from "./boss-card-model";
import {
    EmptyHandled,
    HandledKey,
    HandledRow,
    HandledRows,
    handledText,
    markRowHandled,
    mergeHandled,
    readHandled,
    sameHandled,
} from "./boss-handled";
import { PendingHandoffs } from "./boss-handoffs";
import { bossName, BossNameSettingKey, bossSettingOn, BossShowSettingKey } from "./boss-name";
import { Badge, BossPeek, makePeek, workingCount, workspaceNamesOf } from "./boss-overview";
import { buildToHandle, peekRowOf, toHandleBadge, ToHandleList } from "./boss-to-handle-model";
import { startUsageReadings, UsageReadingsAtom } from "./boss-usage";
import { PanelId, PanelRequest } from "./brokk-group-model";
import { arrivalsAfter, EmptyArrivals, unseenItems } from "./brokk-watch";

// The slice of the document the model listens on, so the rules run against a stand-in in the tests.
export type BossDom = {
    addEventListener: (type: string, listener: (event: any) => void, options?: any) => void;
    removeEventListener: (type: string, listener: (event: any) => void, options?: any) => void;
    activeElement?: any;
    body?: any;
    hasFocus?: () => boolean;
};

export type CloseCardOptions = {
    // The card hid because the developer went somewhere (a session, the full view): the focus is that place's.
    restoreFocus?: boolean;
};

function storage(): Storage {
    try {
        return globalThis.localStorage;
    } catch {
        return null;
    }
}

export class BossBubbleModel {
    private static instance: BossBubbleModel = null;

    // Changes when the count rose, to play the one cue again.
    cueAtom = atom(0) as PrimitiveAtom<number>;
    // His panel shows (FR-BOSS-009, AC9).
    cardOpenAtom = atom(false) as PrimitiveAtom<boolean>;
    // The tab a surface asked the panel to show: the panel reads it when it changes (showPanel).
    tabRequestAtom = atom(null) as PrimitiveAtom<PanelRequest>;
    // The To handle rows set aside with Later, by their key: back at the card's next opening (FR-BOSS-003).
    parkedAtom = atom({}) as PrimitiveAtom<Record<string, boolean>>;
    // The developer writes to him or his session answers (the field of the group): the title-bar face shows the sign of
    // a conversation then, and not merely because the group is open (FR-BOSS-009, AC17, #2032).
    talkingAtom = atom(false) as PrimitiveAtom<boolean>;
    // Something keeps this computer awake: the cup shows as a small mark on the title-bar face while the group is closed.
    keepAwakeAtom: Atom<boolean>;
    // The rows settled or ignored, for the episode they were in, shared by the views and windows of this computer
    // (FR-BOSS-009, AC16).
    handledAtom = atom(EmptyHandled) as PrimitiveAtom<HandledRows>;

    nameAtom: Atom<string>;
    showAtom: Atom<boolean>;
    // The rows the To handle tab shows, and the badge that counts them: the one cue follows the badge, whatever the row.
    toHandleAtom: Atom<ToHandleList>;
    badgeAtom: Atom<Badge>;
    // The agents at work: Brokk's face thinks while some do and nothing waits (FR-BOSS-007).
    workingCountAtom: Atom<number>;
    peekAtom: Atom<BossPeek>;

    // Where the focus was when the card opened, and the document it is given back in.
    private cardReturn: FocusTarget = null;
    private dom: BossDom = null;

    private constructor() {
        this.nameAtom = atom((get) => bossName(get(getSettingsKeyAtom(BossNameSettingKey as keyof SettingsType))));
        this.showAtom = atom((get) => bossSettingOn(get(getSettingsKeyAtom(BossShowSettingKey as keyof SettingsType))));
        this.toHandleAtom = atom((get) =>
            buildToHandle({
                states: get(AgentStates.getInstance().dataAtom),
                notifications: get(MoltentermNotifications.getInstance().shownEntriesAtom),
                answers: get(SharedReviewsAnswersAtom),
                readied: get(SharedReadiedAtom),
                sessions: get(DurableSessions.getInstance().dataAtom)?.sessions,
                parked: get(this.parkedAtom),
                handled: get(this.handledAtom),
                handoffs: get(PendingHandoffs.getInstance().dataAtom),
            })
        );
        this.badgeAtom = selectAtom(
            atom((get) => toHandleBadge(get(this.toHandleAtom))),
            (badge) => badge,
            (a, b) => a.count === b.count && a.tone === b.tone
        );
        this.workingCountAtom = atom((get) => workingCount(get(AgentStates.getInstance().dataAtom)));
        this.keepAwakeAtom = atom((get) => keepAwakeActive(get(KeepAwakeModel.getInstance().stateAtom)));
        this.peekAtom = atom((get) => {
            get(I18nModel.getInstance().localeAtom);
            const states = get(AgentStates.getInstance().dataAtom);
            return makePeek({
                states,
                toHandle: unseenItems(get(this.toHandleAtom)).map(peekRowOf),
                workspaceNames: workspaceNamesOf(states, (id) =>
                    get(WOS.getWaveObjectAtom<Workspace>(WOS.makeORef("workspace", id)))
                ),
                sessions: get(DurableSessions.getInstance().dataAtom)?.sessions ?? [],
                notifications: get(MoltentermNotifications.getInstance().entriesAtom),
                usage: get(UsageReadingsAtom),
                now: Date.now(),
            });
        });
    }

    static getInstance(): BossBubbleModel {
        if (BossBubbleModel.instance == null) {
            BossBubbleModel.instance = new BossBubbleModel();
        }
        return BossBubbleModel.instance;
    }

    // The developer's click (the avatar, the scene) or command (the palette) shows the card; nothing else does. The focus
    // moves into it because he asked, and goes back to returnTo (the element that held it) when the card hides. With Brokk
    // turned off only a gesture on a section (showPanel) opens it: the notifications and the downloads stay reachable.
    openCard(returnTo?: FocusTarget, options: { force?: boolean } = {}): void {
        if (globalStore.get(this.cardOpenAtom) || (!globalStore.get(this.showAtom) && options.force !== true)) {
            return;
        }
        this.cardReturn = returnTo ?? focusTargetOf(this.dom?.activeElement, this.dom);
        globalStore.set(this.parkedAtom, {});
        globalStore.set(this.tabRequestAtom, null);
        globalStore.set(this.cardOpenAtom, true);
    }

    // A tab of the panel, asked by the developer's gesture (a toast's Open, the downloads pill, a notification's View):
    // the panel opens on it, or goes to it when it is open.
    showPanel(tab: PanelId, highlight: string[] = []): void {
        this.openCard(undefined, { force: true });
        this.requestTab(tab, highlight);
    }

    // The same request from a source that has no gesture (a notification that asked for attention): it only shows in a
    // panel the developer opened already, and never opens one.
    showInOpenPanel(tab: PanelId, highlight: string[] = []): void {
        if (globalStore.get(this.cardOpenAtom)) {
            this.requestTab(tab, highlight);
        }
    }

    private requestTab(tab: PanelId, highlight: string[]): void {
        const seq = (globalStore.get(this.tabRequestAtom)?.seq ?? 0) + 1;
        globalStore.set(this.tabRequestAtom, { tab, seq, highlight });
    }

    // Sets a To handle row aside until the card is next opened (Later, FR-BOSS-003).
    park(key: string): void {
        globalStore.set(this.parkedAtom, { ...globalStore.get(this.parkedAtom), [key]: true });
    }

    // The developer settled or ignored this row (FR-BOSS-009, AC16): it stays away while the fact it shows stays what it
    // was. The marks other views wrote meanwhile are kept.
    settleRow(row: HandledRow): void {
        const now = Date.now();
        const store = storage();
        const shared = readHandled(store?.getItem(HandledKey), now);
        const next = markRowHandled(mergeHandled(globalStore.get(this.handledAtom), shared, now), row, now);
        globalStore.set(this.handledAtom, next);
        try {
            store?.setItem(HandledKey, handledText(next));
        } catch {
            // A full or missing storage only means this view's marks stay in this view.
        }
    }

    // Another view or window wrote the marks.
    handledChanged(raw: string): void {
        const now = Date.now();
        const current = globalStore.get(this.handledAtom);
        const next = mergeHandled(current, readHandled(raw, now), now);
        if (!sameHandled(next, current)) {
            globalStore.set(this.handledAtom, next);
        }
    }

    // Hides the card and leaves the app as it was: the focus goes back unless the developer put it elsewhere meanwhile
    // (a click outside lands first).
    closeCard(options: CloseCardOptions = {}): void {
        if (!globalStore.get(this.cardOpenAtom)) {
            return;
        }
        const target = this.cardReturn;
        const dom = this.dom;
        this.cardReturn = null;
        globalStore.set(this.tabRequestAtom, null);
        globalStore.set(this.cardOpenAtom, false);
        if (options.restoreFocus === false || target == null || dom == null) {
            return;
        }
        // The card leaves the page on the next render: look at the focus once it has.
        setTimeout(() => restoreFocus(target, dom), 0);
    }

    toggleCard(returnTo?: FocusTarget): void {
        if (globalStore.get(this.cardOpenAtom)) {
            this.closeCard();
            return;
        }
        this.openCard(returnTo);
    }

    // The badge rose: one cue, whatever the row that arrived (an agent, a failing CI, a ready pull request, a question,
    // a hand-off request: FR-BOSS-007, AC3), and only once the first readings are in (a window starting is not news; so
    // is a project's pull requests read for the first time). A row that comes back from Later is no arrival either
    // (brokk-watch.ts arrivalsAfter).
    private watchCount(): () => void {
        const agents = AgentStates.getInstance();
        const handoffs = PendingHandoffs.getInstance();
        let memory = EmptyArrivals;
        const check = () => {
            const list = globalStore.get(this.toHandleAtom);
            const step = arrivalsAfter(memory, {
                ready: globalStore.get(agents.loadedAtom) && globalStore.get(handoffs.loadedAtom),
                keys: [...list.items.map((item) => item.key), ...(list.parkedKeys ?? [])],
                unseenKeys: unseenItems(list).map((item) => item.key),
                reviewDirs: Object.keys(globalStore.get(SharedReviewsAnswersAtom) ?? {}),
            });
            memory = step.memory;
            if (step.arrived.length > 0) {
                globalStore.set(this.cueAtom, (n) => n + 1);
            }
        };
        const stops = [
            globalStore.sub(this.toHandleAtom, check),
            globalStore.sub(agents.loadedAtom, check),
            globalStore.sub(handoffs.loadedAtom, check),
        ];
        check();
        return () => stops.forEach((stop) => stop());
    }

    // Listens while a host is on screen: the count, the hand-off requests that wait (FR-BOSS-005), and the usage readings
    // the tooltip tells.
    attach(dom: BossDom): () => void {
        this.dom = dom;
        this.handledChanged(storage()?.getItem(HandledKey));
        const onStorage = (e: StorageEvent) => {
            if (e.key === HandledKey && e.newValue != null) {
                this.handledChanged(e.newValue);
            }
        };
        globalThis.addEventListener?.("storage", onStorage);
        const stopHandoffs = PendingHandoffs.getInstance().start();
        const stopCount = this.watchCount();
        const stopUsage = startUsageReadings();
        return () => {
            globalThis.removeEventListener?.("storage", onStorage);
            stopCount();
            stopHandoffs();
            stopUsage();
            globalStore.set(this.cardOpenAtom, false);
            this.cardReturn = null;
            this.dom = null;
        };
    }
}
