// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// THIRD-PARTY-NOTICES.txt (#2126). Deterministic: the components are sorted, a licence text that several share is written
// once, and nothing in it depends on the date or the machine, so the same inputs give the same bytes.

const Rule = "=".repeat(78);
const Thin = "-".repeat(78);

const EcosystemTitles = [
  ["npm", "npm packages bundled into the application"],
  ["go", "Go modules and the Go standard library compiled into its programs"],
  ["asset", "fonts, icons and files copied into the application"],
];

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function componentKey(component) {
  return `${component.name.toLowerCase()}\t${component.version}\t${component.name}`;
}

export function sortComponents(entries) {
  return [...entries].sort((a, b) => compare(componentKey(a.component), componentKey(b.component)));
}

function label(component) {
  return component.version === "" ? component.name : `${component.name} ${component.version}`;
}

// The distinct texts, numbered, each with the components that carry it:
// [{ number, text, files: [names], components: [entry] }].
export function groupTexts(entries) {
  const byText = new Map();
  for (const entry of sortComponents(entries)) {
    for (const file of entry.component.files) {
      const group = byText.get(file.text) ?? { text: file.text, components: [], names: new Set() };
      if (!group.components.includes(entry)) {
        group.components.push(entry);
      }
      group.names.add(file.file.split("/").pop());
      byText.set(file.text, group);
    }
  }
  const groups = [...byText.values()].sort(
    (a, b) =>
      compare(componentKey(a.components[0].component), componentKey(b.components[0].component)) ||
      compare(a.text, b.text)
  );
  groups.forEach((group, i) => {
    group.number = i + 1;
  });
  return groups;
}

function licenseOf(entry) {
  return entry.verdict.expression ?? "unknown";
}

export function renderNotices({ product, version, entries }) {
  const groups = groupTexts(entries);
  const numbersOf = new Map();
  for (const group of groups) {
    for (const entry of group.components) {
      numbersOf.set(entry, [...(numbersOf.get(entry) ?? []), group.number]);
    }
  }
  const lines = [];
  lines.push(`${product} ${version} - third-party notices`, Rule, "");
  lines.push(
    `${product} contains the open-source software listed below. Each component is used under the licence named`,
    "for it; the licence texts, with the copyright notices they carry, follow the list.",
    "",
    `${product}'s own licences are in LICENSE, LICENSE-APACHE, LICENSE-EXCEPTION and NOTICE. Electron's licence`,
    "(LICENSE.electron.txt) and the licences of Chromium and of what it contains (LICENSES.chromium.html) are",
    "installed with the application, in its resources folder or next to its executable.",
    ""
  );
  const counts = EcosystemTitles.map(
    ([ecosystem, title]) => `${entries.filter((e) => e.component.ecosystem === ecosystem).length} ${title}`
  );
  lines.push(`${entries.length} components: ${counts.join("; ")}.`, "", Rule, "COMPONENTS", Rule, "");
  for (const [ecosystem, title] of EcosystemTitles) {
    const inGroup = sortComponents(entries.filter((e) => e.component.ecosystem === ecosystem));
    if (inGroup.length === 0) {
      continue;
    }
    lines.push(title.toUpperCase(), Thin);
    for (const entry of inGroup) {
      const c = entry.component;
      const texts = numbersOf.get(entry);
      const where = c.targets.length > 0 ? ` [${c.targets.join(", ")}]` : "";
      lines.push(`${label(c)} - ${licenseOf(entry)}${where}`);
      if (c.url) {
        lines.push(`    ${c.url}`);
      }
      if (entry.verdict.exception?.note) {
        lines.push(`    ${entry.verdict.exception.note}`);
      }
      lines.push(
        texts != null
          ? `    licence text${texts.length > 1 ? "s" : ""}: ${texts.map((n) => `#${n}`).join(", ")}`
          : "    no licence text is part of this component's package"
      );
    }
    lines.push("");
  }
  lines.push(Rule, "LICENCE TEXTS", Rule, "");
  for (const group of groups) {
    const names = group.components.map((entry) => label(entry.component));
    lines.push(`#${group.number}  ${[...group.names].sort().join(", ")}`, Thin, "Applies to:");
    for (const name of names) {
      lines.push(`  ${name}`);
    }
    lines.push(Thin, group.text, "", "");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}
