// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// MOLTENTERM-PATCH (#161): MoltenTerm's first run (frontend/moltenterm-onboarding/) replaces Wave's new-install and
// upgrade onboarding; Wave's onboarding files stay in the tree, unmounted.
import { globalStore } from "@/app/store/jotaiStore";
import { atoms } from "@/store/global";
import { modalsModel } from "@/store/modalmodel";
import * as jotai from "jotai";
import { useEffect } from "react";
import { useMoltentermStartup } from "../../moltenterm-onboarding/onboarding-host";
import { getModalComponent } from "./modalregistry";

const ModalsRenderer = () => {
    useMoltentermStartup(); // MOLTENTERM-PATCH (#161)
    const [modals] = jotai.useAtom(modalsModel.modalsAtom);
    const rtn: React.ReactElement[] = [];
    for (const modal of modals) {
        const ModalComponent = getModalComponent(modal.displayName);
        if (ModalComponent) {
            rtn.push(<ModalComponent key={modal.displayName} {...modal.props} />);
        }
    }
    useEffect(() => {
        globalStore.set(atoms.modalOpen, rtn.length > 0);
    }, [rtn]);

    return <>{rtn}</>;
};

export { ModalsRenderer };
