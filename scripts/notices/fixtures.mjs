// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Licence texts and a small repository for the tests of scripts/notices (#2126).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MitText = `MIT License

Copyright (c) 2020 Example Authors

Permission is hereby granted, free of charge, to any person obtaining a copy
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

export const IscText = `ISC License

Copyright (c) 2019, Example

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS.`;

export const ZeroBsdText = `Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES.`;

const BsdBody = `Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

   * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
   * Redistributions in binary form must reproduce the above copyright
notice, this list of conditions and the following disclaimer in the
documentation and/or other materials provided with the distribution.`;

export const Bsd2Text = `Copyright (c) 2013 Example. All rights reserved.

${BsdBody}

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS".`;

export const Bsd3Text = `Copyright (c) 2013 The Example Authors. All rights reserved.

${BsdBody}
   * Neither the name of Example nor the names of its contributors may be used
to endorse or promote products derived from this software without specific
prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS".`;

export const Bsd4Text = `${BsdBody}
   * All advertising materials mentioning features or use of this software
must display the following acknowledgement.`;

export const ApacheText = `                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.`;

export const Mpl2Text = `Mozilla Public License Version 2.0
==================================

1. Definitions`;

export const GplText = `GNU GENERAL PUBLIC LICENSE
Version 3, 29 June 2007`;

export function tempRoot(prefix = "mt-notices-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

export const PolicyJson = {
  allowed: ["MIT", "ISC", "BSD-3-Clause", "Apache-2.0"],
  exceptions: [],
};

// A repository the way the build leaves it: package.json, a policy, the graph manifests and the packages they name.
// `packages` is { dir: { name, version, license, files: { name: text } } }, each listed for the targets of `graph`.
export function makeRepository(
  root,
  { packages, graph = { main: [], preload: [], renderer: [] }, policy = PolicyJson }
) {
  write(root, "package.json", JSON.stringify({ name: "demo", productName: "Demo", version: "1.2.3" }));
  write(root, "build/moltenterm/license-policy.json", JSON.stringify(policy));
  write(root, "build/moltenterm/notices/assets.json", JSON.stringify({ components: [] }));
  for (const [dir, pkg] of Object.entries(packages)) {
    const meta = { name: pkg.name, version: pkg.version };
    if (pkg.license !== undefined) {
      meta.license = pkg.license;
    }
    if (pkg.author !== undefined) {
      meta.author = pkg.author;
    }
    write(root, `${dir}/package.json`, JSON.stringify(meta));
    for (const [name, text] of Object.entries(pkg.files ?? {})) {
      write(root, `${dir}/${name}`, text);
    }
  }
  for (const [target, dirs] of Object.entries(graph)) {
    const listed = dirs.map((dir) => ({ name: packages[dir].name, dir }));
    write(root, `dist/licenses/graph/${target}.json`, JSON.stringify({ target, packages: listed }));
  }
}
