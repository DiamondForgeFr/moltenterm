// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";

const Mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: Mocks.call } }));

import {
    checkFilePath,
    FileApprovedMetaKey,
    fileAskOrigin,
    fileBookmarkMenu,
    FileCheckResult,
    FileConfineCheckCommand,
    FileConfineGate,
    FileConfineRoute,
    fileConfineScope,
    FileOriginMetaKey,
    FileOriginNameMetaKey,
    stayMeta,
} from "./file-confine";
import { fileConfineQuestion } from "./file-confine-confirm";

const Root = "/p/app";

// A text check standing for wavesrv's, with one symbolic link: /p/app/out-link resolves to /elsewhere.
async function fakeCheck(path: string, project: string): Promise<FileCheckResult> {
    const resolved = path.replace(/^\/p\/app\/out-link/, "/elsewhere");
    const inside = resolved === project || resolved.startsWith(project + "/");
    return { inside, path: resolved, project, isdir: !resolved.endsWith(".txt") };
}

type Fixture = {
    gate: FileConfineGate;
    blockAtom: PrimitiveAtom<Block>;
    workspaceAtom: PrimitiveAtom<Workspace>;
    writes: MetaType[];
    applied: number[];
};

function workspace(project: string, folder = ""): Workspace {
    const meta: Record<string, any> = {};
    if (project) {
        meta["molten:project"] = project;
    }
    if (folder) {
        meta["molten:folder"] = folder;
    }
    return { oid: "ws1", meta } as Workspace;
}

// Writes merge into the block like wavesrv does (null deletes), so the gate sees its own writes come back.
function fixture(meta: MetaType, ws: Workspace = workspace(Root)): Fixture {
    const blockAtom = atom({ oid: "b1", meta } as Block) as PrimitiveAtom<Block>;
    const workspaceAtom = atom(ws) as PrimitiveAtom<Workspace>;
    const writes: MetaType[] = [];
    const applied: number[] = [];
    const gate = new FileConfineGate({
        blockAtom,
        workspaceAtom,
        check: fakeCheck,
        writeMeta: async (update) => {
            writes.push(update);
            const next: Record<string, any> = { ...globalStore.get(blockAtom).meta };
            for (const [k, v] of Object.entries(update)) {
                if (v == null) {
                    delete next[k];
                } else {
                    next[k] = v;
                }
            }
            globalStore.set(blockAtom, { ...globalStore.get(blockAtom), meta: next as MetaType });
        },
        onApplied: () => applied.push(1),
    });
    gates.push(gate);
    return { gate, blockAtom, workspaceAtom, writes, applied };
}

const gates: FileConfineGate[] = [];

afterEach(() => {
    gates.splice(0).forEach((g) => g.dispose());
});

async function settle(gate: FileConfineGate) {
    await gate.evaluate();
}

function setMeta(f: Fixture, update: Record<string, any>) {
    const block = globalStore.get(f.blockAtom);
    globalStore.set(f.blockAtom, { ...block, meta: { ...block.meta, ...update } as MetaType });
}

describe("fileConfineScope", () => {
    it("confines a local panel of a workspace linked to a project", () => {
        expect(fileConfineScope(workspace(Root), "")).toEqual({ root: Root, name: "app" });
        expect(fileConfineScope(workspace(Root), "local")).not.toBeNull();
        expect(fileConfineScope(workspace(Root), "local:wsl-shell")).not.toBeNull();
    });

    it("leaves a workspace without a project and a remote panel alone (AC-10)", () => {
        expect(fileConfineScope(workspace(""), "")).toBeNull();
        expect(fileConfineScope(workspace(Root), "user@host")).toBeNull();
        expect(fileConfineScope(workspace(Root), "wsl://Ubuntu")).toBeNull();
    });
});

describe("fileAskOrigin", () => {
    it("names the agent, a command or the user", () => {
        expect(fileAskOrigin({ [FileOriginMetaKey]: "agent", [FileOriginNameMetaKey]: "Olivia" } as MetaType)).toEqual({
            kind: "agent",
            name: "Olivia",
        });
        expect(fileAskOrigin({ [FileOriginMetaKey]: "command" } as MetaType)).toEqual({ kind: "command" });
        expect(fileAskOrigin({ [FileOriginMetaKey]: "agent" } as MetaType)).toEqual({ kind: "command" });
        expect(fileAskOrigin({} as MetaType)).toEqual({ kind: "user" });
    });
});

describe("stayMeta", () => {
    it("writes the shown path back and takes it out of the history a drop pushed", () => {
        expect(stayMeta({ history: ["/a", "/p/app"] } as MetaType, "/p/app")).toEqual({
            file: "/p/app",
            history: ["/a"],
            [FileOriginMetaKey]: null,
            [FileOriginNameMetaKey]: null,
        });
        expect(stayMeta({ history: ["/a"] } as MetaType, "/p/app").history).toBeUndefined();
    });
});

