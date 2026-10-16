// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

export const requests: {
    command: string;
    dir: string;
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    settled: boolean;
}[] = [];
export const subscriptions: { eventType: string; scope?: string; handler: (event: any) => void; stopped: boolean }[] =
    [];
export const polls: { callback: () => void; stopped: boolean }[] = [];
export const TabRpcClient = {
    wshRpcCall(command: string, data: { dir: string }) {
        return new Promise((resolve, reject) =>
            requests.push({ command, dir: data.dir, resolve, reject, settled: false })
        );
    },
};
export function waveEventSubscribeSingle(subscription: any) {
    const saved = { ...subscription, stopped: false };
    subscriptions.push(saved);
    return () => {
        saved.stopped = true;
    };
}
export function everyInPanel(_panel: string, _interval: number, callback: () => void) {
    const saved = { callback, stopped: false };
    polls.push(saved);
    return () => {
        saved.stopped = true;
    };
}
export const usePanelBlockId = () => "fixture-panel";
export const whileShown = (interval: number) => interval;
export const fireAndForget = (fn: () => Promise<unknown>) => {
    void fn().catch(() => {});
};
export const serverErrorText = (error: Error) => error.message;
export const t = (key: string) => key;
export const translate = (_locale: string, key: string) => key;
export const I18nModel = {};
