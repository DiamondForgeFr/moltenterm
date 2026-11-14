// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import type { PrimitiveAtom } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return { atoms: { workspace: atom({ oid: "ws-current" }) }, getApi: () => ({}) };
});
vi.mock("@/app/store/services", () => ({ WorkspaceService: {} }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: {} }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("../workspace-create", () => ({ createWorkspace: vi.fn() }));
vi.mock("../workspace-project-store", () => ({ chooseMoltentermPath: vi.fn(), linkWorkspaceProject: vi.fn() }));
vi.mock("../sidebar/sidebar-switch", () => ({ switchFromSidebar: vi.fn() }));
const end = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
vi.mock("./brainstorm-store", async () => {
    const { atom } = await import("jotai");
    const { globalStore } = await import("@/app/store/jotaiStore");
    const stateAtom = atom(null) as PrimitiveAtom<any>;
    const model = {
        stateAtom,
        apply: (next: any) => next != null && globalStore.set(stateAtom, next),
        refresh: async () => {
            refresh();
        },
        end: async () => {
            end();
            globalStore.set(stateAtom, { ...globalStore.get(stateAtom), open: false });
        },
    };
    return { BrainstormModel: { getInstance: () => model } };
});

import { globalStore } from "@/app/store/jotaiStore";
import { ProjectCreateCommand, ProjectLinkedCommand, ProjectPreviewCommand } from "./brainstorm-boot";
import { BrainstormProjectModel, ProjectDeps, ProjectsDirKey } from "./brainstorm-project-store";
import { BrainstormModel } from "./brainstorm-store";

const brainstorm = BrainstormModel.getInstance() as any;

const brief = {
    schema: "projectbrief",
    version: 1,
    id: "b1",
    source: "brokk",
    brainstorm: "id-kids",
    created: 1,
    name: "Safe Kids Videos",
    slug: "safe-kids-videos",
    pitch: "A video app where parents validate every video.",
    problem: "Children's apps play what nobody chose.",
    users: "Parents of children from 3 to 10.",
};

const Parent = "/synthetic/Projects";
const Dir = `${Parent}/safe-kids-videos`;

const clearState = () => ({
    allowed: true,
    open: true,
    version: 3,
    swap: 2,
    brainstorm: {
        id: "id-kids",
        slug: "kids",
        title: "Kids",
        dir: "/synthetic/Brainstorms/kids",
        created: 1,
        updated: 2,
        state: "clear",
        turns: 4,
    },
    brief,
});

const promotedState = (workspace = "") => {
    const s = clearState();
    return {
        ...s,
        version: 4,
        brainstorm: { ...s.brainstorm, state: "promoted", promotedto: { dir: Dir, workspace, at: 5 } },
    };
};

// A fake wavesrv: the calls the card made, and its answers.
function fakeWavesrv(answers: Record<string, (data: any) => any>) {
    const calls: { command: string; data: any }[] = [];
    return {
        calls,
        call: async (command: string, data: any) => {
            calls.push({ command, data });
            return answers[command]?.(data) ?? null;
        },
    };
}

function deps(extra: Partial<ProjectDeps> = {}): ProjectDeps & { log: string[] } {
    const log: string[] = [];
    return {
        log,
        call: async () => null,
        createWorkspace: async (draft) => {
            log.push(`create ${draft.name} ${draft.folder}`);
            return "ws-new";
        },
        linkWorkspace: async (id, dir) => {
            log.push(`link ${id} ${dir}`);
        },
        listWorkspaces: async () => [
            { id: "ws-current", name: "Atelier" },
            { id: "ws-other", name: "Side projects" },
        ],
        chooseFolder: async () => "/synthetic/Elsewhere",
        rememberParent: async (parent) => {
            log.push(`remember ${parent}`);
        },
        reveal: (dir) => log.push(`reveal ${dir}`),
        switchTo: (id) => log.push(`switch ${id}`),
        currentWorkspace: () => "ws-current",
        ...extra,
    };
}

const preview = { parent: Parent, name: "safe-kids-videos", path: Dir, docs: "docs/brainstorm.md" };

beforeEach(() => {
    BrainstormProjectModel.resetInstance();
    end.mockReset();
    globalStore.set(brainstorm.stateAtom, clearState());
});

// FR-BOSS-010 AC15, AC-2, AC-3 (#2250).
describe("the project card's work (#2250)", () => {
    it("previews for the brainstorm on screen, with the developer's name once typed", async () => {
        const wavesrv = fakeWavesrv({ [ProjectPreviewCommand]: () => ({ state: clearState(), preview }) });
        const model = BrainstormProjectModel.getInstance();
        model.useDeps(deps({ call: wavesrv.call }));
        await model.show();
        expect(wavesrv.calls).toEqual([{ command: ProjectPreviewCommand, data: { swap: 2, id: "id-kids" } }]);
        expect(globalStore.get(model.previewAtom)).toEqual(preview);
        expect(globalStore.get(model.workspacesAtom)).toHaveLength(2);
        globalStore.set(model.nameAtom, "Kids");
        await model.refreshPreview();
        expect(wavesrv.calls[1].data).toEqual({ name: "Kids", swap: 2, id: "id-kids" });
    });

    it("on the click, makes the project, then a new workspace named after it, and tells wavesrv", async () => {
        const wavesrv = fakeWavesrv({
            [ProjectPreviewCommand]: () => ({ state: clearState(), preview }),
            [ProjectCreateCommand]: () => ({ state: promotedState(), preview, dir: Dir }),
            [ProjectLinkedCommand]: () => ({ state: promotedState("ws-new") }),
        });
        const d = deps({ call: wavesrv.call });
        const model = BrainstormProjectModel.getInstance();
        model.useDeps(d);
        await model.show();
        expect(await model.create()).toBe(true);
        expect(wavesrv.calls.map((c) => c.command)).toEqual([
            ProjectPreviewCommand,
            ProjectCreateCommand,
            ProjectLinkedCommand,
        ]);
        expect(d.log).toEqual([`create Safe Kids Videos ${Dir}`]);
        // The click carries the preview the developer saw (AC-2).
        expect(wavesrv.calls[1].data).toMatchObject({ expect: { path: Dir, exists: false }, swap: 2, id: "id-kids" });
        expect(wavesrv.calls[2].data).toMatchObject({ id: "id-kids", dir: Dir, workspace: "ws-new" });
        expect((globalStore.get(brainstorm.stateAtom) as any).brainstorm.promotedto.workspace).toBe("ws-new");
        expect(globalStore.get(model.busyAtom)).toBe(false);
    });

    // AC-2, review of #2250: a name typed or a parent chosen drops the preview at once, so the click waits for the new
    // one; a create wavesrv finds stale makes nothing here and previews again.
    it("holds the click until the preview of what is typed, and previews again when wavesrv says stale", async () => {
        let previews = 0;
        const wavesrv = fakeWavesrv({
            [ProjectPreviewCommand]: () => {
                previews++;
                return { state: clearState(), preview };
            },
            [ProjectCreateCommand]: () => ({
                state: clearState(),
                preview: { ...preview, path: "/other" },
                stale: true,
            }),
        });
        const d = deps({ call: wavesrv.call });
        const model = BrainstormProjectModel.getInstance();
        model.useDeps(d);
        await model.show();
        model.setName("Kids");
        expect(globalStore.get(model.previewAtom)).toBeNull();
        expect(await model.create()).toBe(false);
        expect(wavesrv.calls.some((c) => c.command === ProjectCreateCommand)).toBe(false);
        await model.refreshPreview();
        const before = previews;
        expect(await model.create()).toBe(false);
        expect(previews).toBe(before + 1);
        await vi.waitFor(() => expect(globalStore.get(model.previewAtom)).toEqual(preview), { timeout: 30000 });
        expect(d.log).toEqual([]);
        expect(wavesrv.calls.some((c) => c.command === ProjectLinkedCommand)).toBe(false);
    });

    // Review of #2250: no answer to the click never says nothing was made: the result is unknown, and wavesrv's state is
    // read again.
    it("says the result is unknown when wavesrv does not answer the click", async () => {
        const wavesrv = fakeWavesrv({ [ProjectPreviewCommand]: () => ({ state: clearState(), preview }) });
        const model = BrainstormProjectModel.getInstance();
        model.useDeps(deps({ call: wavesrv.call }));
        refresh.mockReset();
        await model.show();
        expect(await model.create()).toBe(false);
        expect(globalStore.get(model.failureAtom)).toBe("unknown");
        expect(refresh).toHaveBeenCalled();
    });

    // Review of #2250: Try again after a failed link links the workspace made the first time, never a second one; a link
    // wavesrv refuses is a failed link too.
    it("never makes a second workspace on Try again", async () => {
        let linkedAnswers = 0;
        const wavesrv = fakeWavesrv({
            [ProjectPreviewCommand]: () => ({ state: clearState(), preview }),
            [ProjectCreateCommand]: () => ({ state: promotedState(), preview, dir: Dir }),
            [ProjectLinkedCommand]: () =>
                ++linkedAnswers === 1
                    ? { state: promotedState(), error: "unknown" }
                    : { state: promotedState("ws-new") },
        });
        const d = deps({ call: wavesrv.call });
        const model = BrainstormProjectModel.getInstance();
        model.useDeps(d);
        await model.show();
        expect(await model.create()).toBe(false);
        expect(globalStore.get(model.failureAtom)).toBe("link");
        expect(await model.link(Dir)).toBe(true);
        expect(d.log).toEqual([`create Safe Kids Videos ${Dir}`, `link ws-new ${Dir}`]);
        expect(wavesrv.calls.filter((c) => c.command === ProjectLinkedCommand).map((c) => c.data.workspace)).toEqual([
            "ws-new",
            "ws-new",
        ]);
    });

    it("links again the workspace made when the folder's link then failed inside its creation", async () => {
        const wavesrv = fakeWavesrv({
            [ProjectPreviewCommand]: () => ({ state: clearState(), preview }),
            [ProjectCreateCommand]: () => ({ state: promotedState(), preview, dir: Dir }),
            [ProjectLinkedCommand]: () => ({ state: promotedState("ws-made") }),
        });
        const created: string[] = [];
        const d = deps({
            call: wavesrv.call,
            createWorkspace: async (_draft, onCreated) => {
                created.push("ws-made");
                onCreated?.("ws-made");
                throw new Error("synthetic: the folder's link failed");
            },
        });
        const model = BrainstormProjectModel.getInstance();
        model.useDeps(d);
        await model.show();
        expect(await model.create()).toBe(false);
        expect(await model.link(Dir)).toBe(true);
        expect(created).toEqual(["ws-made"]);
        expect(d.log).toEqual([`link ws-made ${Dir}`]);
    });

    it("links an existing workspace through linkWorkspaceProject when the developer picks one", async () => {
        const wavesrv = fakeWavesrv({
            [ProjectPreviewCommand]: () => ({ state: clearState(), preview }),
            [ProjectCreateCommand]: () => ({ state: promotedState(), preview, dir: Dir }),
            [ProjectLinkedCommand]: () => ({ state: promotedState("ws-other") }),
        });
        const d = deps({ call: wavesrv.call });
        const model = BrainstormProjectModel.getInstance();
        model.useDeps(d);
        await model.show();
        model.choose({ kind: "existing", id: "ws-other" });
        expect(await model.create()).toBe(true);
        expect(d.log).toEqual([`link ws-other ${Dir}`]);
    });

    // AC-4: a refusal says why and makes nothing; Try again asks the preview again.
    it("says a refusal and makes no workspace", async () => {
        const refused = { ...preview, refusal: "notempty" };
        const wavesrv = fakeWavesrv({
            [ProjectPreviewCommand]: () => ({ state: clearState(), preview }),
            [ProjectCreateCommand]: () => ({ state: clearState(), preview: refused, error: "notempty" }),
        });
        const d = deps({ call: wavesrv.call });
        const model = BrainstormProjectModel.getInstance();
        model.useDeps(d);
        await model.show();
        expect(await model.create()).toBe(false);
        expect(globalStore.get(model.failureAtom)).toBe("notempty");
        expect(globalStore.get(model.previewAtom)).toEqual(refused);
        expect(d.log).toEqual([]);
        expect(wavesrv.calls.some((c) => c.command === ProjectLinkedCommand)).toBe(false);
    });

    it("keeps the made folder when its workspace fails, and Try again links it", async () => {
        const wavesrv = fakeWavesrv({
            [ProjectPreviewCommand]: () => ({ state: clearState(), preview }),
            [ProjectCreateCommand]: () => ({ state: promotedState(), preview, dir: Dir }),
            [ProjectLinkedCommand]: () => ({ state: promotedState("ws-new") }),
        });
        let fail = true;
        const d = deps({
            call: wavesrv.call,
            createWorkspace: async () => {
                if (fail) {
                    throw new Error("synthetic");
                }
                return "ws-new";
            },
        });
        const model = BrainstormProjectModel.getInstance();
        model.useDeps(d);
        await model.show();
        expect(await model.create()).toBe(false);
        expect(globalStore.get(model.failureAtom)).toBe("link");
        fail = false;
        expect(await model.link(Dir)).toBe(true);
        expect(wavesrv.calls.filter((c) => c.command === ProjectCreateCommand)).toHaveLength(1);
        expect(globalStore.get(model.failureAtom)).toBeNull();
    });

    it("remembers the parent folder chosen, then previews under it", async () => {
        const wavesrv = fakeWavesrv({ [ProjectPreviewCommand]: () => ({ state: clearState(), preview }) });
        const d = deps({ call: wavesrv.call });
        const model = BrainstormProjectModel.getInstance();
        model.useDeps(d);
        await model.chooseParent("Where your projects go");
        expect(d.log).toEqual(["remember /synthetic/Elsewhere"]);
        expect(ProjectsDirKey).toBe("boss:projectsdir");
        expect(wavesrv.calls.at(-1).data).toMatchObject({ parent: "/synthetic/Elsewhere" });
    });

    it("goes to the workspace after leaving the brainstorm, and stays when it is this one", async () => {
        const d = deps();
        const model = BrainstormProjectModel.getInstance();
        model.useDeps(d);
        await model.goTo("ws-new");
        expect(end).toHaveBeenCalledTimes(1);
        expect(d.log).toEqual(["switch ws-new"]);
        await model.goTo("ws-current");
        expect(end).toHaveBeenCalledTimes(2);
        expect(d.log).toEqual(["switch ws-new"]);
        model.showFolder(Dir);
        expect(d.log.at(-1)).toBe(`reveal ${Dir}`);
    });

    it("does nothing without a brief", async () => {
        globalStore.set(brainstorm.stateAtom, { ...clearState(), brief: undefined });
        const wavesrv = fakeWavesrv({});
        const model = BrainstormProjectModel.getInstance();
        model.useDeps(deps({ call: wavesrv.call }));
        expect(await model.create()).toBe(false);
        await model.refreshPreview();
        expect(wavesrv.calls).toEqual([]);
    });
});
