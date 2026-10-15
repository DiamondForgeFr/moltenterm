// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// FR-MORPH-012, TC-MORPH-013, TC-MORPH-014: the host undoes what a mod's code added to the page.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modIdForScript } from "./molten-budget";
import { MoltenHost, MoltenHostEnv } from "./molten-host";
import { MoltenPageGuard, MoltenPageNode, stackFrameUrl } from "./molten-page";

// A minimal DOM: the methods live on the prototype, as in a browser, so the guard's own-property wrappers shadow them.
class FakeNode {
    tag: string;
    childNodes: FakeNode[] = [];
    parentNode: FakeNode = null;

    constructor(tag: string) {
        this.tag = tag;
    }

    detachChild(child: FakeNode): void {
        child.parentNode?.removeChild(child);
    }

    insertAt(index: number, child: FakeNode): void {
        this.detachChild(child);
        child.parentNode = this;
        this.childNodes.splice(index, 0, child);
    }

    appendChild(child: FakeNode): FakeNode {
        this.insertAt(this.childNodes.length, child);
        return child;
    }

    insertBefore(child: FakeNode, ref: FakeNode): FakeNode {
        this.detachChild(child);
        const index = ref == null ? this.childNodes.length : this.childNodes.indexOf(ref);
        this.insertAt(index, child);
        return child;
    }

    removeChild(child: FakeNode): FakeNode {
        const index = this.childNodes.indexOf(child);
        if (index < 0) {
            throw new Error("not a child");
        }
        this.childNodes.splice(index, 1);
        child.parentNode = null;
        return child;
    }

    replaceChild(child: FakeNode, old: FakeNode): FakeNode {
        this.insertBefore(child, old);
        return this.removeChild(old);
    }

    append(...nodes: FakeNode[]): void {
        nodes.forEach((n) => this.appendChild(n));
    }

    prepend(...nodes: FakeNode[]): void {
        [...nodes].reverse().forEach((n) => this.insertAt(0, n));
    }

    insertAdjacentElement(position: string, el: FakeNode): FakeNode {
        if (position === "beforeend") {
            return this.appendChild(el);
        }
        if (position === "afterbegin") {
            this.insertAt(0, el);
            return el;
        }
        const parent = this.parentNode;
        const index = parent.childNodes.indexOf(this);
        parent.insertAt(position === "beforebegin" ? index : index + 1, el);
        return el;
    }

    insertAdjacentHTML(position: string, html: string): void {
        const tag = /^<(\w+)/.exec(html)?.[1] ?? "#text";
        this.insertAdjacentElement(position, new FakeNode(tag));
    }
}

type FakeDocument = {
    documentElement: FakeNode;
    head: FakeNode;
    body: FakeNode;
    createElement: (tag: string) => FakeNode;
};

function makeDocument(): FakeDocument {
    const html = new FakeNode("html");
    const head = html.appendChild(new FakeNode("head"));
    const body = html.appendChild(new FakeNode("body"));
    return { documentElement: html, head, body, createElement: (tag) => new FakeNode(tag) };
}

// Code that runs as a mod's: compiled with the sourceURL MoltenTerm gives a mod's module (molten-start.ts).
function modCode<T>(id: string, body: string, ...args: [string, any][]): T {
    const fn = new Function(...args.map(([name]) => name), `${body}\n//# sourceURL=molten-mod://${id}/main.js\n`);
    return fn(...args.map(([, value]) => value));
}

function tags(node: FakeNode): string[] {
    return node.childNodes.map((n) => n.tag);
}

const ModsDir = "/cfg/mods";
const StateFile = "/cfg/molten/mods.json";
const TrustFile = "/data/molten/trust.json";

function makeEnv(modules: Record<string, any>, enabled: { ids: string[] }, page?: MoltenPageGuard): MoltenHostEnv {
    return {
        modsDir: ModsDir,
        stateFile: StateFile,
        trustFile: TrustFile,
        listDir: async () => Object.keys(modules).map((name) => ({ name, isDir: true })),
        readTextFile: async (path: string) => {
            if (path === StateFile) {
                return JSON.stringify({ enabled: enabled.ids });
            }
            if (path === TrustFile) {
                return JSON.stringify({ trusted: Object.fromEntries(Object.keys(modules).map((id) => [id, {}])) });
            }
            const [id, file] = path.slice(ModsDir.length + 1).split("/");
            if (file === "mod.json") {
                return JSON.stringify({ id, name: id, version: "1.0.0", apiVersion: 1, main: "main.js" });
            }
            return "// source";
        },
        importModule: async (_source: string, sourceName: string) => modules[sourceName.split("/")[0]],
        writeClipboard: async () => {},
        page,
    };
}

