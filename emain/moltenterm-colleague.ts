// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk as a kind colleague, in Electron main (FR-BOSS-009, AC72 to AC77, #2221): the one owner of the colleague's run,
// whichever tab or window the developer uses (moltenterm-colleague-owner.ts), and the IPC the pages speak to it with. It
// reads what outlives a run from the client's meta once, writes it back through one ordered writer, and asks his model
// on wavesrv's route (pkg/molten/brokksession), which counts the day's calls where they are made.

import { ClientService } from "@/app/store/services";
import { RpcApi } from "@/app/store/wshclientapi";
import type { WebContents } from "electron";
import { ElectronWshClient } from "./emain-wsh";
import { ColleagueHub, PageLike } from "./moltenterm-colleague-hub";
import {
    ColleagueFactsChannel,
    ColleagueInputChannel,
    ColleagueMomentsChannel,
    ColleagueSeenChannel,
    ColleagueShownChannel,
    ColleagueStartChannel,
    ColleagueStopChannel,
} from "./moltenterm-colleague-ipc";
import {
    ColleagueMetaKey,
    makeSerialWriter,
    PhraseAsk,
    PhraseCommand,
    PhraseRouteId,
    PhraseTimeoutMs,
} from "./moltenterm-colleague-owner";
import { handleAppIpc, onAppIpc } from "./moltenterm-privileged-ipc";
import { systemIdleSec } from "./moltenterm-system-idle";

const LiveAsk: PhraseAsk = (request) =>
    ElectronWshClient.wshRpcCall(PhraseCommand, request, { route: PhraseRouteId, timeout: PhraseTimeoutMs });

function errorText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}

function pageOf(contents: WebContents): PageLike {
    return {
        id: contents.id,
        send: (update) => contents.send(ColleagueMomentsChannel, update),
        alive: () => !contents.isDestroyed(),
    };
}

// The client holds what outlives a run. A client that cannot be read leaves the colleague without memory and without a
// place to save it, which only costs a second greeting after a restart.
async function readClient(): Promise<{ oid: string; text: string }> {
    try {
        const client = await ClientService.GetClientData();
        const value = client?.meta?.[ColleagueMetaKey];
        return { oid: client?.oid ?? null, text: typeof value === "string" ? value : null };
    } catch (e) {
        console.log("brokk colleague: the client could not be read", errorText(e));
        return { oid: null, text: null };
    }
}

async function makeHub(): Promise<ColleagueHub> {
    const { oid, text } = await readClient();
    const save = makeSerialWriter(
        (saved) =>
            RpcApi.SetMetaCommand(ElectronWshClient, {
                oref: `client:${oid}`,
                meta: { [ColleagueMetaKey]: saved } as MetaType,
            }),
        (e) => console.log("brokk colleague: the memory could not be saved", errorText(e))
    );
    return new ColleagueHub(
        {
            now: () => Date.now(),
            random: () => Math.random(),
            write: (saved) => {
                if (oid != null) {
                    save(saved);
                }
            },
            ask: LiveAsk,
            idleSec: async () => systemIdleSec(),
            every: (ms, run) => {
                const timer = setInterval(run, ms);
                return () => clearInterval(timer);
            },
        },
        text
    );
}

const watchedPages = new WeakSet<WebContents>();

export function initMoltentermColleague(): void {
    let hub: ColleagueHub = null;
    const ready = makeHub().then((made) => {
        hub = made;
        return made;
    });
    // A page that starts before the client was read waits for it; an input or a report that comes before is dropped, the
    // next one comes within the second.
    handleAppIpc(ColleagueStartChannel, async (event, facts) => {
        const contents = event.sender;
        const made = await ready;
        if (!watchedPages.has(contents)) {
            watchedPages.add(contents);
            contents.once("destroyed", () => made.stop(contents.id));
        }
        return made.start(pageOf(contents), facts);
    });
    onAppIpc(ColleagueStopChannel, (event) => hub?.stop(event.sender.id));
    onAppIpc(ColleagueFactsChannel, (_event, facts) => hub?.facts(facts));
    onAppIpc(ColleagueInputChannel, (_event, facts) => hub?.input(facts));
    onAppIpc(ColleagueShownChannel, (event, id) => {
        event.returnValue = hub?.shown(id) ?? null;
    });
    onAppIpc(ColleagueSeenChannel, (_event, id) => hub?.seen(id));
}
