// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Names the licence a licence file holds (#2126). npm packages declare theirs, Go modules do not, and a package can
// declare "SEE LICENSE IN LICENSE" or nothing: the text then decides. Only the licences the allow-list can name are
// recognised, by the sentences each one is made of; a text that matches none is "unknown", which the check refuses
// until someone reviews it. The match is on the words, not the layout or the copyright line.

const Word = /[^a-z0-9]+/g;

export function normalizeText(text) {
  return ` ${text.toLowerCase().replace(Word, " ").trim()} `;
}

const BsdPreamble =
  "redistribution and use in source and binary forms with or without modification are permitted provided that the following conditions are met";
const BsdSource = "redistributions of source code must retain the above copyright notice";
const BsdBinary = "redistributions in binary form must reproduce the above copyright notice";
const BsdEndorse = "endorse or promote products derived from this software without specific prior written permission";
const BsdAdvertising = "all advertising materials mentioning features";
const IscGrant =
  "permission to use copy modify and or distribute this software for any purpose with or without fee is hereby granted";

// Each rule: the id, and a test on the normalised text. A text can match several rules (a file that holds two licences).
const Rules = [
  {
    id: "Apache-2.0",
    test: (t) =>
      (t.includes(" apache license version 2 0 ") &&
        t.includes(" terms and conditions for use reproduction and distribution ")) ||
      t.includes(" licensed under the apache license version 2 0 the license "),
  },
  { id: "MPL-2.0", test: (t) => t.includes(" mozilla public license version 2 0 ") },
  {
    id: "Unlicense",
    test: (t) => t.includes(" this is free and unencumbered software released into the public domain "),
  },
  { id: "BlueOak-1.0.0", test: (t) => t.includes(" blue oak model license version 1 0 0 ") },
  { id: "CC0-1.0", test: (t) => t.includes(" cc0 1 0 universal ") || t.includes(" creative commons zero ") },
  { id: "OFL-1.1", test: (t) => t.includes(" sil open font license version 1 1 ") },
  { id: "Python-2.0", test: (t) => t.includes(" python software foundation license version 2 ") },
  { id: "CC-BY-4.0", test: (t) => t.includes(" creative commons attribution 4 0 international ") },
  {
    id: "Zlib",
    test: (t) =>
      t.includes(" in no event will the authors be held liable for any damages ") &&
      t.includes(" altered source versions must be plainly marked as such "),
  },
  {
    id: "MIT",
    test: (t) =>
      t.includes(" permission is hereby granted free of charge to any person obtaining a copy of this software ") &&
      t.includes(" the software is provided as is without warranty of any kind "),
  },
  {
    id: "ISC",
    test: (t) =>
      t.includes(IscGrant) &&
      t.includes(" provided that the above copyright notice and this permission notice appear in all copies "),
  },
  {
    id: "0BSD",
    test: (t) =>
      t.includes(IscGrant) &&
      !t.includes(" provided that the above copyright notice and this permission notice appear in all copies "),
  },
  {
    id: "BSD-2-Clause",
    test: (t) =>
      t.includes(BsdPreamble) &&
      t.includes(BsdSource) &&
      t.includes(BsdBinary) &&
      !t.includes(BsdEndorse) &&
      !t.includes(BsdAdvertising),
  },
  {
    id: "BSD-3-Clause",
    test: (t) =>
      t.includes(BsdPreamble) &&
      t.includes(BsdSource) &&
      t.includes(BsdBinary) &&
      t.includes(BsdEndorse) &&
      !t.includes(BsdAdvertising),
  },
  {
    id: "BSD-4-Clause",
    test: (t) => t.includes(BsdPreamble) && t.includes(BsdAdvertising),
  },
];

// The SPDX ids a text is made of, sorted; empty when it matches nothing the rules know.
export function detectLicenses(text) {
  const normal = normalizeText(text);
  return Rules.filter((rule) => rule.test(normal))
    .map((rule) => rule.id)
    .sort();
}
