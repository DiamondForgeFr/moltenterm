// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { notRepoCarrier } from "./not-repo-carrier";

describe("notRepoCarrier (#1671)", () => {
    it("picks Integration, then Project, then CI/CD, then Line map", () => {
        expect(notRepoCarrier({ a: "project", b: "integration" })).toEqual({ blockId: "b", panel: "integration" });
        expect(notRepoCarrier({ a: "linemap", b: "cicd", c: "project" })).toEqual({ blockId: "c", panel: "project" });
        expect(notRepoCarrier({ a: "linemap", b: "cicd" })).toEqual({ blockId: "b", panel: "cicd" });
    });

    it("picks the same block for every panel when two share a kind", () => {
        expect(notRepoCarrier({ z: "project", m: "project" })).toEqual({ blockId: "m", panel: "project" });
    });

    it("has no carrier for an empty group", () => {
        expect(notRepoCarrier(undefined)).toBeNull();
        expect(notRepoCarrier({})).toBeNull();
    });
});
