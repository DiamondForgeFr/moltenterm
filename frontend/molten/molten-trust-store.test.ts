// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { disableInState, forgetTrust, formatTrustDate, trustRecordsOf } from "./molten-trust-store";

// The files as molten writes them (cmd/wsh/cmd/wshcmd-molten-mods.go): two spaces and a final newline.
const TrustFile = `{
  "trusted": {
    "band": {
      "name": "Band",
      "trustedat": "2026-11-02T10:30:00Z",
      "agents": [
        "claude-code"
      ]
    },
    "clock": {
      "name": "Clock",
      "trustedat": "2026-10-20T08:00:00Z"
    }
  }
}
`;

const StateFile = `{
  "enabled": [
    "band",
    "clock"
  ],
  "disabled": [
    "copy-box"
  ],
  "enabledat": {
    "band": "2026-11-02T10:30:01.5Z",
    "clock": "2026-10-20T08:00:01Z"
  }
}
`;

describe("trustRecordsOf", () => {
    it("reads each record's name and date", () => {
        const records = trustRecordsOf(JSON.parse(TrustFile));
        expect([...records.keys()]).toEqual(["band", "clock"]);
        expect(records.get("band")).toEqual({ name: "Band", trustedat: "2026-11-02T10:30:00Z" });
    });

    it.each([[null], [undefined], [[]], ["x"], [{}], [{ trusted: [] }], [{ trusted: null }]])(
        "trusts nothing from %j",
        (parsed) => {
            expect(trustRecordsOf(parsed).size).toBe(0);
        }
    );

    it("keeps a record whose fields are missing or of another type, with what it can read", () => {
        const records = trustRecordsOf({
            trusted: { a: {}, b: "x", c: { name: 3, trustedat: "2026-01-01T00:00:00Z" } },
        });
        expect(records.get("a")).toEqual({});
        expect(records.get("b")).toEqual({});
        expect(records.get("c")).toEqual({ trustedat: "2026-01-01T00:00:00Z" });
    });
});

describe("forgetTrust", () => {
    it("drops the mod's record and leaves the others and the rest of the file as they were", () => {
        const text = forgetTrust(JSON.parse(TrustFile), "band");
        expect(text).toBe(`{
  "trusted": {
    "clock": {
      "name": "Clock",
      "trustedat": "2026-10-20T08:00:00Z"
    }
  }
}
`);
    });

    it("keeps keys it does not know", () => {
        const text = forgetTrust({ version: 2, trusted: { a: { name: "A" }, b: { name: "B" } } }, "a");
        expect(JSON.parse(text)).toEqual({ version: 2, trusted: { b: { name: "B" } } });
    });

    it("leaves an empty trusted map after the last record, as molten does", () => {
        expect(forgetTrust({ trusted: { a: { name: "A" } } }, "a")).toBe('{\n  "trusted": {}\n}\n');
    });

    it.each([[null], [{}], [{ trusted: {} }], [{ trusted: { other: {} } }], [[]], [{ trusted: [] }]])(
        "has nothing to write when the mod has no record in %j",
        (parsed) => {
            expect(forgetTrust(parsed, "band")).toBeNull();
        }
    );

    it("does not take a property of Object.prototype for a record", () => {
        expect(forgetTrust({ trusted: {} }, "toString")).toBeNull();
        expect(forgetTrust({ trusted: {} }, "__proto__")).toBeNull();
    });
});

describe("disableInState", () => {
    it("drops the mod from the enabled list with its date, and keeps the rest", () => {
        const text = disableInState(JSON.parse(StateFile), "band");
        expect(text).toBe(`{
  "enabled": [
    "clock"
  ],
  "disabled": [
    "copy-box"
  ],
  "enabledat": {
    "clock": "2026-10-20T08:00:01Z"
  }
}
`);
    });

    it("drops the dates altogether once no enabled mod has one", () => {
        const text = disableInState({ enabled: ["a"], enabledat: { a: "2026-01-01T00:00:00Z" } }, "a");
        expect(JSON.parse(text)).toEqual({ enabled: [] });
    });

    it("drops every mention of the mod", () => {
        const text = disableInState({ enabled: ["a", "b", "a"] }, "a");
        expect(JSON.parse(text)).toEqual({ enabled: ["b"] });
    });

    it.each([[null], [{}], [{ enabled: [] }], [{ enabled: ["other"] }], [{ enabled: "a" }], [[]]])(
        "has nothing to write when the mod is not enabled in %j",
        (parsed) => {
            expect(disableInState(parsed, "a")).toBeNull();
        }
    );
});

describe("formatTrustDate", () => {
    it("writes the date in the language of the interface", () => {
        expect(formatTrustDate("2026-11-02T10:30:00Z", "en", "UTC")).toBe("Nov 2, 2026");
        expect(formatTrustDate("2026-11-02T10:30:00Z", "fr", "UTC")).toBe("2 nov. 2026");
    });

    it("writes nothing for a date it cannot read", () => {
        expect(formatTrustDate("last week", "en")).toBe("");
        expect(formatTrustDate("", "en")).toBe("");
    });
});
