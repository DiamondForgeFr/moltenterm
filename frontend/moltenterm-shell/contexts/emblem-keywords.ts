// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the emblem picker's search knows besides an icon's name (FR-SHELL-158, #2476): a context is an activity, and the
// developer types the activity ("family", "travail", "sport"), not Lucide's name for a picture of it ("users-round",
// "briefcase"). Each line gives the words of a theme, in English and French and without accents, then the icons that stand
// for it. Words are matched as the start of a word of the query's. emblem-keywords.test.ts keeps every icon in the catalog.

type Theme = [words: string, icons: string];

const Themes: Theme[] = [
    [
        "work job jobs company business office career corporate employer travail entreprise societe boulot bureau carriere affaires employeur",
        "briefcase briefcase-business building building-2 factory store handshake presentation landmark warehouse hotel hospital school",
    ],
    [
        "home house family kids children parents foyer maison famille enfants parent",
        "house house-heart sofa bed bed-double armchair bath lamp lamp-floor baby users users-round heart heart-handshake hand-heart door-open",
    ],
    [
        "book books novel writing write writer author blog story reading livre livres roman ecriture ecrire auteur histoire lecture lire",
        "book book-open book-open-text book-open-check book-marked book-text notebook notebook-pen notebook-text notebook-tabs pen pen-line pencil pencil-line feather quote scroll-text file-pen library newspaper bookmark",
    ],
    [
        "health wellness medical medicine doctor care sante bien-etre medecin medecine soin soins",
        "stethoscope heart-pulse pill syringe thermometer activity hospital cross bandage ambulance heart",
    ],
    [
        "sport sports fitness gym workout running training exercise outdoor musculation course entrainement exterieur",
        "dumbbell bike footprints goal trophy medal person-standing volleyball mountain mountain-snow waves",
    ],
    [
        "music audio band sound song songs musique son chanson chansons groupe concert",
        "music music-2 music-3 music-4 guitar piano drum headphones mic mic-2 radio audio-lines audio-waveform speaker headset volume-2 disc-3 podcast",
    ],
    [
        "travel trip holiday holidays vacation journey voyage voyages vacances sejour tourisme",
        "plane plane-takeoff plane-landing luggage map map-pin compass ship sailboat train-front car car-front bus bike tent tent-tree backpack earth globe mountain palmtree umbrella",
    ],
    [
        "learning learn study school education teaching course class training apprentissage apprendre etude etudes ecole formation cours",
        "graduation-cap book-open school library library-big languages lightbulb notebook pencil-ruler backpack brain brain-cog",
    ],
    [
        "finance money accounting bank budget invoice invoices tax taxes salary argent comptabilite banque facture factures impots salaire",
        "wallet wallet-cards banknote coins piggy-bank credit-card receipt receipt-text calculator landmark chart-line chart-bar chart-pie chart-area trending-up dollar-sign circle-dollar-sign euro bitcoin percent badge-dollar-sign badge-euro hand-coins",
    ],
    [
        "code coding dev developer development software programming app apps tech logiciel developpement programmation informatique",
        "code code-xml terminal square-terminal braces bug cpu server database git-branch git-merge git-pull-request git-fork github gitlab container laptop laptop-minimal monitor webhook workflow circuit-board blocks package file-code",
    ],
    [
        "design creative creation art artist graphics drawing illustration photo conception creatif graphisme dessin artiste",
        "palette pen-tool brush paintbrush shapes ruler drafting-compass image camera film wand-sparkles scissors type frame aperture paint-bucket paint-roller pencil highlighter origami",
    ],
    [
        "science research lab laboratory physics chemistry biology experiment recherche laboratoire physique chimie biologie experience",
        "flask-conical flask-round atom microscope dna telescope orbit beaker test-tube test-tubes brain-cog satellite rocket",
    ],
    [
        "video film films cinema movie movies media game games gaming play fun jeu jeux jouer loisir loisirs hobby",
        "film clapperboard video popcorn gamepad-2 gamepad joystick dices puzzle swords theater drama ticket",
    ],
    [
        "food cooking cook kitchen recipe recipes restaurant meal cuisine cuisiner nourriture recette recettes repas",
        "utensils utensils-crossed chef-hat pizza sandwich cake cookie apple carrot salad soup ice-cream-cone coffee cooking-pot wine beer",
    ],
    [
        "nature garden gardening plants animals jardin jardinage plantes animaux",
        "leaf sprout flower flower-2 trees tree-pine tree-deciduous mountain sun clover shrub palmtree cat dog bird fish rabbit paw-print",
    ],
    [
        "computer hardware device devices ordinateur materiel appareil",
        "cpu server hard-drive laptop monitor smartphone tablet keyboard mouse usb plug battery wifi bluetooth tv",
    ],
    [
        "communication social contact contacts message messages mail email network courrier reseau",
        "mail inbox send phone message-circle message-square messages-square megaphone bell at-sign users contact rss",
    ],
    [
        "project projects planning plan tasks task todo roadmap projet projets planification taches tache feuille-de-route",
        "kanban list-checks list-todo clipboard-list clipboard-check calendar calendar-days calendar-check target flag milestone route workflow layout-dashboard folder-kanban folder",
    ],
    [
        "legal law admin administration paperwork contract juridique droit administratif contrat",
        "scale gavel file-text files stamp shield-check landmark clipboard printer",
    ],
    [
        "shopping commerce shop sales retail ecommerce boutique vente ventes",
        "shopping-cart shopping-bag store tag tags gift receipt package",
    ],
    [
        "security secure privacy password securite confidentialite mot-de-passe",
        "shield shield-check lock key key-round fingerprint-pattern vault",
    ],
    [
        "idea ideas inspiration innovation startup idee idees",
        "lightbulb sparkles brain rocket zap wand",
    ],
    [
        "favourite favorite favorites important star favori favoris etoile",
        "star heart flag bookmark crown gem award medal",
    ],
    [
        "personal private life perso prive vie",
        "heart smile house coffee gamepad-2 palmtree glasses",
    ],
    [
        "time clock schedule agenda temps horloge planning",
        "clock timer hourglass alarm-clock calendar history",
    ],
    [
        "place places city town ville lieu lieux",
        "map map-pin navigation landmark building building-2 castle church tent",
    ],
];

function buildKeywords(): Record<string, string[]> {
    const rtn: Record<string, string[]> = {};
    for (const [words, icons] of Themes) {
        const list = words.split(/\s+/).filter((w) => w !== "");
        for (const icon of icons.split(/\s+/).filter((n) => n !== "")) {
            (rtn[icon] ??= []).push(...list);
        }
    }
    return rtn;
}

// icon name → the words that find it (accent-free, lower case).
export const EmblemKeywords: Record<string, string[]> = buildKeywords();