let doc: FakeDocument;
let host: MoltenHost;
let guard: MoltenPageGuard;

function installGuard(): MoltenPageGuard {
    const g = new MoltenPageGuard({
        ownerOfUrl: (url) => modIdForScript(url, new Map()),
        isLive: (modId) => host.isRunning(modId),
    });
    g.install([doc.documentElement, doc.head, doc.body] as unknown as MoltenPageNode[]);
    return g;
}

// Probe P2 of the audit #713: a mod that turns the accent green and hides the radar with one injected <style>.
function probeStyle(): any {
    return modCode(
        "probe-style",
        `return {
            activate() {
                const style = doc.createElement("style");
                doc.head.appendChild(style);
                doc.body.append(doc.createElement("div"));
            },
        };`,
        ["doc", doc]
    );
}

beforeEach(() => {
    doc = makeDocument();
    doc.head.appendChild(new FakeNode("link"));
    doc.body.appendChild(new FakeNode("main"));
    MoltenHost.resetInstance();
    host = MoltenHost.getInstance();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
    guard?.uninstall();
    guard = null;
    vi.restoreAllMocks();
});

describe("probe P2: a style a mod injected outlives the mod", () => {
    it("stays in the page after disable without the page guard (the bug)", async () => {
        const enabled = { ids: ["probe-style"] };
        await host.start(makeEnv({ "probe-style": probeStyle() }, enabled));
        expect(tags(doc.head)).toEqual(["link", "style"]);
        enabled.ids = [];
        await host.reload(["probe-style"]);
        expect(host.listMods().mods[0].state).toBe("disabled");
        expect(tags(doc.head)).toEqual(["link", "style"]);
    });

    it("is removed on disable and molten undo, with the app's own nodes kept", async () => {
        guard = installGuard();
        const enabled = { ids: ["probe-style"] };
        await host.start(makeEnv({ "probe-style": probeStyle() }, enabled, guard));
        expect(tags(doc.head)).toEqual(["link", "style"]);
        expect(tags(doc.body)).toEqual(["main", "div"]);

        // `molten mod disable` and `molten undo` both rewrite mods.json and announce the ids: the same reload.
        enabled.ids = [];
        await host.reload(["probe-style"]);
        expect(tags(doc.head)).toEqual(["link"]);
        expect(tags(doc.body)).toEqual(["main"]);

        enabled.ids = ["probe-style"];
        await host.reload(["probe-style"]);
        expect(tags(doc.head)).toEqual(["link", "style"]);
        // A reload on save stops the mod first: its nodes never appear twice.
        await host.reload(["probe-style"]);
        expect(tags(doc.head)).toEqual(["link", "style"]);
        expect(tags(doc.body)).toEqual(["main", "div"]);
    });

    it("is removed when the mod fails", async () => {
        guard = installGuard();
        const failing = modCode(
            "broken",
            `return { activate() { doc.head.appendChild(doc.createElement("style")); throw new Error("boom"); } };`,
            ["doc", doc]
        );
        await host.start(makeEnv({ broken: failing }, { ids: ["broken"] }, guard));
        expect(host.listMods().mods[0].state).toBe("failed");
        expect(tags(doc.head)).toEqual(["link"]);
    });
});

