// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    frame: { props: null as any },
    reveal: vi.fn(),
}));

vi.mock("react-dom", async (importOriginal) => {
    const actual = await importOriginal<typeof import("react-dom")>();
    return { ...actual, createPortal: (node: React.ReactNode) => node };
});
vi.mock("@/app/store/global", () => ({
    getApi: () => ({ getHomeDir: () => "/Users/dev", revealNativePath: mocks.reveal }),
}));
vi.mock("../moltenterm-shell/dialog-frame", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../moltenterm-shell/dialog-frame")>();
    return {
        ...actual,
        DialogFrame: (props: React.ComponentProps<typeof actual.DialogFrame>) => {
            mocks.frame.props = props;
            return actual.DialogFrame(props);
        },
    };
});

import {
    MoltenTrustDetails,
    MoltenTrustDialog,
    MoltenTrustModel,
    MoltenTrustRequest,
    moltenModInitial,
    moltenTrustFacts,
    moltenTrustWording,
} from "./molten-trust";

function request(id: string, extra: Partial<MoltenTrustRequest> = {}): MoltenTrustRequest {
    return { id, name: id, version: "1.0.0", description: "", capabilities: [], path: `/cfg/mods/${id}`, ...extra };
}

let model: MoltenTrustModel;

beforeAll(() => {
    vi.stubGlobal("document", { body: {}, getElementById: () => ({}) });
});

