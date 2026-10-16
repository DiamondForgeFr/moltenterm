// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The seen rule of the agent marks (#784): green means finished and not seen yet. Each tab view watches the done
// agents it shows (doneAgentsInView) and tells wavesrv once the user has seen one; wavesrv clears it to idle for every
// window, so the pane dot, the tab, the workspace and the rail follow, and the agent's unread "is done" notifications
// are read.

import { atoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { fireAndForget } from "@/util/util";
import { atom, Atom } from "jotai";
import {
    AgentSeenDwellMs,
    AgentSeenView,
    AgentStateInfo,
    AgentStateSeenCommand,
    AgentStatesData,
    AgentStatesRoute,
    doneAgentsInView,
} from "./agent-state-model";
import { AgentStates } from "./agent-state-store";
import { checkUnread, MoltentermNotification } from "./notifications-model";
import { MoltentermNotifications } from "./notifications-store";
import { TabActivity } from "./tab-activity";

const SeenTimeoutMs = 5000;
// must match molten.NotificationTitleAgentDone in pkg/molten/notifications.go
const AgentDoneTitleCode = "agentdone";

export type AgentSeenSource = { data: AgentStatesData; view: AgentSeenView };

type Pending = { version: number; timer: ReturnType<typeof setTimeout> };

// Follows source and calls send once per done version seen: at once for the focused pane, after AgentSeenDwellMs of
// continuous view for the others. Kept apart from the app's atoms so the timing is tested with fake timers.
export class AgentSeenWatcher {
    source: Atom<AgentSeenSource>;
    send: (info: AgentStateInfo) => Promise<void>;
    pending = new Map<string, Pending>();
    sent = new Set<string>();

    constructor(source: Atom<AgentSeenSource>, send: (info: AgentStateInfo) => Promise<void>) {
        this.source = source;
        this.send = send;
    }

    start(): () => void {
        this.apply();
        const unsubscribe = globalStore.sub(this.source, () => this.apply());
        return () => {
            unsubscribe();
            for (const p of this.pending.values()) {
                clearTimeout(p.timer);
            }
            this.pending.clear();
        };
    }

    apply(): void {
        const { data, view } = globalStore.get(this.source);
        const { focused, shown } = doneAgentsInView(data, view);
        for (const info of focused) {
            this.cancel(info.blockid);
            this.seen(info);
        }
        const kept = new Set<string>();
        for (const info of shown) {
            kept.add(info.blockid);
            const p = this.pending.get(info.blockid);
            if (p != null && p.version === info.version) {
                continue;
            }
            this.cancel(info.blockid);
            const timer = setTimeout(() => {
                this.pending.delete(info.blockid);
                this.seen(info);
            }, AgentSeenDwellMs);
            this.pending.set(info.blockid, { version: info.version, timer });
        }
        for (const blockId of [...this.pending.keys()]) {
            if (!kept.has(blockId)) {
                this.cancel(blockId);
            }
        }
    }

    cancel(blockId: string): void {
        const p = this.pending.get(blockId);
        if (p == null) {
            return;
        }
        clearTimeout(p.timer);
        this.pending.delete(blockId);
    }

    seen(info: AgentStateInfo): void {
        const key = `${info.blockid}:${info.version}`;
        if (this.sent.has(key)) {
            return;
        }
        this.sent.add(key);
        fireAndForget(async () => {
            try {
                await this.send(info);
            } catch (e) {
                this.sent.delete(key);
                console.log("agent seen:", e?.message ?? e);
            }
        });
    }
}

// The agent's unread notifications saying it is done: from its hook (titled by code) or its own terminal signal.
export function unreadDoneNotifications(entries: MoltentermNotification[], blockId: string): string[] {
    return entries
        .filter(
            (e) =>
                e.blockid === blockId &&
                checkUnread(e) &&
                e.source === "agent" &&
                (e.titlecode === AgentDoneTitleCode || e.kind === "success")
        )
        .map((e) => e.id);
}

function makeViewSourceAtom(): Atom<AgentSeenSource> {
    const activity = TabActivity.getInstance();
    const store = AgentStates.getInstance();
    return atom((get) => {
        const data = get(store.dataAtom);
        const tabId = get(atoms.staticTabId);
        const active = get(activity.stateAtom) === "active";
        if (!active || tabId == null) {
            return { data, view: { active: false, blockIds: [], focusedBlockId: null } };
        }
        const tab = get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
        const layout = getLayoutModelForStaticTab();
        const focusedBlockId = layout?.focusedNode == null ? null : (get(layout.focusedNode)?.data?.blockId ?? null);
        return { data, view: { active, blockIds: tab?.blockids ?? [], focusedBlockId } };
    });
}

async function sendSeen(info: AgentStateInfo): Promise<void> {
    await TabRpcClient.wshRpcCall(
        AgentStateSeenCommand,
        { blockid: info.blockid, version: info.version },
        { route: AgentStatesRoute, timeout: SeenTimeoutMs }
    );
    const notifications = MoltentermNotifications.getInstance();
    const ids = unreadDoneNotifications(notifications.entries(), info.blockid);
    if (ids.length > 0) {
        notifications.markRead(ids);
    }
}

// Started once per tab view, with the notification center.
export function startAgentSeen(): () => void {
    TabActivity.getInstance().start();
    return new AgentSeenWatcher(makeViewSourceAtom(), sendSeen).start();
}
