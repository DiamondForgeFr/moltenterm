// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { ClientModel } from "@/app/store/client-model";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { Provider, type PrimitiveAtom } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { moveSection, resetLayout, setSectionHidden } from "./companion-arrange-model";
import { CompanionPrefsMetaKey, MaxChosenTabs, readCompanionPrefs } from "./companion-files-model";
import { DefaultCompanionLayout, SectionPlacement } from "./companion-layout";
import { saveCompanionLayout, saveMilestoneChoice, useCompanionLayout, useMilestoneChoice } from "./companion-prefs";

vi.mock("@/app/store/client-model", async () => {
    const { atom } = await import("jotai");
    const metaAtom = atom<Record<string, unknown>>({});
    const instance = { clientId: "c1", metaAtom, clientAtom: atom((get) => ({ meta: get(metaAtom) })) };
    return { ClientModel: { getInstance: () => instance } };
});
vi.mock("@/app/store/wos", () => ({ makeORef: (type: string, id: string) => `${type}:${id}` }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: vi.fn() } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));

const setMeta = RpcApi.SetMetaCommand as unknown as ReturnType<typeof vi.fn>;
const metaAtom = () =>
    (ClientModel.getInstance() as unknown as { metaAtom: PrimitiveAtom<Record<string, unknown>> }).metaAtom;

function Probe() {
    return (
        <i
            data-order={useCompanionLayout()
                .map((p) => `${p.id}${p.hidden ? "!" : ""}`)
                .join(",")}
        />
    );
}

function shown(): string {
    return /data-order="([^"]*)"/.exec(
        renderToStaticMarkup(
            <Provider store={globalStore}>
                <Probe />
            </Provider>
        )
    )[1];
}

type Write = { oref: string; meta: Record<string, { layout?: SectionPlacement[]; filesopen?: boolean }> };
const written = (n: number): Write => setMeta.mock.calls[n][1];
const defaultOrder = DefaultCompanionLayout.map((p) => p.id).join(",");

// The writes of one test settle before the next one starts: a pending write holds the layout it saved.
const pending: (() => void)[] = [];

beforeEach(() => {
    setMeta.mockReset();
    globalStore.set(metaAtom(), {});
    setMeta.mockImplementation(() => new Promise<void>((resolve) => pending.push(resolve)));
});

afterEach(async () => {
    pending.splice(0).forEach((settle) => settle());
    await vi.waitFor(() => expect(shown()).toBe(defaultOrder));
});

async function settleWrites() {
    pending.splice(0).forEach((settle) => settle());
    await Promise.resolve();
    await Promise.resolve();
}

describe("the companion's saved layout (#2395)", () => {
    it("reads the default layout while none is saved", () => {
        expect(shown()).toBe(defaultOrder);
        saveCompanionLayout(DefaultCompanionLayout);
        saveCompanionLayout(resetLayout());
        expect(setMeta).not.toHaveBeenCalled();
    });

    it("writes the layout in the client's meta with the other choices, and shows it at once", async () => {
        globalStore.set(metaAtom(), { [CompanionPrefsMetaKey]: { filesopen: true } });
        const arranged = setSectionHidden(moveSection(DefaultCompanionLayout, 7, 0), "answer", true);
        saveCompanionLayout(arranged);
        expect(setMeta).toHaveBeenCalledTimes(1);
        expect(written(0).oref).toBe("client:c1");
        const prefs = written(0).meta[CompanionPrefsMetaKey];
        expect(prefs.filesopen).toBe(true);
        expect(prefs.layout.map((p) => p.id)).toEqual(arranged.map((p) => p.id));
        expect(prefs.layout.find((p) => p.id === "answer")).toEqual({ id: "answer", span: "flow", hidden: true });
        expect(shown()).toBe("files,permission,tasks,agents,usage,topics,answer!,task");
        await settleWrites();
    });

    it("writes nothing for the layout already in force", async () => {
        const arranged = moveSection(DefaultCompanionLayout, 7, 0);
        saveCompanionLayout(arranged);
        saveCompanionLayout(arranged.map((p) => ({ ...p })));
        expect(setMeta).toHaveBeenCalledTimes(1);
        await settleWrites();
        globalStore.set(metaAtom(), { [CompanionPrefsMetaKey]: { layout: arranged } });
        saveCompanionLayout(arranged);
        expect(setMeta).toHaveBeenCalledTimes(1);
        expect(shown()).toBe("files,permission,tasks,agents,usage,topics,answer,task");
        globalStore.set(metaAtom(), {});
    });

    it("keeps the layout across a restart: it is read back from the client's meta, in every companion", () => {
        const arranged = setSectionHidden(moveSection(DefaultCompanionLayout, 4, 0), "files", true);
        globalStore.set(metaAtom(), { [CompanionPrefsMetaKey]: { filesopen: false, layout: arranged } });
        expect(shown()).toBe("topics,permission,tasks,agents,usage,answer,task,files!");
        globalStore.set(metaAtom(), {});
    });

    it("stores the default layout as no layout, so a reset leaves nothing of the arrangement", async () => {
        const arranged = moveSection(DefaultCompanionLayout, 7, 0);
        globalStore.set(metaAtom(), { [CompanionPrefsMetaKey]: { filesopen: true, layout: arranged } });
        saveCompanionLayout(resetLayout());
        expect(setMeta).toHaveBeenCalledTimes(1);
        const prefs = written(0).meta[CompanionPrefsMetaKey];
        expect(prefs.layout).toBeUndefined();
        expect(prefs.filesopen).toBe(true);
        expect(JSON.parse(JSON.stringify(prefs))).not.toHaveProperty("layout");
        expect(shown()).toBe(defaultOrder);
        await settleWrites();
        globalStore.set(metaAtom(), {});
    });

    it("ignores what a stored layout cannot hold, and keeps the rest", () => {
        globalStore.set(metaAtom(), {
            [CompanionPrefsMetaKey]: {
                layout: [
                    { id: "files", span: "flow" },
                    { id: "gone", span: "full" },
                    { id: "tasks", span: "middle" },
                ],
            },
        });
        expect(shown()).toBe("files,tasks,permission,agents,usage,topics,answer,task");
        globalStore.set(metaAtom(), {});
    });
});