describe("checkFilePath", () => {
    it("asks the molten route", async () => {
        Mocks.call.mockResolvedValueOnce({ inside: true, path: "/p/app/src" });
        expect(await checkFilePath("/p/app/src", Root)).toEqual({ inside: true, path: "/p/app/src" });
        expect(Mocks.call).toHaveBeenCalledWith(
            FileConfineCheckCommand,
            { path: "/p/app/src", project: Root },
            expect.objectContaining({ route: FileConfineRoute })
        );
    });

    it("compares the text when wavesrv cannot be asked", async () => {
        Mocks.call.mockRejectedValueOnce(new Error("no route"));
        expect((await checkFilePath("/etc", Root)).inside).toBe(false);
        Mocks.call.mockRejectedValueOnce(new Error("no route"));
        expect((await checkFilePath("/p/app/src", Root)).inside).toBe(true);
    });
});

describe("FileConfineGate", () => {
    it("shows a path inside the project at once", async () => {
        const f = fixture({ file: "/p/app/src" } as MetaType);
        await settle(f.gate);
        expect(globalStore.get(f.gate.shownPathAtom)).toBe("/p/app/src");
        expect(globalStore.get(f.gate.outsideAtom)).toBe(false);
        expect(globalStore.get(f.gate.pendingAtom)).toBeNull();
    });

    it("asks before the parent of the root, and Stay leaves the panel and its history as they were (AC-2, AC-4)", async () => {
        const f = fixture({ file: Root, history: ["/p/app/src"] } as MetaType);
        await settle(f.gate);
        const written = await f.gate.navigate({ file: "/p", history: ["/p/app/src", Root] } as MetaType);
        expect(written).toBe(false);
        expect(f.writes).toEqual([]);
        const pending = globalStore.get(f.gate.pendingAtom);
        expect(pending).toMatchObject({ target: "/p", origin: { kind: "user" }, projectName: "app" });
        await f.gate.stay();
        expect(f.writes).toEqual([]);
        expect(globalStore.get(f.gate.pendingAtom)).toBeNull();
        expect(globalStore.get(f.gate.shownPathAtom)).toBe(Root);
        expect(globalStore.get(f.blockAtom).meta.history).toEqual(["/p/app/src"]);
    });

    it("Open approves, moves without asking while outside, and coming back ends the approval (AC-5, AC-6)", async () => {
        const f = fixture({ file: Root } as MetaType);
        await settle(f.gate);
        await f.gate.navigate({ file: "/p" } as MetaType);
        await f.gate.openOutside();
        expect(f.applied).toEqual([1]);
        expect(globalStore.get(f.blockAtom).meta[FileApprovedMetaKey]).toBe(Root);
        await settle(f.gate);
        expect(globalStore.get(f.gate.shownPathAtom)).toBe("/p");
        expect(globalStore.get(f.gate.outsideAtom)).toBe(true);

        expect(await f.gate.navigate({ file: "/p/other" } as MetaType)).toBe(true);
        await settle(f.gate);
        expect(globalStore.get(f.gate.shownPathAtom)).toBe("/p/other");
        expect(globalStore.get(f.gate.pendingAtom)).toBeNull();

        expect(await f.gate.navigate({ file: Root } as MetaType)).toBe(true);
        expect(f.writes[f.writes.length - 1][FileApprovedMetaKey]).toBeNull();
        await settle(f.gate);
        expect(globalStore.get(f.gate.outsideAtom)).toBe(false);

        expect(await f.gate.navigate({ file: "/p" } as MetaType)).toBe(false);
        expect(globalStore.get(f.gate.pendingAtom)).not.toBeNull();
    });

    it("gates an agent's write already made, names the agent, and Stay writes the shown path back (AC-7)", async () => {
        const f = fixture({ file: "/p/app/src", history: [] } as MetaType);
        await settle(f.gate);
        setMeta(f, { file: "/etc", [FileOriginMetaKey]: "agent", [FileOriginNameMetaKey]: "Olivia" });
        await settle(f.gate);
        expect(globalStore.get(f.gate.shownPathAtom)).toBe("/p/app/src");
        const pending = globalStore.get(f.gate.pendingAtom);
        expect(pending).toMatchObject({
            target: "/etc",
            origin: { kind: "agent", name: "Olivia" },
            restore: "/p/app/src",
        });
        const t = (key: string, vars?: Record<string, any>) => `${key}:${JSON.stringify(vars ?? {})}`;
        expect(fileConfineQuestion(t, pending).who).toContain("Olivia");
        await f.gate.stay();
        expect(globalStore.get(f.blockAtom).meta.file).toBe("/p/app/src");
        expect(globalStore.get(f.blockAtom).meta[FileOriginMetaKey]).toBeUndefined();
        await settle(f.gate);
        expect(globalStore.get(f.gate.pendingAtom)).toBeNull();
        expect(globalStore.get(f.gate.shownPathAtom)).toBe("/p/app/src");
    });

    it("Open on an agent's write writes the approval only, then shows the target", async () => {
        const f = fixture({ file: "/p/app/src" } as MetaType);
        await settle(f.gate);
        setMeta(f, { file: "/etc", [FileOriginMetaKey]: "command" });
        await settle(f.gate);
        await f.gate.openOutside();
        expect(f.writes).toEqual([{ [FileApprovedMetaKey]: Root }]);
        await settle(f.gate);
        expect(globalStore.get(f.gate.shownPathAtom)).toBe("/etc");
        expect(globalStore.get(f.gate.outsideAtom)).toBe(true);
    });

    it("a panel opened outside the project asks, and Stay shows the workspace folder (AC-4)", async () => {
        const f = fixture({ file: "/etc" } as MetaType, workspace(Root, "/p/app/src"));
        await settle(f.gate);
        expect(globalStore.get(f.gate.shownPathAtom)).toBeNull();
        expect(globalStore.get(f.gate.pendingAtom)).toMatchObject({ target: "/etc", restore: "/p/app/src" });
        await f.gate.stay();
        expect(globalStore.get(f.blockAtom).meta.file).toBe("/p/app/src");
        await settle(f.gate);
        expect(globalStore.get(f.gate.shownPathAtom)).toBe("/p/app/src");
    });

    it("a link inside the project that resolves outside counts as outside (AC-8)", async () => {
        const f = fixture({ file: Root } as MetaType);
        await settle(f.gate);
        expect(await f.gate.navigate({ file: "/p/app/out-link" } as MetaType)).toBe(false);
        expect(globalStore.get(f.gate.pendingAtom)).toMatchObject({ resolved: "/elsewhere" });
    });

    it("names the file and its folder", async () => {
        const f = fixture({ file: Root } as MetaType);
        await settle(f.gate);
        await f.gate.navigate({ file: "/tmp/notes.txt" } as MetaType);
        const t = (key: string, vars?: Record<string, any>) => `${key}:${JSON.stringify(vars ?? {})}`;
        const { where } = fileConfineQuestion(t, globalStore.get(f.gate.pendingAtom));
        expect(where).toContain("fileConfine.fileOutside");
        expect(where).toContain('"file":"notes.txt"');
        expect(where).toContain('"folder":"/tmp"');
    });

    it("an approved panel restored after a restart shows its folder with the marker (TC-FILE-004)", async () => {
        const f = fixture({ file: "/etc", [FileApprovedMetaKey]: Root } as MetaType);
        await settle(f.gate);
        expect(globalStore.get(f.gate.shownPathAtom)).toBe("/etc");
        expect(globalStore.get(f.gate.outsideAtom)).toBe(true);
        expect(globalStore.get(f.gate.pendingAtom)).toBeNull();
    });

    it("an approval for another project does not count", async () => {
        const f = fixture({ file: "/etc", [FileApprovedMetaKey]: "/p/other" } as MetaType);
        await settle(f.gate);
        expect(globalStore.get(f.gate.pendingAtom)).not.toBeNull();
    });

    it("a project change never moves the panel: the marker follows (AC-11)", async () => {
        const f = fixture({ file: "/p/app/src" } as MetaType);
        await settle(f.gate);
        globalStore.set(f.workspaceAtom, workspace("/q/other"));
        await settle(f.gate);
        expect(globalStore.get(f.gate.shownPathAtom)).toBe("/p/app/src");
        expect(globalStore.get(f.gate.outsideAtom)).toBe(true);
        expect(globalStore.get(f.gate.pendingAtom)).toBeNull();
        expect(f.writes).toEqual([]);
    });

    it("without a project or on another connection, nothing is asked (AC-1, AC-10)", async () => {
        const f = fixture({ file: "/etc" } as MetaType, workspace(""));
        await settle(f.gate);
        expect(globalStore.get(f.gate.shownPathAtom)).toBe("/etc");
        expect(await f.gate.navigate({ file: "/" } as MetaType)).toBe(true);
        const remote = fixture({ file: "/etc", connection: "user@host" } as MetaType);
        await settle(remote.gate);
        expect(globalStore.get(remote.gate.pendingAtom)).toBeNull();
        expect(globalStore.get(remote.gate.outsideAtom)).toBe(false);
    });

    it("a user navigation clears the origin an agent left", async () => {
        const f = fixture({
            file: "/p/app",
            [FileOriginMetaKey]: "agent",
            [FileOriginNameMetaKey]: "Olivia",
        } as MetaType);
        await settle(f.gate);
        await f.gate.navigate({ file: "/p/app/src" } as MetaType);
        expect(f.writes[0]).toMatchObject({ [FileOriginMetaKey]: null, [FileOriginNameMetaKey]: null });
    });
});

describe("fileBookmarkMenu", () => {
    it("lists the project root first, then the fixed bookmarks (AC-9)", () => {
        const go = vi.fn();
        const items = fileBookmarkMenu({ root: Root, name: "app" }, go);
        expect(items[0].label).toContain(Root);
        items[0].click();
        expect(go).toHaveBeenCalledWith(Root);
        expect(items[1].type).toBe("separator");
        expect(items.length).toBe(7);
        expect(fileBookmarkMenu(null, go).length).toBe(5);
    });
});
