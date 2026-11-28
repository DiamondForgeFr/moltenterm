// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the security fix block's buttons do (FR-REV-036 AC10, AC13, AC17, #2591): the first-time answer is recorded before
// the launch, a launch that started nothing says why, and Stop is the same as the notification's.

import { beforeEach, describe, expect, it, vi } from "vitest";

const app = vi.hoisted(() => ({
    calls: [] as { command: string; data: any }[],
    ask: null as any,
    stop: null as any,
    record: null as any,
}));

vi.mock("@/app/store/client-model", () => ({ ClientModel: { getInstance: () => ({ clientId: "client-1" }) } }));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return { atoms: { workspace: atom({ oid: "ws-1" }) }, getSettingsKeyAtom: () => atom(undefined) };
});
vi.mock("../review/review-client", () => ({
    askSecurityFix: (req: any) => app.ask(req),
    stopSecurityFix: (req: any) => app.stop(req),
}));
vi.mock("./security-fix-actions", () => ({
    recordSecurityFixAnswer: (answer: string) => app.record(answer),
}));

import { wordPhrase } from "../i18n/phrase";
import { launchSecurityFix, securityFixProblem, stopSecurityFixOf } from "./security-fix-block-actions";

const Req = { dir: "/p", repo: "acme/shop", trunk: "develop", fingerprint: "0123456789abcdef" };

beforeEach(() => {
    app.calls = [];
    app.record = async (answer: string) => {
        app.calls.push({ command: "record", data: answer });
    };
    app.ask = async (req: any) => {
        app.calls.push({ command: "ask", data: req });
        return { status: "started" };
    };
    app.stop = async (req: any) => {
        app.calls.push({ command: "stop", data: req });
        return { status: "stopped" };
    };
});

describe("Launch the fix (FR-REV-036 AC10)", () => {
    it("asks for the block by its fingerprint, in the window's workspace, and says nothing when it started", async () => {
        expect(await launchSecurityFix(Req)).toBeNull();
        expect(app.calls).toEqual([
            {
                command: "ask",
                data: { ...Req, workspaceid: "ws-1", tabname: "Security fix" },
            },
        ]);
    });

    it("records the developer's first-time answer before it asks, so a consent is there when the fix is read", async () => {
        await launchSecurityFix({ ...Req, answer: "always" });
        expect(app.calls.map((c) => c.command)).toEqual(["record", "ask"]);
        expect(app.calls[0].data).toBe("always");
        app.calls = [];
        await launchSecurityFix({ ...Req, answer: "ask" });
        expect(app.calls.map((c) => [c.command, c.data === "ask" ? "ask" : "-"])).toEqual([
            ["record", "ask"],
            ["ask", "-"],
        ]);
    });

    it("starts nothing when the answer could not be recorded, and says the error", async () => {
        app.record = async () => {
            throw new Error("the answer could not be kept");
        };
        const problem = await launchSecurityFix({ ...Req, answer: "always" });
        expect(wordPhrase(problem)).toContain("the answer could not be kept");
        expect(app.calls).toEqual([]);
    });

    it("says what wavesrv refused", async () => {
        app.ask = async () => {
            throw new Error("wavesrv is not there");
        };
        expect(wordPhrase(await launchSecurityFix(Req))).toContain("wavesrv is not there");
    });
});

describe("a launch that started nothing", () => {
    it("says the scan no longer fails, or that the advisories are the pull request's own", () => {
        expect(wordPhrase(securityFixProblem({ status: "failed", reason: "blockgone" }))).toBe(
            "The scan no longer fails on these advisories: there is nothing to fix."
        );
        expect(wordPhrase(securityFixProblem({ status: "failed", reason: "notshared" }))).toBe(
            "These advisories come from a pull request itself: fix them in it (Analyze and resolve)."
        );
    });

    it("says wavesrv's own sentence for any other failure, and a plain one without it", () => {
        expect(wordPhrase(securityFixProblem({ status: "failed", message: "gh is not installed" }))).toBe(
            "gh is not installed"
        );
        expect(wordPhrase(securityFixProblem({ status: "failed" }))).toBe("The fix could not be started.");
    });

    it("says a fix is being started already", () => {
        expect(wordPhrase(securityFixProblem({ status: "busy" }))).toBe(
            "A security fix is already being started for this project."
        );
    });

    it("says nothing when the fix stands, waits, is joined or is someone else's: the block shows where it stands", () => {
        for (const status of ["started", "covered", "addendum", "held", "waiting", "external", "noagent"] as const) {
            expect(securityFixProblem({ status })).toBeNull();
        }
        expect(securityFixProblem(null)).toBeNull();
    });
});

describe("Stop (FR-REV-036 AC13)", () => {
    it("stops the fix its fingerprint names, and says nothing", async () => {
        expect(await stopSecurityFixOf("/p", "0123456789abcdef")).toBeNull();
        expect(app.calls).toEqual([{ command: "stop", data: { dir: "/p", fingerprint: "0123456789abcdef" } }]);
    });

    it("says no fix runs when there is none, as the notification does", async () => {
        app.stop = async () => ({ status: "failed" });
        expect(wordPhrase(await stopSecurityFixOf("/p", "0123456789abcdef"))).toBe(
            "No security fix is running for these advisories."
        );
    });

    it("says the error when the call fails", async () => {
        app.stop = async () => {
            throw new Error("no connection");
        };
        expect(wordPhrase(await stopSecurityFixOf("/p", "0123456789abcdef"))).toContain("no connection");
    });
});