beforeEach(() => {
    MoltenTrustModel.resetInstance();
    model = MoltenTrustModel.getInstance();
    mocks.frame.props = null;
    mocks.reveal.mockClear();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("MoltenTrustModel", () => {
    it("shows one prompt at a time and resolves each with the user's answer", async () => {
        const first = model.ask(request("a"));
        const second = model.ask(request("b"));
        expect(globalStore.get(model.currentAtom).request.id).toBe("a");

        model.answer("trusted");
        await expect(first).resolves.toBe("trusted");
        expect(globalStore.get(model.currentAtom).request.id).toBe("b");

        model.answer("declined");
        await expect(second).resolves.toBe("declined");
        expect(globalStore.get(model.currentAtom)).toBeNull();
    });

    it("answers timeout when the user does not answer, and closes the prompt", async () => {
        vi.useFakeTimers();
        const answer = model.ask(request("slow"), 1000);
        await vi.advanceTimersByTimeAsync(1001);
        await expect(answer).resolves.toBe("timeout");
        expect(globalStore.get(model.currentAtom)).toBeNull();
    });

    it("ignores an answer once the prompt is settled", async () => {
        const answer = model.ask(request("a"));
        model.answer("declined");
        model.answer("trusted");
        await expect(answer).resolves.toBe("declined");
    });

    it("numbers the prompts, so that two for the same mod are told apart", () => {
        void model.ask(request("a"));
        const first = globalStore.get(model.currentAtom).seq;
        model.answer("declined");
        void model.ask(request("a"));
        expect(globalStore.get(model.currentAtom).seq).not.toBe(first);
    });
});

describe("moltenTrustWording", () => {
    const part = { folder: "agents/claude-code", targetVersion: "2.1.289" };

    it("asks about the mod, with one risk sentence and no command", () => {
        const wording = moltenTrustWording(request("a"));
        expect(wording.title).toBe("Trust the mod “a”?");
        expect(wording.risk).toBe("A mod runs with your rights. Trust it only if you know where it comes from.");
        expect(wording.risk).not.toContain("molten");
        expect(wording.okLabel).toBe("Trust and enable");
        expect(wording.declineNote).toBe("");
    });

    it("keeps the mod's question when it carries a Claude Code part", () => {
        const wording = moltenTrustWording({ ...request("band"), claudeCodePart: part });
        expect(wording.title).toBe("Trust the mod “band”?");
        expect(wording.okLabel).toBe("Trust and enable");
    });

    it("asks about the part alone for a mod trusted before it had one", () => {
        const wording = moltenTrustWording({ ...request("band"), claudeCodePart: part, partsOnly: true });
        expect(wording.title).toBe("Trust the Claude Code part of “band”?");
        expect(wording.declineNote).toBe("Declining keeps the rest of the mod running.");
        expect(wording.okLabel).toBe("Trust the part");
    });

    it("asks about the whole mod when partsOnly names a part the mod does not carry", () => {
        const wording = moltenTrustWording({ ...request("band"), partsOnly: true });
        expect(wording.title).toBe("Trust the mod “band”?");
    });
});

describe("moltenTrustFacts", () => {
    const part = { folder: "agents/claude-code", targetVersion: "2.1.289" };

    it("states that a mod runs with the user's rights", () => {
        const facts = moltenTrustFacts(request("a"));
        expect(facts.map((f) => f.kind)).toEqual(["run"]);
        expect(facts[0].detail).toContain("read and change your files and run commands");
    });

    it("adds the Claude Code part, which changes what Claude Code shows and does in every session", () => {
        const facts = moltenTrustFacts({ ...request("a"), claudeCodePart: part });
        expect(facts.map((f) => f.kind)).toEqual(["run", "part"]);
        expect(facts[1].detail).toContain("every Claude Code session");
        expect(facts[1].detail).toContain("change what Claude Code shows and does");
    });

    it("keeps the part alone when the mod is already trusted", () => {
        const facts = moltenTrustFacts({ ...request("a"), claudeCodePart: part, partsOnly: true });
        expect(facts.map((f) => f.kind)).toEqual(["part"]);
    });
});

describe("moltenModInitial", () => {
    it("takes the first letter of the name, upper-cased, or of the id without a name", () => {
        expect(moltenModInitial(request("hours", { name: "Heures clients" }))).toBe("H");
        expect(moltenModInitial(request("hours", { name: "" }))).toBe("H");
        expect(moltenModInitial(request("", { name: "" }))).toBe("?");
    });
});

function shown(req: MoltenTrustRequest): string {
    void model.ask(req);
    return renderToStaticMarkup(<MoltenTrustDialog />);
}

describe("the trust dialog", () => {
    const part = { folder: "agents/claude-code", targetVersion: "2.1.289" };

    it("opens with the mod's identity, then one risk sentence, then what it can do", () => {
        const html = shown(
            request("hours", {
                name: "Client hours",
                version: "1.2.0",
                description: "Adds the hours billed to each client in the status bar.",
                capabilities: ["statusbar", "commands"],
                claudeCodePart: part,
            })
        );
        expect(html).toContain('data-role="molten-mod-trust"');
        expect(html).toContain("Trust the mod “Client hours”?");
        expect(html).toContain("Asked by a coding agent");
        expect(html).toContain(">C<");
        expect(html).toContain(">v1.2.0<");
        expect(html).toContain("Adds the hours billed to each client in the status bar.");
        const order = [
            "molten-trust-identity",
            "molten-trust-risk",
            "What it can do",
            "Runs in MoltenTerm with your rights",
            "Has a Claude Code part",
            "Declared capabilities",
            "molten-trust-details",
            "molten-trust-revoke",
        ].map((marker) => html.indexOf(marker));
        expect(order.every((i) => i >= 0)).toBe(true);
        expect(order).toEqual([...order].sort((a, b) => a - b));
        expect(html).toContain(">statusbar<");
        expect(html).toContain(">commands<");
        expect(html).not.toContain("none declared");
    });

    it("says that no capability is declared as a muted chip", () => {
        const html = shown(request("hours"));
        expect(html).toContain(">none declared<");
        expect(html).not.toContain("Claude Code");
        expect(html).not.toContain('data-fact="part"');
    });

    it("keeps the folder and the Claude Code part's path behind the details", () => {
        const html = shown(request("hours", { claudeCodePart: part }));
        expect(html).toContain('aria-expanded="false"');
        expect(html).not.toContain("/cfg/mods/hours");
        expect(html).not.toContain("agents/claude-code");
        expect(html).not.toContain("2.1.289");
    });

    it("lists the details once opened: the folder, how to show it, the part and the version it targets", () => {
        const html = renderToStaticMarkup(
            <MoltenTrustDetails
                req={request("hours", { path: "/Users/dev/.config/mods/hours", claudeCodePart: part })}
                defaultOpen
            />
        );
        expect(html).toContain('aria-expanded="true"');
        expect(html).toContain("~/.config/mods/hours");
        expect(html).toContain('title="/Users/dev/.config/mods/hours"');
        expect(html).toContain("Show in folder");
        expect(html).toContain("agents/claude-code");
        expect(html).toContain("Written for Claude Code 2.1.289");
    });

    it("leaves out the part's details for a mod without one", () => {
        const html = renderToStaticMarkup(<MoltenTrustDetails req={request("hours")} defaultOpen />);
        expect(html).toContain("Folder");
        expect(html).not.toContain("Claude Code");
    });

    it("states the revoke path in words, with the command only as a code hint", () => {
        const html = shown(request("hours"));
        const revoke = html.slice(html.indexOf("molten-trust-revoke"));
        expect(revoke).toContain("The agent can keep editing it without asking again.");
        expect(revoke).toContain("You can take your trust back at any time, from a terminal:");
        expect(revoke).toMatch(/<code[^>]*>molten mod untrust hours<\/code>/);
        expect(html.match(/molten mod untrust/g)).toHaveLength(1);
        expect(html).not.toContain("Undo with");
    });

    it("asks about the part alone, and says what declining keeps", () => {
        const html = shown(request("band", { claudeCodePart: part, partsOnly: true }));
        expect(html).toContain("Trust the Claude Code part of “band”?");
        expect(html).toContain("You trusted this mod before it had this part.");
        expect(html).toContain("Declining keeps the rest of the mod running.");
        expect(html).toContain('data-fact="part"');
        expect(html).not.toContain('data-fact="run"');
        expect(html).toContain("Trust the part");
    });

    it("puts the calm refusal first and the molten call to action last", () => {
        const html = shown(request("hours"));
        const buttons = html.slice(html.indexOf("data-dialog-buttons"));
        expect(buttons.indexOf('data-answer="declined"')).toBeGreaterThan(-1);
        expect(buttons.indexOf('data-answer="declined"')).toBeLessThan(buttons.indexOf('data-answer="trusted"'));
        const trust = buttons.slice(buttons.indexOf('data-answer="trusted"'));
        expect(trust).toMatch(/^data-answer="trusted"[^>]*>[^<]*<i class="molten-btn-wave"/);
        expect(buttons).toMatch(/class="molten-btn [^"]*"[^>]*data-answer="trusted"/);
        expect(buttons).toMatch(/class="(?![^"]*molten-btn)[^"]*"[^>]*data-answer="declined"/);
    });

    it("answers declined on Escape and on the refusal, and trusted only on the call to action", async () => {
        const first = model.ask(request("a"));
        renderToStaticMarkup(<MoltenTrustDialog />);
        mocks.frame.props.onEscape();
        await expect(first).resolves.toBe("declined");

        const second = model.ask(request("b"));
        renderToStaticMarkup(<MoltenTrustDialog />);
        const [decline, trust] = mocks.frame.props.buttons.props.children;
        expect(decline.props["data-answer"]).toBe("declined");
        expect(trust.props["data-answer"]).toBe("trusted");
        decline.props.onClick();
        await expect(second).resolves.toBe("declined");

        const third = model.ask(request("c"));
        renderToStaticMarkup(<MoltenTrustDialog />);
        mocks.frame.props.buttons.props.children[1].props.onClick();
        await expect(third).resolves.toBe("trusted");
    });

    it("does not close on a press outside the dialog", () => {
        shown(request("hours"));
        expect(mocks.frame.props.onBackdrop).toBeUndefined();
    });

    it("draws nothing without a pending request", () => {
        expect(renderToStaticMarkup(<MoltenTrustDialog />)).toBe("");
    });
});
