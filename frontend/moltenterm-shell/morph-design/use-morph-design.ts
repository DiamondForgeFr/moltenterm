// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { waveEventSubscribeSingle } from "@/app/store/wps";
import { useCallback, useEffect, useRef, useState } from "react";
import { morphDesignState } from "./morph-design-client";
import { MorphDesign, MorphDesignEvent, readMorphDesign } from "./morph-design-model";

export type MorphDesignState = {
    // wavesrv answered once (or could not): the panel does not wait for ever.
    ready: boolean;
    design: MorphDesign;
    // The design is not open in wavesrv (it restarted since the tab was made).
    missing: boolean;
    // Takes a design a command returned; an older one never replaces a newer one.
    apply: (design: MorphDesign) => void;
    reload: () => void;
};

// A design kept current by wavesrv's events: the first read, then each change the agent or a click makes. A window that
// reloads reads it again, so the panel survives it.
export function useMorphDesign(mod: string): MorphDesignState {
    const [state, setState] = useState<{ ready: boolean; design: MorphDesign; missing: boolean }>({
        ready: false,
        design: null,
        missing: false,
    });
    const request = useRef(0);
    const apply = useCallback((design: MorphDesign) => {
        if (design == null) {
            return;
        }
        setState((cur) =>
            cur.design != null && cur.design.updated > design.updated ? cur : { ready: true, design, missing: false }
        );
    }, []);
    const reload = useCallback(() => {
        const n = ++request.current;
        morphDesignState(mod)
            .then((design) => {
                if (n === request.current) {
                    apply(design);
                }
            })
            .catch((e) => {
                if (n !== request.current) {
                    return;
                }
                console.log("morph design: not read", mod, e);
                setState((cur) => ({ ready: true, design: cur.design, missing: cur.design == null }));
            });
    }, [mod, apply]);
    useEffect(() => {
        setState({ ready: false, design: null, missing: false });
        reload();
        let unsubscribe: () => void;
        try {
            unsubscribe = waveEventSubscribeSingle({
                eventType: MorphDesignEvent as WaveEventName,
                scope: mod,
                handler: (event) => apply(readMorphDesign(event.data)),
            });
        } catch (e) {
            console.log("morph design: no event bus", e);
        }
        const refresh = () => {
            if (document.visibilityState !== "hidden") {
                reload();
            }
        };
        window.addEventListener("focus", refresh);
        document.addEventListener("visibilitychange", refresh);
        return () => {
            request.current++;
            unsubscribe?.();
            window.removeEventListener("focus", refresh);
            document.removeEventListener("visibilitychange", refresh);
        };
    }, [mod, reload, apply]);
    return { ...state, apply, reload };
}
