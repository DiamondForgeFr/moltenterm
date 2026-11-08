// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./mission/mission-client", () => ({ missionRepos: async () => ({ dir: "", repos: [], self: false }) }));

import { RepositoryChoice } from "./project-repository";

const Dir = "/clients/ofpis";

function render(value: string, found: { repos: string[]; self: boolean }) {
    return renderToStaticMarkup(
        <RepositoryChoice
            dir={Dir}
            value={value}
            found={found}
            onChange={() => {}}
            labelClassName="label"
            selectClassName="select"
            hintClassName="hint"
        />
    );
}

function options(html: string): { value: string; label: string; selected: boolean }[] {
    return [...html.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)].map((m) => ({
        value: m[1],
        label: m[3].replace(/&#x27;/g, "'"),
        selected: m[2].includes("selected"),
    }));
}

describe("a project's Code repository choice (#1777)", () => {
    it("offers none and the repositories found in the folder, named from it", () => {
        const html = render("", { repos: ["/clients/ofpis/app", "/clients/ofpis/code/api"], self: false });
        expect(html).toContain("Code repository");
        expect(options(html)).toEqual([
            { value: "", label: "None: work on the folder", selected: true },
            { value: "/clients/ofpis/app", label: "app", selected: false },
            { value: "/clients/ofpis/code/api", label: "code/api", selected: false },
        ]);
        expect(html).toContain("Agents start in the repository");
        expect(html).not.toContain("disabled");
    });

    it("shows the repository chosen, even one the search does not list any more", () => {
        const listed = render("/clients/ofpis/app", { repos: ["/clients/ofpis/app"], self: false });
        expect(options(listed).find((o) => o.selected)?.value).toBe("/clients/ofpis/app");
        const unlisted = render("/clients/ofpis/old/deep/repo", { repos: ["/clients/ofpis/app"], self: false });
        expect(options(unlisted).find((o) => o.selected)).toEqual({
            value: "/clients/ofpis/old/deep/repo",
            label: "old/deep/repo",
            selected: true,
        });
    });

    it("ignores a repository outside the folder: the choice shows none", () => {
        const html = render("/elsewhere/app", { repos: [], self: false });
        expect(options(html)).toEqual([
            { value: "", label: "None: no Git repository found in the folder", selected: true },
        ]);
    });

    it("waits for the repositories without letting a choice be made", () => {
        const html = render("", { repos: null, self: false });
        expect(html).toContain("disabled");
        expect(options(html)).toHaveLength(1);
    });

    it("offers no choice for a folder that is itself a repository, and says so", () => {
        const html = render("", { repos: [Dir], self: true });
        expect(html).not.toContain("<select");
        expect(html).toContain("The folder is itself the repository.");
    });

    it("shows nothing without a folder", () => {
        expect(
            renderToStaticMarkup(
                <RepositoryChoice dir="" value="" found={{ repos: [], self: false }} onChange={() => {}} />
            )
        ).toBe("");
    });
});
