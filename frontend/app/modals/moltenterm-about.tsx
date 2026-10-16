// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Moltenterm's About panel. modalregistry.tsx registers it under Wave's modal
// name ("AboutModal"), so every existing way of opening About shows this one.

import Logo from "@/app/asset/logo.svg";
import { OnboardingGradientBg } from "@/app/onboarding/onboarding-common";
import { atoms } from "@/app/store/global";
import { modalsModel } from "@/app/store/modalmodel";
import { isDev } from "@/util/isdev";
import { moltentermProductNameFor, MoltentermRepoUrl } from "@/util/moltenterm-identity";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import type { BuildIdentity } from "../../moltenterm-shell/build/build-identity";
import { currentBuildIdentity } from "../../moltenterm-shell/build/current-build";
import { useT } from "../../moltenterm-shell/i18n/i18n";
import { ReleaseNotesModel } from "../../moltenterm-shell/releases/release-notes-store";
import { Modal } from "./modal";

const WaveTerminalRepoUrl = "https://github.com/wavetermdev/waveterm";

const linkClassName =
    "inline-flex items-center justify-center px-4 py-2 rounded border border-border hover:bg-hoverbg transition-colors duration-200";

interface MoltentermAboutModalVProps {
    identity: BuildIdentity;
    onClose: () => void;
}

const MoltentermAboutModalV = ({ identity, onClose }: MoltentermAboutModalVProps) => {
    const t = useT();
    const currentYear = new Date().getFullYear();
    // About closes first: the version history is a dialog of its own, over the app.
    const openReleaseNotes = () => {
        onClose();
        ReleaseNotesModel.getInstance().open();
    };

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
                    <div className="leading-5">{t("about.tagline")}</div>
                </div>
                <div className="flex flex-col items-center gap-1 self-stretch w-full text-center">
                    <button
                        type="button"
                        onClick={openReleaseNotes}
                        title={t("about.releaseNotes")}
                        className="cursor-pointer text-primary hover:underline"
                    >
                        {t("about.version", { version: identity.version || t("about.unknownVersion") })}
                    </button>
                    <div className="text-xs text-secondary">{identity.buildLine}</div>
                    {identity.commitLine ? (
                        <div className="text-xs text-secondary font-mono">{identity.commitLine}</div>
                    ) : null}
                    <div className="mt-2">{t("about.basedOn", { wave: identity.waveBase })}</div>
                </div>
                <div className="grid grid-cols-2 gap-[10px] self-stretch w-full">
                    <button
                        type="button"
                        onClick={openReleaseNotes}
                        className={cn(linkClassName, "col-span-2 cursor-pointer text-accent")}
                    >
                        <i className="fa-solid fa-scroll mr-2"></i>
                        {t("about.releaseNotes")}
                    </button>
                    <a href={MoltentermRepoUrl} target="_blank" rel="noopener" className={linkClassName}>
                        <i className="fa-brands fa-github mr-2"></i>GitHub
                    </a>
                    <a href={WaveTerminalRepoUrl} target="_blank" rel="noopener" className={linkClassName}>
                        <i className="fa-solid fa-code-fork mr-2"></i>Wave Terminal
                    </a>
                </div>
                <div className="items-center gap-4 self-stretch w-full text-center">
                    {t("about.copyright", { year: currentYear })}
                </div>
            </div>
        </Modal>
    );
};

MoltentermAboutModalV.displayName = "MoltentermAboutModalV";

const AboutModal = () => {
    const fullConfig = useAtomValue(atoms.fullConfigAtom);
    const version = fullConfig?.version ?? "";
    const identity = useMemo(() => currentBuildIdentity(version), [version]);

    return <MoltentermAboutModalV identity={identity} onClose={() => modalsModel.popModal()} />;
};

AboutModal.displayName = "AboutModal";

export { AboutModal, MoltentermAboutModalV };
