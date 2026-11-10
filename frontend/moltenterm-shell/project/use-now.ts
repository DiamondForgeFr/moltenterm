// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { useEffect, useState } from "react";
import { TabActivity, whileShown } from "../tab-activity";

// A clock that ticks once a second while something runs and the tab is visible.
export function useNow(active: boolean): number {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!active) {
            return;
        }
        setNow(Date.now());
        return TabActivity.getInstance().every(whileShown(1000), () => setNow(Date.now()), "clock");
    }, [active]);
    return now;
}