describe("attribution", () => {
    it("follows the mod's code after activate: a command, a helper, a forEach callback", async () => {
        guard = installGuard();
        const mod = modCode(
            "later",
            `function add(root, tag) { root.insertAdjacentHTML("beforeend", "<" + tag + "></" + tag + ">"); }
            return {
                activate(api) {
                    api.commands.register("paint", () => {
                        [doc.createElement("style"), doc.createElement("meta")].forEach((n) => doc.head.prepend(n));
                        add(doc.body, "aside");
                        doc.body.insertBefore(doc.createElement("nav"), doc.body.childNodes[0]);
                    });
                },
            };`,
            ["doc", doc]
        );
        const enabled = { ids: ["later"] };
        await host.start(makeEnv({ later: mod }, enabled, guard));
        expect(tags(doc.head)).toEqual(["link"]);
        const result = await host.runCommand({ command: "paint" });
        expect(result.exitcode).toBe(0);
        expect(tags(doc.head)).toEqual(["meta", "style", "link"]);
        expect(tags(doc.body)).toEqual(["nav", "main", "aside"]);

        enabled.ids = [];
        await host.reload(["later"]);
        expect(tags(doc.head)).toEqual(["link"]);
        expect(tags(doc.body)).toEqual(["main"]);
    });

    it("never takes the app's nodes, even when the app inserts them from inside a mod's call", async () => {
        guard = installGuard();
        const appInsert = () => doc.body.appendChild(new FakeNode("portal"));
        const mod = modCode("caller", `return { activate() { appInsert(); } };`, ["appInsert", appInsert]);
        const enabled = { ids: ["caller"] };
        await host.start(makeEnv({ caller: mod }, enabled, guard));
        doc.head.appendChild(new FakeNode("style"));
        expect(tags(doc.body)).toEqual(["main", "portal"]);

        enabled.ids = [];
        await host.reload(["caller"]);
        expect(tags(doc.body)).toEqual(["main", "portal"]);
        expect(tags(doc.head)).toEqual(["link", "style"]);
    });

    it("removes at once what a stopped mod's leftover code adds", async () => {
        guard = installGuard();
        const leftover: { fn?: () => void } = {};
        const mod = modCode(
            "leaky",
            `return { activate() { out.fn = () => doc.documentElement.appendChild(doc.createElement("style")); } };`,
            ["doc", doc],
            ["out", leftover]
        );
        const enabled = { ids: ["leaky"] };
        await host.start(makeEnv({ leaky: mod }, enabled, guard));
        leftover.fn();
        expect(tags(doc.documentElement)).toEqual(["head", "body", "style"]);

        enabled.ids = [];
        await host.reload(["leaky"]);
        expect(tags(doc.documentElement)).toEqual(["head", "body"]);
        // A window timer or listener the mod left behind keeps running: what it adds now goes at once.
        leftover.fn();
        expect(tags(doc.documentElement)).toEqual(["head", "body"]);
    });

    it("leaves another mod's nodes in place when one mod stops", async () => {
        guard = installGuard();
        const a = modCode("a", `return { activate() { doc.head.appendChild(doc.createElement("a")); } };`, [
            "doc",
            doc,
        ]);
        const b = modCode("b", `return { activate() { doc.head.appendChild(doc.createElement("b")); } };`, [
            "doc",
            doc,
        ]);
        const enabled = { ids: ["a", "b"] };
        await host.start(makeEnv({ a, b }, enabled, guard));
        expect(tags(doc.head)).toEqual(["link", "a", "b"]);
        enabled.ids = ["b"];
        await host.reload(["a"]);
        expect(tags(doc.head)).toEqual(["link", "b"]);
    });

    it("gives the roots their own methods back on uninstall", () => {
        guard = installGuard();
        expect(Object.prototype.hasOwnProperty.call(doc.head, "appendChild")).toBe(true);
        guard.uninstall();
        expect(Object.prototype.hasOwnProperty.call(doc.head, "appendChild")).toBe(false);
        expect(doc.head.appendChild).toBe(FakeNode.prototype.appendChild);
    });
});

describe("stackFrameUrl", () => {
    it("reads the script URL of a V8 frame", () => {
        expect(stackFrameUrl("    at activate (molten-mod://probe/main.js:3:8)")).toBe("molten-mod://probe/main.js");
        expect(stackFrameUrl("    at molten-mod://probe/main.js:3:8")).toBe("molten-mod://probe/main.js");
        expect(stackFrameUrl("    at async run (blob:http://localhost:5173/1f2e:10:2)")).toBe(
            "blob:http://localhost:5173/1f2e"
        );
        expect(stackFrameUrl("    at Array.forEach (<anonymous>)")).toBeNull();
        expect(stackFrameUrl("    at new Promise (native)")).toBeNull();
    });
});
