// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The scripted replay of a brainstorm (FR-BOSS-010, #2246): on a dev or local build, a palette action plays a synthetic
// brainstorm (the approved mockup's script) as if Brokk's agent had answered it. Each answer goes through the same
// reading as a real one (BrokkSession.replayStep, then the brainstorm store's answerStep and wavesrv's route), so the
// mode, the graph, the camera, the pause and the folder are checked without an agent and with no subscription spent.
//
// The script stands in for a model's output: it is data, written in the interface's two shipped languages, never shown
// on a release (the action exists on dev and local builds only). Loaded on demand from the palette.

import { globalStore } from "@/app/store/jotaiStore";
import { BossBubbleModel } from "../boss/boss-store";
import { BrokkSession } from "../boss/brokk-session";
import { getLocale } from "../i18n/i18n";
import { loadBrainstorm } from "./brainstorm-boot";
import type { BriefDraft } from "./brainstorm-brief-model";
import { GraphFence, GraphOp } from "./brainstorm-graph-model";
import { BrainstormModel, focusTalkField } from "./brainstorm-store";

export type ReplayStep = { you: string; line: string; ops: GraphOp[] };

const centre = (id: string, text: string): GraphOp => ({ op: "centre", id, text });
const add = (id: string, kind: string, text: string, from: string): GraphOp => ({ op: "add", id, kind, text, from });
const link = (a: string, b: string, why: string): GraphOp => ({ op: "link", a, b, why });
// His question when the talk turns into another project (#2248): the widget asks the developer.
const fork = (title: string, reason: string): GraphOp => ({ op: "fork", title, reason });
// He prunes what the talk made obsolete (#2247): the layer offers Undo for his removal.
const remove = (id: string, reason: string): GraphOp => ({ op: "remove", id, reason });
const retype = (id: string, kind: string): GraphOp => ({ op: "retype", id, kind });
// The first pass is clear (#2250): his conclusion with its brief, and his proposals to make it a project, then to set
// up SaaSFoundryAI and hand the first step to a coding agent (#2251).
const conclude = (id: string, text: string, brief: BriefDraft): GraphOp => ({ op: "conclude", id, text, brief });
const propose = (id: string, text: string, from: string, action = "project"): GraphOp => ({
    op: "propose",
    id,
    text,
    from,
    action,
});

const ReplayBriefs: Record<"en" | "fr", BriefDraft> = {
    en: {
        name: "Safe Kids Videos",
        slug: "safe-kids-videos",
        pitch: "A video app where parents validate every video their child can watch.",
        problem: "The video apps for children recommend and play what nobody chose.",
        users: "Parents of children from 3 to 10, on a tablet.",
        scope: {
            in: ["A list of videos the parents validate", "Tablet first"],
            out: ["Ads", "Automatic recommendations"],
        },
        stack: [],
        profile: "full",
        profilereason: "It is a web app for parents: SaaSFoundryAI's stack fits it.",
        firststep: "Sketch the parents' validation flow.",
        openquestions: ["How do parents find the videos to validate?"],
        language: "en",
    },
    fr: {
        name: "Vidéos sûres pour enfants",
        slug: "videos-sures-enfants",
        pitch: "Une app vidéo où les parents valident chaque vidéo que l'enfant peut voir.",
        problem: "Les apps vidéo pour enfants recommandent et jouent ce que personne n'a choisi.",
        users: "Les parents d'enfants de 3 à 10 ans, sur tablette.",
        scope: {
            in: ["Une liste de vidéos validées par les parents", "La tablette d'abord"],
            out: ["La pub", "Les recommandations automatiques"],
        },
        stack: [],
        profile: "full",
        profilereason: "C'est une app web pour les parents : la stack de SaaSFoundryAI lui va.",
        firststep: "Esquisser le parcours de validation des parents.",
        openquestions: ["Comment les parents trouvent-ils les vidéos à valider ?"],
        language: "fr",
    },
};

