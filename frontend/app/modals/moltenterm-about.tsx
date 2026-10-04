// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Moltenterm's About panel. modalregistry.tsx registers it under Wave's modal
// name ("AboutModal"), so every existing way of opening About shows this one.

import Logo from "@/app/asset/logo.svg";
import { OnboardingGradientBg } from "@/app/onboarding/onboarding-common";
import { atoms } from "@/app/store/global";
import { modalsModel } from "@/app/store/modalmodel";
import { isDev } from "@/util/isdev";
import { moltentermProductNameFor, MoltentermRepoUrl, MoltentermTagline } from "@/util/moltenterm-identity";
import { useAtomValue } from "jotai";
import { Modal } from "./modal";

const WaveTerminalRepoUrl = "https://github.com/wavetermdev/waveterm";

const linkClassName =
    "inline-flex items-center justify-center px-4 py-2 rounded border border-border hover:bg-hoverbg transition-colors duration-200";

interface MoltentermAboutModalVProps {
    versionString: string;
    onClose: () => void;
}

const MoltentermAboutModalV = ({ versionString, onClose }: MoltentermAboutModalVProps) => {
    const currentYear = new Date().getFullYear();

    return (
        <Modal className="pt-[34px] pb-[34px] overflow-hidden w-[450px]" onClose={onClose}>
            <OnboardingGradientBg />
            <div className="flex flex-col gap-[26px] w-full relative z-10">
                <div className="flex flex-col items-center justify-center gap-4 self-stretch w-full text-center">
                    <Logo />
                    <div className="text-[25px]">
                        {moltentermProductNameFor(
                            typeof __MOLTENTERM_BUILD__ === "undefined" ? null : __MOLTENTERM_BUILD__.channel,
                            isDev()
                        )}
                    </div>
                    <div className="leading-5">{MoltentermTagline}</div>
                </div>
                <div className="items-center gap-4 self-stretch w-full text-center">
                    Version {versionString}
                    <br />
                    Built on Wave Terminal by Command Line Inc. (Apache-2.0)
                </div>
                <div className="grid grid-cols-2 gap-[10px] self-stretch w-full">
                    <a href={MoltentermRepoUrl} target="_blank" rel="noopener" className={linkClassName}>
                        <i className="fa-brands fa-github mr-2"></i>GitHub
                    </a>
                    <a href={WaveTerminalRepoUrl} target="_blank" rel="noopener" className={linkClassName}>
                        <i className="fa-solid fa-code-fork mr-2"></i>Wave Terminal
                    </a>
                </div>
                <div className="items-center gap-4 self-stretch w-full text-center">
                    &copy; {currentYear} DiamondForge. Portions &copy; Command Line Inc.
                </div>
            </div>
        </Modal>
    );
};

MoltentermAboutModalV.displayName = "MoltentermAboutModalV";

const AboutModal = () => {
    const fullConfig = useAtomValue(atoms.fullConfigAtom);
    const versionString = `${fullConfig?.version ?? ""} (${isDev() ? "dev-" : ""}${fullConfig?.buildtime ?? ""})`;

    return <MoltentermAboutModalV versionString={versionString} onClose={() => modalsModel.popModal()} />;
};

AboutModal.displayName = "AboutModal";

export { AboutModal, MoltentermAboutModalV };
