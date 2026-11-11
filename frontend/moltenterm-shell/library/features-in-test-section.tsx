// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The library's Features in test section (FR-BOSS-011, #2254), on gold, dev and local builds: every feature that ships
// gated to the build channel while it is tested, with a switch to turn it off on this computer, and See the public
// version, which turns them all off at once. The switches only narrow; the registry, the rule and the state are in
// build/gated-features.ts and build/features-narrowing.ts.

import { cn, fireAndForget } from "@/util/util";
import { useBossName } from "../boss/use-boss-name";
import { currentChannel } from "../build/current-build";
import { switchFeature, switchPublicVersion } from "../build/features-in-test-store";
import { useNarrowing } from "../build/features-narrowing";
import type { GatedFeatureId } from "../build/gated-features";
import { useT } from "../i18n/i18n";
import { featureRows, type FeatureRow } from "./features-in-test-model";

function Switch({
    on,
    locked,
    label,
    testId,
    onToggle,
}: {
    on: boolean;
    locked: boolean;
    label: string;
    testId: string;
    onToggle: () => void;
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={label}
            disabled={locked}
            data-testid={testId}
            onClick={onToggle}
            className="inline-flex h-row cursor-pointer items-center rounded-4 px-1 disabled:cursor-default disabled:opacity-50"
        >
            <span className={cn("molten-cmdpanel-switch", on && "is-on")} aria-hidden />
        </button>
    );
}

function FeatureItem({
    row,
    bossName,
    onSwitch,
}: {
    row: FeatureRow;
    bossName: string;
    onSwitch: (id: GatedFeatureId, off: boolean) => void;
}) {
    const t = useT();
    const name = t(row.labelKey, { name: bossName });
    return (
        <li
            className="mt-lib-agblock mt-lib-feat"
            data-testid="features-row"
            data-feature={row.id}
            data-state={row.state}
        >
            <div className="mt-lib-feat-main">
                <strong className="mt-lib-feat-name">{name}</strong>
                <p>{t(row.descriptionKey, { name: bossName })}</p>
                <div className="mt-lib-feat-meta">
                    <span>{t("featuresInTest.openOn")}</span>
                    {row.channels.map((channel) => (
                        <span key={channel} className="mt-lib-feat-chip" data-testid="features-channel">
                            {t(`build.channels.${channel}`)}
                        </span>
                    ))}
                    <span data-testid="features-ticket">{t("featuresInTest.ticket", { number: row.ticket })}</span>
                </div>
            </div>
            <div className="mt-lib-feat-side">
                <span data-testid="features-state">{t(`featuresInTest.state.${row.state}`)}</span>
                <Switch
                    on={row.on}
                    locked={row.locked}
                    label={t("featuresInTest.switchLabel", { name })}
                    testId="features-switch"
                    onToggle={() => onSwitch(row.id, row.on)}
                />
            </div>
        </li>
    );
}

export function FeaturesInTestPage({
    rows,
    publicVersion,
    bossName,
    onSwitch,
    onPublicVersion,
}: {
    rows: FeatureRow[];
    publicVersion: boolean;
    bossName: string;
    // off: the developer is turning the feature off (it was on).
    onSwitch: (id: GatedFeatureId, off: boolean) => void;
    onPublicVersion: (on: boolean) => void;
}) {
    const t = useT();
    return (
        <div className="mt-lib-agpage" data-testid="library-features">
            <section className="mt-lib-agblock mt-lib-feat" data-testid="features-public">
                <div className="mt-lib-feat-main">
                    <strong className="mt-lib-feat-name">{t("featuresInTest.publicVersion.label")}</strong>
                    <p>{t("featuresInTest.publicVersion.description")}</p>
                </div>
                <div className="mt-lib-feat-side">
                    <Switch
                        on={publicVersion}
                        locked={false}
                        label={t("featuresInTest.publicVersion.label")}
                        testId="features-public-switch"
                        onToggle={() => onPublicVersion(!publicVersion)}
                    />
                </div>
            </section>
            <ul className="mt-lib-feat-list" aria-label={t("featuresInTest.list")}>
                {rows.map((row) => (
                    <FeatureItem key={row.id} row={row} bossName={bossName} onSwitch={onSwitch} />
                ))}
            </ul>
            <p className="mt-lib-agnote" data-testid="features-note">
                {t("featuresInTest.note")}
            </p>
        </div>
    );
}

export function FeaturesInTestSection() {
    const narrowing = useNarrowing();
    const bossName = useBossName();
    return (
        <FeaturesInTestPage
            rows={featureRows(currentChannel(), narrowing)}
            publicVersion={narrowing.public}
            bossName={bossName}
            onSwitch={(id, off) => fireAndForget(() => switchFeature(id, off))}
            onPublicVersion={(on) => fireAndForget(() => switchPublicVersion(on))}
        />
    );
}
