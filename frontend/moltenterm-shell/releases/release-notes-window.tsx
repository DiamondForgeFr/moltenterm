// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The version history (FR-REL-004, DS-REL-004), after Notulia's ReleaseNotesDialog: the versions this build knows on
// the left, each public version with its release candidates under it, and the notes of the selected one on the right.
// A gold, local or dev build starts with "This build": its own changes since the release it is built on. Loaded
// lazily (release-notes-host.tsx): the bundled notes and the markdown renderer stay out of the entry.

import { Markdown } from "@/app/element/markdown";
import { getApi } from "@/app/store/global";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { BuildIdentity, isReleaseChannel } from "../build/build-identity";
import type { MoltentermBuildChange } from "../build/build-info";
import { currentBuildIdentity, readBuildInfo } from "../build/current-build";
import { DialogFrame, useEscape } from "../dialog-frame";
import { getLocale, useT } from "../i18n/i18n";
import { readableSubject } from "../mission/versions";
import { BuildChanges, BundledReleaseNotes } from "./release-notes-bundle";
import { entryFor, groupBuildChanges, groupReleases, ReleaseNoteEntry, visibleEntries } from "./release-notes-catalog";
import { ReleaseNotesModel } from "./release-notes-store";

export const ThisBuildKey = "this-build";

type Row =
    | { kind: "build"; key: string }
    | { kind: "entry"; key: string; entry: ReleaseNoteEntry; offered: boolean; nested: boolean }
    | { kind: "upcoming"; key: string; base: string };

export type ReleaseHistory = { rows: Row[]; selectable: string[] };

// The list as it shows: This build first (a local channel), then each version and its candidates; an offered version
// the build has no notes for comes first, with the notes its update carried.
export function makeReleaseHistory(
    entries: readonly ReleaseNoteEntry[],
    identity: { channel: string },
    offered: { version: string; notes: string }
): ReleaseHistory {
    let visible = visibleEntries(entries, identity.channel);
    const offeredVersion = offered?.version?.replace(/^v/, "") ?? "";
    if (offeredVersion && offered.notes && !entryFor(visible, offeredVersion)) {
        visible = [
            { version: offeredVersion, notes: offered.notes, prerelease: offeredVersion.includes("-"), date: "" },
            ...visible,
        ];
    }
    const rows: Row[] = [];
    if (!isReleaseChannel(identity.channel as any)) {
        rows.push({ kind: "build", key: ThisBuildKey });
    }
    for (const group of groupReleases(visible)) {
        if (group.release) {
            rows.push({
                kind: "entry",
                key: group.release.version,
                entry: group.release,
                offered: group.release.version === offeredVersion,
                nested: false,
            });
        } else {
            rows.push({ kind: "upcoming", key: `upcoming-${group.base}`, base: group.base });
        }
        for (const candidate of group.candidates) {
            rows.push({
                kind: "entry",
                key: candidate.version,
                entry: candidate,
                offered: candidate.version === offeredVersion,
                nested: true,
            });
        }
    }
    return { rows, selectable: rows.filter((r) => r.kind !== "upcoming").map((r) => r.key) };
}

function Badge({ children, tone }: { children: React.ReactNode; tone?: "accent" | "muted" }) {
    return (
        <span
            className={cn(
                "shrink-0 rounded-4 border px-1 text-11 leading-4 font-medium",
                tone === "accent" ? "border-accent/60 text-accent" : "border-border text-muted"
            )}
        >
            {children}
        </span>
    );
}

function formatDate(date: string): string {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ? new Date(`${date}T12:00:00Z`) : null;
    return d == null || Number.isNaN(d.getTime())
        ? ""
        : d.toLocaleDateString(getLocale(), { day: "numeric", month: "long", year: "numeric" });
}

