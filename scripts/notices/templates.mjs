// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The standard text of the short licences (SPDX licence list), for a package that declares one and ships no licence file
// (#2126). The notice of such a package is the licence's standard text with the author its package.json names, and says
// where each part comes from. Licences longer than a page (Apache-2.0, MPL-2.0) have no template: a package under them
// ships its text, and one that does not is left to a reviewer.

const MitBody = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const IscBody = `Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`;

const BsdPreamble = `Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.`;

const BsdEndorse = `3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.`;

const BsdDisclaimer = `THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

// id -> (holder) => text. The text opens with the licence's name and the copyright line.
export const Templates = {
  MIT: (holder) => `MIT License\n\nCopyright (c) ${holder}\n\n${MitBody}`,
  ISC: (holder) => `ISC License\n\nCopyright (c) ${holder}\n\n${IscBody}`,
  "BSD-2-Clause": (holder) => `BSD 2-Clause License\n\nCopyright (c) ${holder}\n\n${BsdPreamble}\n\n${BsdDisclaimer}`,
  "BSD-3-Clause": (holder) =>
    `BSD 3-Clause License\n\nCopyright (c) ${holder}\n\n${BsdPreamble}\n\n${BsdEndorse}\n\n${BsdDisclaimer}`,
};

// The name in a package.json "author": a string ("Name <mail> (url)") or an object ({ name }); null when there is none.
export function authorName(author) {
  const raw = typeof author === "string" ? author : author?.name;
  if (typeof raw !== "string") {
    return null;
  }
  const name = raw
    .replace(/<[^>]*>/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return name === "" ? null : name;
}

// The notice of a package that ships no licence file but declares `id`, or null when there is no template for it.
export function standardNotice(component, id) {
  const template = Templates[id];
  if (template == null) {
    return null;
  }
  const holder = component.author ?? `the authors of ${component.name}`;
  const source = component.author
    ? `its package.json names ${component.author} as its author`
    : "its package.json names no author";
  const note =
    `${component.name} ships no licence file. It declares the ${id} licence and ${source}; this is the standard text ` +
    `of that licence${component.author ? " with that name" : ""}.`;
  return { file: "(standard text)", text: `${note}\n\n${template(holder)}` };
}