function Choice({ dir }: { dir: string }) {
    const [milestone] = useMilestoneChoice(dir);
    return <i data-milestone={milestone} />;
}

function choice(dir: string): number {
    return Number(
        /data-milestone="(\d+)"/.exec(
            renderToStaticMarkup(
                <Provider store={globalStore}>
                    <Choice dir={dir} />
                </Provider>
            )
        )[1]
    );
}

// A write that settled leaves the client's meta carrying the choice: the window stops holding its own copy.
async function settleChoices() {
    await settleWrites();
    await vi.waitFor(() => expect(choice("/never-chosen")).toBe(0));
    globalStore.set(metaAtom(), {});
}

describe("the milestone tab the developer chose (#2416)", () => {
    it("is none while nothing was chosen, and shows a choice at once, for its project only", async () => {
        expect(choice("/shop")).toBe(0);
        saveMilestoneChoice("/shop", 14);
        expect(choice("/shop")).toBe(14);
        expect(choice("/blog")).toBe(0);
        expect(setMeta).toHaveBeenCalledTimes(1);
        await settleChoices();
    });

    it("writes it in the client's meta with the other choices, and keeps what other projects chose", async () => {
        globalStore.set(metaAtom(), { [CompanionPrefsMetaKey]: { filesopen: true, milestonetabs: { "/blog": 3 } } });
        saveMilestoneChoice("/shop", 14);
        const prefs = written(0).meta[CompanionPrefsMetaKey] as unknown as {
            filesopen: boolean;
            milestonetabs: Record<string, number>;
        };
        expect(prefs.filesopen).toBe(true);
        expect(prefs.milestonetabs).toEqual({ "/blog": 3, "/shop": 14 });
        expect(choice("/blog")).toBe(3);
        await settleChoices();
    });

    it("is read back from the client's meta after a restart, in every companion of the project", () => {
        globalStore.set(metaAtom(), { [CompanionPrefsMetaKey]: { milestonetabs: { "/shop": 14 } } });
        expect(choice("/shop")).toBe(14);
        expect(choice("/shop")).toBe(14);
        globalStore.set(metaAtom(), {});
    });

    it("writes nothing for the choice already in force, for no folder and for no milestone", async () => {
        saveMilestoneChoice("/shop", 14);
        saveMilestoneChoice("/shop", 14);
        saveMilestoneChoice("", 14);
        saveMilestoneChoice("/shop", 0);
        saveMilestoneChoice("/shop", -2);
        expect(setMeta).toHaveBeenCalledTimes(1);
        await settleChoices();
        globalStore.set(metaAtom(), { [CompanionPrefsMetaKey]: { milestonetabs: { "/shop": 14 } } });
        saveMilestoneChoice("/shop", 14);
        expect(setMeta).toHaveBeenCalledTimes(1);
        globalStore.set(metaAtom(), {});
    });

    it("changes with a new choice, and keeps only the latest few projects", async () => {
        saveMilestoneChoice("/shop", 14);
        saveMilestoneChoice("/shop", 13);
        expect(choice("/shop")).toBe(13);
        await settleChoices();
        for (let i = 0; i < MaxChosenTabs + 3; i++) {
            saveMilestoneChoice(`/p${i}`, i + 1);
        }
        const kept = Object.keys(
            (
                written(setMeta.mock.calls.length - 1).meta[CompanionPrefsMetaKey] as unknown as {
                    milestonetabs: Record<string, number>;
                }
            ).milestonetabs
        );
        expect(kept).toHaveLength(MaxChosenTabs);
        expect(kept[0]).toBe("/p3");
        expect(kept[kept.length - 1]).toBe(`/p${MaxChosenTabs + 2}`);
        await settleChoices();
    });

    // #2418: the Taken by others group is open, folded, or never chosen (the block's width decides then).
    it("reads whether the Taken by others group was left open or folded, and none when never chosen", () => {
        expect(readCompanionPrefs({ takenopen: true }).takenopen).toBe(true);
        expect(readCompanionPrefs({ takenopen: false }).takenopen).toBe(false);
        expect(readCompanionPrefs({}).takenopen).toBeUndefined();
        expect(readCompanionPrefs({ takenopen: "yes" }).takenopen).toBeUndefined();
        expect(readCompanionPrefs(null).takenopen).toBeUndefined();
    });

    it("ignores what a stored choice cannot hold, and keeps the rest", () => {
        expect(
            readCompanionPrefs({ milestonetabs: { "/shop": 14, "/blog": "3", "/x": -1, "/y": 1.5, "": 4 } })
                .milestonetabs
        ).toEqual({ "/shop": 14 });
        expect(readCompanionPrefs({ milestonetabs: ["/shop"] }).milestonetabs).toBeUndefined();
        expect(readCompanionPrefs({ milestonetabs: {} }).milestonetabs).toBeUndefined();
        expect(readCompanionPrefs({}).milestonetabs).toBeUndefined();
    });
});