function ChangeList({ title, changes }: { title: string; changes: MoltentermBuildChange[] }) {
    if (changes.length === 0) {
        return null;
    }
    return (
        <section>
            <h3 className="mb-1 text-11 font-semibold tracking-wide text-muted uppercase">{title}</h3>
            <ul className="flex flex-col gap-0.5 text-12">
                {changes.map((c) => {
                    const s = readableSubject(c.subject);
                    return (
                        <li key={c.sha} className="flex min-w-0 gap-1.5" title={c.subject}>
                            <span className="shrink-0 font-mono text-11 text-muted">{c.sha}</span>
                            <span className="min-w-0 truncate">
                                {s.ticket ? <span className="text-muted">#{s.ticket} </span> : null}
                                {s.text}
                            </span>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}

function ThisBuildPane({ identity }: { identity: BuildIdentity }) {
    const t = useT();
    const build = readBuildInfo();
    const groups = useMemo(() => groupBuildChanges(BuildChanges as MoltentermBuildChange[]), []);
    const listed = BuildChanges.length;
    // Before the first release, git's count includes the upstream history the list leaves out.
    const total = build?.releaseTag ? Math.max(listed, build.changesSinceRelease ?? 0) : listed;
    return (
        <article aria-label={t("releases.thisBuild")} className="flex flex-col gap-3">
            <header>
                <h2 className="text-15 font-semibold text-primary">{t("releases.thisBuild")}</h2>
                <div className="mt-0.5 text-12 text-secondary">{identity.buildLine}</div>
                {identity.commitLine ? <div className="font-mono text-11 text-muted">{identity.commitLine}</div> : null}
                {build?.builtAt ? (
                    <div className="text-11 text-muted">
                        {t("releases.built", { date: new Date(build.builtAt).toLocaleString(getLocale()) })}
                    </div>
                ) : null}
            </header>
            {total === 0 ? (
                <div className="text-12 text-muted">
                    {build?.releaseTag
                        ? t("releases.noChangeSince", { tag: build.releaseTag })
                        : t("releases.noChangeBefore")}
                </div>
            ) : (
                <>
                    <div className="text-12 text-secondary">
                        {build?.releaseTag
                            ? t(total > listed ? "releases.changesSinceListed" : "releases.changesSince", {
                                  changes:
                                      total === 1 ? t("releases.oneChange") : t("releases.changes", { count: total }),
                                  tag: build.releaseTag,
                                  listed,
                              })
                            : listed === 1
                              ? t("releases.noReleaseNewestOne")
                              : t("releases.noReleaseNewest", { count: listed })}
                    </div>
                    <ChangeList title={t("releases.new")} changes={groups.features} />
                    <ChangeList title={t("releases.fixed")} changes={groups.fixes} />
                    <ChangeList title={t("releases.other")} changes={groups.other} />
                    {groups.internal > 0 ? (
                        <div className="text-11 text-muted" data-testid="release-notes-internal">
                            {groups.internal === 1
                                ? t("releases.internalOne")
                                : t("releases.internalOther", { count: groups.internal })}
                        </div>
                    ) : null}
                </>
            )}
        </article>
    );
}

const NotesMarkdown = memo(({ notes }: { notes: string }) => {
    return <Markdown text={notes} scrollable={false} fontSizeOverride={13} fixedFontSizeOverride={12} />;
});
NotesMarkdown.displayName = "NotesMarkdown";

function EntryPane({ entry }: { entry: ReleaseNoteEntry }) {
    const t = useT();
    const date = formatDate(entry.date);
    return (
        <article aria-label={`MoltenTerm ${entry.version}`} className="flex flex-col gap-2">
            <header>
                <h2 className="text-15 font-semibold text-primary">MoltenTerm {entry.version}</h2>
                <div className="text-11 text-muted">
                    {[entry.prerelease ? t("releases.candidate") : t("releases.release"), date]
                        .filter((s) => s)
                        .join(" · ")}
                </div>
            </header>
            <div className="molten-release-notes min-w-0">
                <NotesMarkdown notes={entry.notes} />
            </div>
        </article>
    );
}

export function ReleaseNotesWindow() {
    const t = useT();
    const model = ReleaseNotesModel.getInstance();
    const requested = useAtomValue(model.requestedVersionAtom);
    const offered = useAtomValue(model.offeredAtom);
    const identity = useMemo(() => currentBuildIdentity(getApi().getAboutModalDetails()?.version ?? ""), []);
    const history = useMemo(() => makeReleaseHistory(BundledReleaseNotes, identity, offered), [identity, offered]);
    const initial = useMemo(() => {
        const wanted = (requested ?? "").replace(/^v/, "");
        if (wanted && history.selectable.includes(wanted)) {
            return wanted;
        }
        if (history.selectable.includes(ThisBuildKey)) {
            return ThisBuildKey;
        }
        if (history.selectable.includes(identity.version)) {
            return identity.version;
        }
        return history.selectable[0] ?? null;
    }, [requested, history, identity]);
    const [selected, setSelected] = useState<string>(initial);
    useEffect(() => setSelected(initial), [initial]);
    const listRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        listRef.current?.querySelector<HTMLElement>('[aria-current="true"]')?.focus();
    }, []);
    useEscape(true, () => model.close());

    const move = (e: React.KeyboardEvent) => {
        const keys = history.selectable;
        const index = keys.indexOf(selected);
        let next = index;
        if (e.key === "ArrowDown") {
            next = Math.min(keys.length - 1, index + 1);
        } else if (e.key === "ArrowUp") {
            next = Math.max(0, index - 1);
        } else if (e.key === "Home") {
            next = 0;
        } else if (e.key === "End") {
            next = keys.length - 1;
        } else {
            return;
        }
        e.preventDefault();
        if (next < 0 || next === index) {
            return;
        }
        setSelected(keys[next]);
        requestAnimationFrame(() =>
            listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(keys[next])}"]`)?.focus()
        );
    };

    const selectedRow = history.rows.find((r) => r.key === selected);
    const installed = (entry: ReleaseNoteEntry) =>
        isReleaseChannel(identity.channel) && entry.version === identity.version;
    const subtitle = isReleaseChannel(identity.channel)
        ? t("releases.subtitleRelease", { version: identity.version, wave: identity.waveBase })
        : t("releases.subtitleBuild", {
              channel: identity.channelLabel,
              version: identity.version || t("releases.unknownVersion"),
              wave: identity.waveBase,
          });
    return (
        <DialogFrame
            role="release-notes"
            title={t("releases.title")}
            subtitle={subtitle}
            widthClass="w-[780px]"
            trapFocus={true}
            onBackdrop={() => model.close()}
            buttons={
                <button
                    type="button"
                    onClick={() => model.close()}
                    className="cursor-pointer rounded-6 border border-border px-3 py-1.5 text-12 text-secondary hover:bg-hover hover:text-primary"
                >
                    {t("common.close")}
                </button>
            }
        >
            <div className="-mx-4 -my-3 flex h-[min(62vh,520px)] min-h-0" data-testid="release-notes-window">
                {history.rows.length === 0 ? (
                    <div className="px-4 py-3 text-12 text-muted">{t("releases.empty")}</div>
                ) : (
                    <>
                        <div
                            ref={listRef}
                            role="navigation"
                            aria-label={t("releases.versions")}
                            onKeyDown={move}
                            className="flex w-[200px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-2"
                        >
                            {history.rows.map((row) => {
                                if (row.kind === "upcoming") {
                                    return (
                                        <div
                                            key={row.key}
                                            className="mt-1 flex items-center gap-1.5 px-2 py-1 text-12 text-muted"
                                        >
                                            <span className="font-mono">{row.base}</span>
                                            <span className="text-11">{t("releases.upcoming")}</span>
                                        </div>
                                    );
                                }
                                const active = row.key === selected;
                                return (
                                    <button
                                        key={row.key}
                                        type="button"
                                        data-key={row.key}
                                        tabIndex={active ? 0 : -1}
                                        aria-current={active ? "true" : undefined}
                                        onClick={() => setSelected(row.key)}
                                        className={cn(
                                            "flex w-full cursor-pointer items-center justify-between gap-2 rounded-6 px-2 py-1 text-left text-12",
                                            row.kind === "entry" && row.nested && "pl-5",
                                            active
                                                ? "bg-hover font-medium text-primary"
                                                : "text-secondary hover:bg-hover/60 hover:text-primary"
                                        )}
                                    >
                                        {row.kind === "build" ? (
                                            <>
                                                <span>{t("releases.thisBuild")}</span>
                                                <Badge tone="accent">{t("releases.installed")}</Badge>
                                            </>
                                        ) : (
                                            <>
                                                <span className="truncate font-mono tabular-nums">
                                                    {row.entry.version}
                                                </span>
                                                {row.offered ? (
                                                    <Badge tone="accent">{t("releases.offered")}</Badge>
                                                ) : installed(row.entry) ? (
                                                    <Badge tone="accent">{t("releases.installed")}</Badge>
                                                ) : row.entry.prerelease ? (
                                                    <Badge>{t("releases.candidateBadge")}</Badge>
                                                ) : null}
                                            </>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                        <div
                            className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-4"
                            data-testid="release-notes-pane"
                        >
                            {selectedRow?.kind === "build" ? <ThisBuildPane identity={identity} /> : null}
                            {selectedRow?.kind === "entry" ? <EntryPane entry={selectedRow.entry} /> : null}
                        </div>
                    </>
                )}
            </div>
        </DialogFrame>
    );
}
