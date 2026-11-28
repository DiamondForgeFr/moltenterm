// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Package secfix recognises a pull request's dependency or security scan, reads the advisories it failed on and
// decides whether that failure is shared (FR-REV-036, #2511). It only reads: nothing here starts an agent, writes a
// ticket or touches the project, and it needs nothing but the project's own gh and CI, so it serves any project, with or
// without SaaSFoundry and with any coding agent.
package secfix

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"
	"unicode"
)

// The report formats a project may declare, and the ones MoltenTerm reads without a declaration.
const (
	FormatMoltenterm  = "moltenterm"
	FormatGovulncheck = "govulncheck"
	FormatNpmAudit    = "npm-audit"
	FormatOsv         = "osv"
)

// Where a scan was recognised from.
const (
	OriginDeclared  = "declared"
	OriginConfirmed = "confirmed"
)

// What an advisory list was read from.
const (
	SourceReport = "report"
	SourceLog    = "log"
	SourceNone   = "none"
)

// Why a block is shared.
const (
	ReasonTrunk              = "trunk"
	ReasonPrs                = "prs"
	ReasonNoDependencyChange = "nodependencychange"
)

// A report whose own verdict says the scanner could not run: there are no advisories to fix.
const StatusScannerInputFailure = "scanner-input-failure"

const (
	DefaultReportFile = "report.json"
	// maxFieldRunes bounds every free text a report or a log gives, once cleaned to one line.
	maxFieldRunes = 120
	maxIdLength   = 64
)

var Formats = []string{FormatMoltenterm, FormatGovulncheck, FormatNpmAudit, FormatOsv}

// Declaration is `ci.security` of `.molten/project.json`: the project says which checks are its dependency or security
// scan, so MoltenTerm never has to guess.
type Declaration struct {
	// The checks that are the scan, each as the check's name or "workflow / job" as a pull request shows it; `*` stands
	// for any text.
	Checks []string    `json:"checks"`
	Report *ReportSpec `json:"report,omitempty"`
	// Files, beside the usual manifests and lockfiles, whose change counts as a dependency change (the project's own
	// dependency policy): a path or a glob, matched against the whole path and the file name.
	DependencyFiles []string `json:"dependencyfiles,omitempty"`
}

// ReportSpec says where the scan leaves its report: the CI artifact of the failed run and the file inside it.
type ReportSpec struct {
	// The artifact's name, or a glob of it (`dependency-security-*`) when its name holds the run number.
	Artifact string `json:"artifact"`
	// The file inside the artifact, relative; report.json when left out.
	File string `json:"file,omitempty"`
	// The format of the file; found from its content when left out.
	Format string `json:"format,omitempty"`
}

// Problems lists what is wrong in a declaration, one sentence each; empty when it can be used.
func (d *Declaration) Problems() []string {
	if d == nil {
		return nil
	}
	var problems []string
	if len(d.Checks) == 0 {
		problems = append(problems, "checks must name at least one check")
	}
	for i, check := range d.Checks {
		if strings.TrimSpace(check) == "" {
			problems = append(problems, fmt.Sprintf("checks[%d] is empty", i))
		}
	}
	for i, glob := range d.DependencyFiles {
		if strings.TrimSpace(glob) == "" {
			problems = append(problems, fmt.Sprintf("dependencyfiles[%d] is empty", i))
		} else if _, err := path.Match(glob, "x"); err != nil {
			problems = append(problems, fmt.Sprintf("dependencyfiles[%d] is not a valid glob: %v", i, err))
		}
	}
	if d.Report != nil {
		problems = append(problems, d.Report.problems()...)
	}
	return problems
}

func (r *ReportSpec) problems() []string {
	var problems []string
	artifact := strings.TrimSpace(r.Artifact)
	switch {
	case artifact == "":
		problems = append(problems, "report.artifact is required")
	case strings.HasPrefix(artifact, "-") || strings.ContainsAny(artifact, "\r\n\x00"):
		problems = append(problems, "report.artifact must be an artifact name or a glob of one")
	default:
		if _, err := path.Match(artifact, "x"); err != nil {
			problems = append(problems, fmt.Sprintf("report.artifact is not a valid glob: %v", err))
		}
	}
	if file := r.File; file != "" {
		if path.IsAbs(file) || strings.Contains(file, "\\") || strings.Contains(file, "\x00") || escapesFolder(file) {
			problems = append(problems, "report.file must be a relative path inside the artifact")
		}
	}
	if r.Format != "" {
		known := false
		for _, format := range Formats {
			known = known || format == r.Format
		}
		if !known {
			problems = append(problems, fmt.Sprintf("report.format must be one of %s (got %q)", strings.Join(Formats, ", "), r.Format))
		}
	}
	return problems
}

func escapesFolder(file string) bool {
	for _, part := range strings.Split(file, "/") {
		if part == ".." {
			return true
		}
	}
	return false
}

// ReportFile is the file the declaration reads inside the artifact.
func (r *ReportSpec) ReportFile() string {
	if r == nil || r.File == "" {
		return DefaultReportFile
	}
	return path.Clean(r.File)
}

// Advisory is one vulnerability a scan reported. Every text is cleaned to one short line, and an id that is not a plain
// identifier is dropped: a report is data written by a CI job, never instructions.
type Advisory struct {
	Id        string `json:"id"`
	Ecosystem string `json:"ecosystem,omitempty"`
	Package   string `json:"package,omitempty"`
	Version   string `json:"version,omitempty"`
	Fixed     string `json:"fixed,omitempty"`
	Severity  string `json:"severity,omitempty"`
	Summary   string `json:"summary,omitempty"`
}

