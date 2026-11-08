// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import { wordUserInputRequest } from "./user-input-text";

vi.mock("./i18n-core", () => ({
    hasKey: (key: string) => key.startsWith("server.remoteask."),
}));
vi.mock("./i18n", () => ({
    t: (key: string, vars: Record<string, string>) => `[${key} ${JSON.stringify(vars ?? {})}]`,
}));

const request: UserInputRequest = {
    requestid: "r1",
    querytext: "dev@host wants to write ~/x on this computer.",
    responsetype: "confirm",
    title: "A server wants to write a file on this computer",
    markdown: false,
    timeoutms: 60000,
    checkboxmsg: "Always allow dev@host",
    publictext: false,
    oklabel: "Allow",
    cancellabel: "Deny",
};

describe("wordUserInputRequest", () => {
    it("leaves Wave's own questions as they are", () => {
        expect(wordUserInputRequest(request)).toBe(request);
    });

    it("words each field wavesrv sent a code for, in the interface language (#1831)", () => {
        const worded = wordUserInputRequest({
            ...request,
            moltentexts: {
                title: { code: "remoteask.writeTitle" },
                querytext: { code: "remoteask.write", vars: { server: "dev@host", path: "~/x" } },
                oklabel: { code: "remoteask.allow" },
                cancellabel: { code: "unknown.code" },
            },
        });
        expect(worded.title).toBe("[server.remoteask.writeTitle {}]");
        expect(worded.querytext).toBe('[server.remoteask.write {"server":"dev@host","path":"~/x"}]');
        expect(worded.oklabel).toBe("[server.remoteask.allow {}]");
        expect(worded.cancellabel).toBe("Deny");
        expect(worded.checkboxmsg).toBe("Always allow dev@host");
        expect(worded.requestid).toBe("r1");
    });
});
