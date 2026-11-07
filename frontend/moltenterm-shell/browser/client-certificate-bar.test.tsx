// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const Api = vi.hoisted(() => ({ moltentermClientCertificateAnswer: vi.fn() }));
vi.mock("@/app/store/global", () => ({ getApi: () => Api }));

import {
    CertificateAsk,
    ClientCertificateBar,
    ClientCertificateModel,
    isCertificateAsk,
} from "./client-certificate-bar";

const Ask: CertificateAsk = {
    requestid: "r1",
    site: "corp.example.com",
    certificates: [
        { fingerprint: "sha256/alice", name: "Alice", issuer: "Acme CA", expires: Date.UTC(2030, 5, 15, 12) },
        { fingerprint: "sha256/work", name: "", issuer: "", expires: 0 },
    ],
};

function render(model: ClientCertificateModel, tabId: string): string {
    return renderToStaticMarkup(
        <Provider store={globalStore}>
            <ClientCertificateBar certificates={model} tabId={tabId} />
        </Provider>
    );
}

beforeEach(() => {
    Api.moltentermClientCertificateAnswer.mockClear();
});

describe("the client certificate bar (#1979)", () => {
    it("shows nothing for a tab without a question", () => {
        const model = new ClientCertificateModel();
        model.add("tab-a", Ask);
        expect(render(model, "tab-b")).toBe("");
    });

    it("names the site and lists every certificate with none picked, Use disabled until one is", () => {
        const model = new ClientCertificateModel();
        model.add("tab-a", Ask);
        const html = render(model, "tab-a");
        expect(html).toContain("corp.example.com asks for a certificate to identify you");
        expect(html).toContain("Alice");
        expect(html).toContain("Issued by Acme CA");
        expect(html).toContain("Unnamed certificate");
        expect(html.match(/type="radio"/g)).toHaveLength(2);
        expect(html).not.toMatch(/<input[^>]*checked/);
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-testid="client-certificate-use"/);
        expect(html).not.toContain('<span class="truncate text-secondary"></span>');
        expect(html).toContain("Continue without a certificate");
        expect(html).toContain('role="radiogroup"');
    });

    it("shows the oldest question of the tab first", () => {
        const model = new ClientCertificateModel();
        model.add("tab-a", Ask);
        model.add("tab-a", { ...Ask, requestid: "r2", site: "other.example.com" });
        expect(render(model, "tab-a")).toContain("corp.example.com asks");
        model.remove("r1");
        expect(render(model, "tab-a")).toContain("other.example.com asks");
    });
});

describe("the questions of a panel (#1979)", () => {
    it("tells main the answer and removes the question", () => {
        const model = new ClientCertificateModel();
        model.add("tab-a", Ask);
        model.add("tab-a", Ask);
        expect(globalStore.get(model.asksAtom)["tab-a"]).toHaveLength(1);
        model.answer("r1", "use", "sha256/alice");
        expect(Api.moltentermClientCertificateAnswer).toHaveBeenCalledWith("r1", "use", "sha256/alice");
        expect(model.current("tab-a")).toBeNull();
    });

    it("lets a question go when main settles it, without answering", () => {
        const model = new ClientCertificateModel();
        model.add("tab-a", Ask);
        model.remove("r1");
        model.remove("unknown");
        expect(model.current("tab-a")).toBeNull();
        expect(Api.moltentermClientCertificateAnswer).not.toHaveBeenCalled();
    });

    it("goes without a certificate for what a closed tab was asked", () => {
        const model = new ClientCertificateModel();
        model.add("tab-a", Ask);
        model.add("tab-a", { ...Ask, requestid: "r2" });
        model.forgetTab("tab-a");
        expect(Api.moltentermClientCertificateAnswer.mock.calls).toEqual([
            ["r1", "dismiss", undefined],
            ["r2", "dismiss", undefined],
        ]);
        expect(model.current("tab-a")).toBeNull();
    });

    it("takes a question for what main sends, and nothing else", () => {
        expect(isCertificateAsk(Ask)).toBe(true);
        expect(isCertificateAsk({ ...Ask, certificates: [{ fingerprint: "x" }] })).toBe(false);
        expect(isCertificateAsk({ ...Ask, site: 3 })).toBe(false);
        expect(isCertificateAsk({ ...Ask, certificates: "sha256/alice" })).toBe(false);
        expect(isCertificateAsk(null)).toBe(false);
    });
});