export const ReplayScripts: Record<"en" | "fr", ReplayStep[]> = {
    en: [
        {
            you: "I have an idea for a video app for kids: the ones out there don't suit me.",
            line: "A safe video app for children. Let's put it on the anvil: I'm placing it at the centre.",
            ops: [centre("kids-video", "A safe video app for children")],
        },
        {
            you: "Yes, let's dig.",
            line: "First: for which ages?",
            ops: [add("ages", "question", "For which ages?", "kids-video")],
        },
        {
            you: "From 3 to 10.",
            line: "From 3 to 10, noted. And who picks what they watch?",
            ops: [
                add("three-ten", "answer", "From 3 to 10", "ages"),
                add("who-picks", "question", "Who picks the videos?", "kids-video"),
            ],
        },
        {
            you: "Not sure yet.",
            line: "Two paths: a list you validate, or channels other parents approve.",
            ops: [
                add("parents-list", "idea", "Parents validate a list", "who-picks"),
                add("approved-channels", "idea", "Channels approved by other parents", "who-picks"),
                link("parents-list", "approved-channels", "two ways to trust a video"),
            ],
        },
        {
            you: "Parents must be able to validate everything.",
            line: "Then the list it is: I'm making it a decision and dropping the channels. On which devices, to start?",
            ops: [
                retype("parents-list", "decision"),
                remove("approved-channels", "the parents validate everything"),
                add("devices", "question", "On which devices?", "kids-video"),
            ],
        },
        {
            you: "The tablet.",
            line: "The tablet first. I'm tying the age to the device.",
            ops: [
                add("tablet", "answer", "The tablet first", "devices"),
                link("three-ten", "tablet", "small hands, big screen"),
            ],
        },
        {
            you: "And no ads, ever.",
            line: "Decision: no ads and no automatic recommendations. It follows from the validated list.",
            ops: [
                add("no-ads", "decision", "No ads, no automatic recommendations", "kids-video"),
                link("parents-list", "no-ads", "nothing plays that was not chosen"),
            ],
        },
        {
            you: "That's it, I think. And games would need parental control too.",
            line: "The idea is clear: a first pass is ready, and we can make it a project, set up SaaSFoundryAI, then hand the first step to your coding agent. Parental control for games is another project: shall I open its own folder?",
            ops: [
                conclude("first-pass", "Clear idea: a first pass is ready", ReplayBriefs.en),
                propose("make-it", "Make it a project", "first-pass"),
                propose("set-it-up", "Set up SaaSFoundryAI: full", "first-pass", "saasfoundry"),
                propose("hand-it-on", "Hand the first step to a coding agent", "first-pass", "handoff"),
                fork("Parental control for games", "games are another product than videos"),
            ],
        },
    ],
    fr: [
        {
            you: "J'ai une idée d'app vidéo pour les enfants : celles d'aujourd'hui ne me conviennent pas.",
            line: "Une app vidéo sûre pour les enfants. On la met sur l'enclume : je la pose au centre.",
            ops: [centre("app-video-enfants", "Une app vidéo sûre pour les enfants")],
        },
        {
            you: "Oui, creusons.",
            line: "D'abord : pour quel âge ?",
            ops: [add("age", "question", "Pour quel âge ?", "app-video-enfants")],
        },
        {
            you: "De 3 à 10 ans.",
            line: "De 3 à 10 ans, noté. Et qui choisit ce qu'ils regardent ?",
            ops: [
                add("trois-dix", "answer", "De 3 à 10 ans", "age"),
                add("qui-choisit", "question", "Qui choisit les vidéos ?", "app-video-enfants"),
            ],
        },
        {
            you: "Je ne sais pas encore.",
            line: "Deux pistes : une liste validée par vous, ou des chaînes que d'autres parents approuvent.",
            ops: [
                add("liste-parents", "idea", "Les parents valident une liste", "qui-choisit"),
                add("chaines-approuvees", "idea", "Des chaînes approuvées par d'autres parents", "qui-choisit"),
                link("liste-parents", "chaines-approuvees", "deux façons de faire confiance"),
            ],
        },
        {
            you: "Les parents doivent pouvoir tout valider.",
            line: "Alors la liste : j'en fais une décision et je retire les chaînes. Sur quels appareils, au départ ?",
            ops: [
                retype("liste-parents", "decision"),
                remove("chaines-approuvees", "les parents valident tout"),
                add("appareils", "question", "Sur quels appareils ?", "app-video-enfants"),
            ],
        },
        {
            you: "La tablette.",
            line: "La tablette d'abord. Je relie l'âge et l'appareil.",
            ops: [
                add("tablette", "answer", "La tablette d'abord", "appareils"),
                link("trois-dix", "tablette", "petites mains, grand écran"),
            ],
        },
        {
            you: "Et pas de pub, jamais.",
            line: "Décision : ni pub, ni recommandations automatiques. Ça découle de la liste validée.",
            ops: [
                add("sans-pub", "decision", "Ni pub, ni recommandations automatiques", "app-video-enfants"),
                link("liste-parents", "sans-pub", "rien ne joue qui n'ait été choisi"),
            ],
        },
        {
            you: "C'est tout, je crois. Et les jeux auraient besoin d'un contrôle parental aussi.",
            line: "L'idée est claire : une première passe est prête. On peut en faire un projet, installer SaaSFoundryAI, puis passer le premier pas à votre agent de code. Le contrôle parental pour les jeux, c'est un autre projet : je lui ouvre son propre dossier ?",
            ops: [
                fork("Contrôle parental pour les jeux", "les jeux sont un autre produit que les vidéos"),
                conclude("premiere-passe", "Idée claire : première passe prête", ReplayBriefs.fr),
                propose("en-faire-un-projet", "En faire un projet", "premiere-passe"),
                propose("l-installer", "Installer SaaSFoundryAI : complet", "premiere-passe", "saasfoundry"),
                propose("passer-le-relais", "Passer le premier pas à un agent de code", "premiere-passe", "handoff"),
            ],
        },
    ],
};

