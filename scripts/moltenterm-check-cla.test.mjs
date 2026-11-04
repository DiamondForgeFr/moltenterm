// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { evaluateCla, isBot, parseConfig } from "./moltenterm-check-cla.mjs";

const Config = {
    version: "1.0",
    exempt: ["AGachet"],
    signatures: [{ login: "octocat", name: "Mona", date: "2026-11-05", version: "1.0" }],
};

const commit = (login, type = "User", sha = "abcdef0123") => ({ sha, login, type, email: `${login}@example.com` });

function run(overrides) {
    return evaluateCla({ config: Config, headConfig: null, prAuthor: "AGachet", commits: [], ...overrides });
}

describe("evaluateCla", () => {
    it("passes for a maintainer", () => {
        const r = run({ commits: [commit("AGachet")] });
        expect(r.pass).toBe(true);
        expect(r.ok).toEqual([{ login: "AGachet", how: "maintainer" }]);
    });

    it("passes for a contributor who signed before, whatever the case of the login", () => {
        const r = run({ prAuthor: "OctoCat", commits: [commit("OCTOCAT")] });
        expect(r.pass).toBe(true);
    });

    it("exempts bots", () => {
        const r = run({
            prAuthor: "dependabot[bot]",
            commits: [commit("dependabot[bot]", "Bot"), commit("some-app", "Bot")],
        });
        expect(r.pass).toBe(true);
        expect(r.ok.every((o) => o.how === "bot")).toBe(true);
    });

    it("fails for a contributor who has not signed", () => {
        const r = run({ prAuthor: "newcomer", commits: [commit("newcomer")] });
        expect(r.pass).toBe(false);
        expect(r.missing).toEqual(["newcomer"]);
    });

    it("passes when the author signs in the pull request itself", () => {
        const headConfig = parseConfig(
            JSON.stringify({ ...Config, signatures: [{ login: "newcomer", name: "N", date: "2026-11-05", version: "1.0" }] })
        );
        const r = run({ prAuthor: "newcomer", commits: [commit("newcomer")], headConfig });
        expect(r.pass).toBe(true);
        expect(r.ok[0].how).toBe("signing in this pull request");
    });

    it("does not let a pull request sign for someone else", () => {
        const headConfig = parseConfig(
            JSON.stringify({ ...Config, signatures: [{ login: "other", name: "O", date: "2026-11-05", version: "1.0" }] })
        );
        const r = run({ prAuthor: "newcomer", commits: [commit("newcomer"), commit("other")], headConfig });
        expect(r.missing.sort()).toEqual(["newcomer", "other"]);
    });

    it("does not let a pull request exempt its own author", () => {
        const headConfig = parseConfig(JSON.stringify({ ...Config, exempt: ["newcomer"] }));
        const r = run({ prAuthor: "newcomer", commits: [commit("newcomer")], headConfig });
        expect(r.pass).toBe(false);
    });

    it("refuses a signature of another CLA version", () => {
        const headConfig = parseConfig(
            JSON.stringify({ ...Config, signatures: [{ login: "newcomer", name: "N", date: "2026-11-05", version: "0.9" }] })
        );
        expect(run({ prAuthor: "newcomer", commits: [commit("newcomer")], headConfig }).pass).toBe(false);
    });

    it("needs every commit author to have signed, not only the pull request's", () => {
        const r = run({ commits: [commit("AGachet"), commit("stranger")] });
        expect(r.missing).toEqual(["stranger"]);
    });

    it("fails a commit whose author is linked to no account", () => {
        const r = run({ commits: [{ sha: "0123456789", login: null, type: null, email: "ghost@example.com" }] });
        expect(r.pass).toBe(false);
        expect(r.unlinked).toEqual([{ sha: "0123456", email: "ghost@example.com" }]);
    });
});

describe("parseConfig", () => {
    it("reads a valid file and fills the lists", () => {
        expect(parseConfig('{"version":"1.0"}')).toEqual({ version: "1.0", exempt: [], signatures: [] });
    });

    it("refuses text that is not a config", () => {
        expect(parseConfig("not json")).toBeNull();
        expect(parseConfig("[]")).toBeNull();
        expect(parseConfig('{"signatures":[]}')).toBeNull();
    });
});

describe("isBot", () => {
    it("knows an app account by its type or its login", () => {
        expect(isBot("x", "Bot")).toBe(true);
        expect(isBot("dependabot[bot]", "User")).toBe(true);
        expect(isBot("octocat", "User")).toBe(false);
    });
});