var (
	idRe       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]*$`)
	packageRe  = regexp.MustCompile(`^[A-Za-z0-9@][A-Za-z0-9@._/+~:-]*$`)
	versionRe  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.+~_-]*$`)
	severities = map[string]string{"critical": "critical", "high": "high", "moderate": "moderate", "medium": "moderate",
		"low": "low", "info": "info", "informational": "info", "unknown": "unknown"}
)

// NormalizeId gives an advisory id its one spelling: GO and CVE ids upper case, GHSA ids with a lower case body.
func NormalizeId(id string) string {
	id = strings.TrimSpace(id)
	if len(id) > maxIdLength || !idRe.MatchString(id) {
		return ""
	}
	upper := strings.ToUpper(id)
	if strings.HasPrefix(upper, "GHSA-") {
		return "GHSA-" + strings.ToLower(id[len("GHSA-"):])
	}
	return upper
}

// Fingerprint is the key of a set of advisories: the same ids in any order give the same one.
func Fingerprint(ids []string) string {
	set := map[string]bool{}
	for _, id := range ids {
		if normalized := NormalizeId(id); normalized != "" {
			set[normalized] = true
		}
	}
	if len(set) == 0 {
		return ""
	}
	sorted := make([]string, 0, len(set))
	for id := range set {
		sorted = append(sorted, id)
	}
	sort.Strings(sorted)
	sum := sha256.Sum256([]byte(strings.Join(sorted, "\n")))
	return hex.EncodeToString(sum[:])[:16]
}

// Ids are the distinct normalized ids of the advisories, sorted.
func Ids(advisories []Advisory) []string {
	set := map[string]bool{}
	for _, advisory := range advisories {
		if id := NormalizeId(advisory.Id); id != "" {
			set[id] = true
		}
	}
	ids := make([]string, 0, len(set))
	for id := range set {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// CleanLine keeps a text from a report or a log on one short line: control characters, markup and backticks go, since
// the text may end up in a ticket or in an agent's prompt.
func CleanLine(text string, limit int) string {
	if limit <= 0 {
		limit = maxFieldRunes
	}
	var b strings.Builder
	space := false
	for _, r := range text {
		switch {
		case unicode.IsControl(r) || unicode.IsSpace(r):
			space = b.Len() > 0
		case r == '`' || r == '<' || r == '>':
		default:
			if space {
				b.WriteByte(' ')
				space = false
			}
			b.WriteRune(r)
		}
	}
	runes := []rune(b.String())
	if len(runes) > limit {
		return strings.TrimSpace(string(runes[:limit])) + "…"
	}
	return string(runes)
}

func cleanPackage(text string) string {
	text = strings.TrimSpace(text)
	if len(text) > 128 || !packageRe.MatchString(text) {
		return ""
	}
	return text
}

func cleanVersion(text string) string {
	text = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(text), "v"))
	if len(text) > 64 || !versionRe.MatchString(text) {
		return ""
	}
	return text
}

func cleanSeverity(text string) string {
	return severities[strings.ToLower(strings.TrimSpace(text))]
}

func cleanEcosystem(text string) string {
	text = strings.ToLower(strings.TrimSpace(text))
	if len(text) > 32 || !idRe.MatchString(text) {
		return ""
	}
	return text
}

// makeAdvisory cleans one advisory; false when its id is not a plain identifier.
func makeAdvisory(id string, ecosystem string, pkg string, version string, fixed string, severity string, summary string) (Advisory, bool) {
	normalized := NormalizeId(id)
	if normalized == "" {
		return Advisory{}, false
	}
	return Advisory{Id: normalized, Ecosystem: cleanEcosystem(ecosystem), Package: cleanPackage(pkg), Version: cleanVersion(version),
		Fixed: cleanVersion(fixed), Severity: cleanSeverity(severity), Summary: CleanLine(summary, maxFieldRunes)}, true
}

// mergeAdvisories keeps one advisory per id and package, completed with what each list knows, sorted by id then package.
func mergeAdvisories(lists ...[]Advisory) []Advisory {
	type key struct{ id, pkg string }
	byKey := map[key]Advisory{}
	for _, list := range lists {
		for _, advisory := range list {
			k := key{advisory.Id, advisory.Package}
			if prev, ok := byKey[k]; ok {
				advisory = fill(prev, advisory)
			}
			byKey[k] = advisory
		}
	}
	named := map[string]bool{}
	for k := range byKey {
		if k.pkg != "" {
			named[k.id] = true
		}
	}
	merged := make([]Advisory, 0, len(byKey))
	for k, advisory := range byKey {
		// A log names an advisory without its package: the report's entry for the same id says more.
		if k.pkg == "" && named[k.id] {
			continue
		}
		merged = append(merged, advisory)
	}
	sort.Slice(merged, func(i, j int) bool {
		if merged[i].Id != merged[j].Id {
			return merged[i].Id < merged[j].Id
		}
		return merged[i].Package < merged[j].Package
	})
	return merged
}

// fill completes a with what b knows and a does not.
func fill(a Advisory, b Advisory) Advisory {
	set := func(dst *string, src string) {
		if *dst == "" {
			*dst = src
		}
	}
	set(&a.Ecosystem, b.Ecosystem)
	set(&a.Version, b.Version)
	set(&a.Fixed, b.Fixed)
	set(&a.Severity, b.Severity)
	set(&a.Summary, b.Summary)
	return a
}