// His answer as his agent would write it: his line, then the block.
export function replayAnswer(step: ReplayStep): string {
    const block = JSON.stringify({ v: 1, talk: "project", ops: step.ops });
    return `${step.line}\n\n\`\`\`${GraphFence}\n${block}\n\`\`\``;
}

export function replayScript(locale: string): ReplayStep[] {
    return /^fr(-|$)/.test(locale ?? "") ? ReplayScripts.fr : ReplayScripts.en;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let playing = 0;

// Plays the script: each step's message, then his line coming in, then his block, then the end of his answer; the next
// step after `stepMs`. A new replay stops the one before.
export async function playReplay(stepMs = 3600): Promise<void> {
    const run = ++playing;
    await loadBrainstorm();
    const model = BrainstormModel.getInstance();
    const session = BrokkSession.getInstance();
    const boss = BossBubbleModel.getInstance();
    if (model.isOpen()) {
        await model.end();
    }
    boss.openCard(undefined, { force: true });
    boss.pinCard();
    focusTalkField();
    const script = replayScript(getLocale());
    const base = 900000 + Math.floor(Date.now() % 100000) * 10;
    for (let i = 0; i < script.length; i++) {
        if (run !== playing || (i > 0 && !globalStore.get(model.openAtom))) {
            return;
        }
        const step = script[i];
        const key = `replay-${run}-${i}`;
        const turn = base + i;
        const answer = replayAnswer(step);
        session.replayStep(key, step.you, "", turn, false);
        await wait(Math.min(700, stepMs / 5));
        session.replayStep(key, step.you, step.line, turn, false);
        await wait(Math.min(700, stepMs / 5));
        session.replayStep(key, step.you, answer, turn, false);
        await wait(Math.min(1200, stepMs / 3));
        session.replayStep(key, step.you, answer, turn, true);
        await wait(Math.max(0, stepMs - 2600));
    }
}

export function stopReplay(): void {
    playing++;
}
