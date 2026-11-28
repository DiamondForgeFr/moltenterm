// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package secfix

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// What a scan's report or log says (FR-REV-036 AC4): the report in the formats the usual scanners write, and the failed
// job's log when no report can be read.

// maxLogScan bounds how much of a failed log is read for advisory ids.
const maxLogScan = 8 << 20

// maxLogIds bounds the ids one log gives: a log that names thousands is not naming one fixable set.
const maxLogIds = 200

// Reading is what one failed check's report or log says.
type Reading struct {
	// Where the advisories come from: the report, the failed log, or neither (Note says why).
	Source string `json:"source"`
	Format string `json:"format,omitempty"`
	// The verdict the report states itself, when it states one ("blocked-policy", "scanner-input-failure").
	Status     string     `json:"status,omitempty"`
	Advisories []Advisory `json:"advisories"`
	// Why no advisory was read, as a code (the Cause constants) the window words.
	Cause string `json:"cause,omitempty"`
	// Why a better source was not used, in one short English line, for the log and the tests: never on the wire.
	Note string `json:"-"`
}

// Why a failed scan's advisories could not be read.
const (
	CauseScannerInputFailure = StatusScannerInputFailure
	CauseReportUnreadable    = "report-unreadable"
	CauseLogUnreadable       = "log-unreadable"
	CauseNoAdvisory          = "no-advisory"
	CauseNoJob               = "no-job"
)

var logIdRe = regexp.MustCompile(`(?i)\b(?:GO-\d{4}-\d{3,}|GHSA(?:-[0-9a-z]{4}){3}|CVE-\d{4}-\d{4,})\b`)

// ParseLog finds the advisory ids a failed log names, once each. It reads ids only: nothing else of an untrusted log is
// kept.
func ParseLog(text string) []Advisory {
	if len(text) > maxLogScan {
		text = text[:maxLogScan]
	}
	seen := map[string]bool{}
	var advisories []Advisory
	for _, match := range logIdRe.FindAllString(text, -1) {
		id := NormalizeId(match)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		advisories = append(advisories, Advisory{Id: id})
		if len(advisories) == maxLogIds {
			break
		}
	}
	sort.Slice(advisories, func(i, j int) bool { return advisories[i].Id < advisories[j].Id })
	return advisories
}

// DetectFormat finds a report's format from its content; empty when it is none that MoltenTerm reads.
func DetectFormat(data []byte) string {
	decoder := json.NewDecoder(bytes.NewReader(data))
	var first map[string]json.RawMessage
	if err := decoder.Decode(&first); err != nil {
		return ""
	}
	has := func(keys ...string) bool {
		for _, key := range keys {
			if _, ok := first[key]; ok {
				return true
			}
		}
		return false
	}
	switch {
	case has("schema") && has("findings"):
		return FormatMoltenterm
	case has("auditReportVersion") || (has("vulnerabilities") && has("metadata")) || (has("advisories") && has("metadata")):
		return FormatNpmAudit
	case has("results"):
		return FormatOsv
	case has("config", "osv", "finding", "progress", "sbom"):
		return FormatGovulncheck
	}
	return ""
}

// ParseReport reads a scan's report in the format it is declared in, or finds the format from its content.
func ParseReport(format string, data []byte) (Reading, error) {
	data = bytes.TrimSpace(data)
	if len(data) == 0 {
		return Reading{}, errors.New("the report is empty")
	}
	if format == "" {
		format = DetectFormat(data)
	}
	var reading Reading
	var err error
	switch format {
	case FormatMoltenterm:
		reading, err = parseMoltenterm(data)
	case FormatGovulncheck:
		reading, err = parseGovulncheck(data)
	case FormatNpmAudit:
		reading, err = parseNpmAudit(data)
	case FormatOsv:
		reading, err = parseOsv(data)
	case "":
		return Reading{}, errors.New("the report's format is not one MoltenTerm reads (" + strings.Join(Formats, ", ") + ")")
	default:
		return Reading{}, fmt.Errorf("the report's format %q is not one MoltenTerm reads", CleanLine(format, 32))
	}
	if err != nil {
		return Reading{}, err
	}
	reading.Source, reading.Format = SourceReport, format
	reading.Advisories = mergeAdvisories(reading.Advisories)
	return reading, nil
}

type moltentermReport struct {
	Schema   int    `json:"schema"`
	Status   string `json:"status"`
	Findings []struct {
		Ecosystem    string `json:"ecosystem"`
		Id           string `json:"id"`
		Package      string `json:"package"`
		Version      string `json:"version"`
		FixedVersion string `json:"fixedVersion"`
		Severity     string `json:"severity"`
		Title        string `json:"title"`
		Verdict      string `json:"verdict"`
	} `json:"findings"`
}

func parseMoltenterm(data []byte) (Reading, error) {
	var report moltentermReport
	if err := json.Unmarshal(data, &report); err != nil {
		return Reading{}, fmt.Errorf("the report is not MoltenTerm's own format: %v", err)
	}
	reading := Reading{Status: CleanLine(report.Status, 40)}
	all, blocked := []Advisory{}, []Advisory{}
	for _, finding := range report.Findings {
		advisory, ok := makeAdvisory(finding.Id, finding.Ecosystem, finding.Package, finding.Version, finding.FixedVersion, finding.Severity, finding.Title)
		if !ok {
			continue
		}
		all = append(all, advisory)
		if finding.Verdict == "blocked" {
			blocked = append(blocked, advisory)
		}
	}
	// The policy blocks on its own verdicts: the findings it only reports are not what failed the check.
	reading.Advisories = blocked
	if len(blocked) == 0 && report.Status == "blocked-policy" {
		reading.Advisories = all
	}
	return reading, nil
}

type govulnMessage struct {
	Osv *struct {
		Id               string `json:"id"`
		Summary          string `json:"summary"`
		DatabaseSpecific struct {
			Severity string `json:"severity"`
		} `json:"database_specific"`
	} `json:"osv"`
	Finding *struct {
		Osv          string `json:"osv"`
		FixedVersion string `json:"fixed_version"`
		Trace        []struct {
			Module   string `json:"module"`
			Version  string `json:"version"`
			Function string `json:"function"`
		} `json:"trace"`
	} `json:"finding"`
}

func parseGovulncheck(data []byte) (Reading, error) {
	type osvInfo struct{ summary, severity string }
	infos := map[string]osvInfo{}
	var called, imported []Advisory
	decoder := json.NewDecoder(bytes.NewReader(data))
	messages := 0
	for {
		var message govulnMessage
		err := decoder.Decode(&message)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			if messages == 0 {
				return Reading{}, fmt.Errorf("the report is not govulncheck's JSON: %v", err)
			}
			break
		}
		messages++
		if message.Osv != nil {
			infos[NormalizeId(message.Osv.Id)] = osvInfo{message.Osv.Summary, message.Osv.DatabaseSpecific.Severity}
		}
		if message.Finding == nil || len(message.Finding.Trace) == 0 {
			continue
		}
		frame := message.Finding.Trace[0]
		advisory, ok := makeAdvisory(message.Finding.Osv, "go", frame.Module, frame.Version, message.Finding.FixedVersion, "", "")
		if !ok {
			continue
		}
		// govulncheck fails the build on the vulnerabilities the code calls: a finding with a function is one.
		if frame.Function != "" {
			called = append(called, advisory)
		} else {
			imported = append(imported, advisory)
		}
	}
	if messages == 0 {
		return Reading{}, errors.New("the report holds no govulncheck message")
	}
	chosen := called
	if len(chosen) == 0 {
		chosen = imported
	}
	for i := range chosen {
		if info, ok := infos[chosen[i].Id]; ok {
			chosen[i].Summary = CleanLine(info.summary, maxFieldRunes)
			chosen[i].Severity = cleanSeverity(info.severity)
		}
	}
	return Reading{Advisories: chosen}, nil
}

type npmAuditReport struct {
	Vulnerabilities map[string]struct {
		Name         string            `json:"name"`
		Severity     string            `json:"severity"`
		Via          []json.RawMessage `json:"via"`
		FixAvailable json.RawMessage   `json:"fixAvailable"`
	} `json:"vulnerabilities"`
	Advisories map[string]struct {
		Id              int      `json:"id"`
		Url             string   `json:"url"`
		ModuleName      string   `json:"module_name"`
		Severity        string   `json:"severity"`
		Title           string   `json:"title"`
		PatchedVersions string   `json:"patched_versions"`
		Cves            []string `json:"cves"`
	} `json:"advisories"`
}

var ghsaInUrlRe = regexp.MustCompile(`(?i)GHSA(?:-[0-9a-z]{4}){3}`)

func parseNpmAudit(data []byte) (Reading, error) {
	var report npmAuditReport
	if err := json.Unmarshal(data, &report); err != nil {
		return Reading{}, fmt.Errorf("the report is not npm audit's JSON: %v", err)
	}
	var advisories []Advisory
	for key, vulnerability := range report.Vulnerabilities {
		fixed := npmFixedVersion(vulnerability.FixAvailable)
		for _, raw := range vulnerability.Via {
			var via struct {
				Source   json.Number `json:"source"`
				Name     string      `json:"name"`
				Title    string      `json:"title"`
				Url      string      `json:"url"`
				Severity string      `json:"severity"`
			}
			// A string in via names the package the vulnerability comes through: the advisory is on that package.
			if json.Unmarshal(raw, &via) != nil {
				continue
			}
			id := ghsaInUrlRe.FindString(via.Url)
			if id == "" && via.Source != "" {
				id = "NPM-" + via.Source.String()
			}
			name := via.Name
			if name == "" {
				name = vulnerability.Name
			}
			if name == "" {
				name = key
			}
			severity := via.Severity
			if severity == "" {
				severity = vulnerability.Severity
			}
			if advisory, ok := makeAdvisory(id, "npm", name, "", fixed, severity, via.Title); ok {
				advisories = append(advisories, advisory)
			}
		}
	}
	for key, advisory := range report.Advisories {
		id := ghsaInUrlRe.FindString(advisory.Url)
		if id == "" {
			id = "NPM-" + strconv.Itoa(advisory.Id)
		}
		if id == "NPM-0" {
			id = "NPM-" + key
		}
		if made, ok := makeAdvisory(id, "npm", advisory.ModuleName, "", advisory.PatchedVersions, advisory.Severity, advisory.Title); ok {
			advisories = append(advisories, made)
		}
	}
	return Reading{Advisories: advisories}, nil
}

// npmFixedVersion reads fixAvailable: true or false says nothing of a version, an object names the one to move to.
func npmFixedVersion(raw json.RawMessage) string {
	var fix struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(raw, &fix) != nil {
		return ""
	}
	return fix.Version
}

type osvVulnerability struct {
	Id               string `json:"id"`
	Summary          string `json:"summary"`
	DatabaseSpecific struct {
		Severity string `json:"severity"`
	} `json:"database_specific"`
	Affected []struct {
		Package struct {
			Name string `json:"name"`
		} `json:"package"`
		Ranges []struct {
			Events []map[string]string `json:"events"`
		} `json:"ranges"`
	} `json:"affected"`
}

func parseOsv(data []byte) (Reading, error) {
	var report struct {
		Results []struct {
			Packages []struct {
				Package struct {
					Name      string `json:"name"`
					Version   string `json:"version"`
					Ecosystem string `json:"ecosystem"`
				} `json:"package"`
				Vulnerabilities []osvVulnerability `json:"vulnerabilities"`
			} `json:"packages"`
		} `json:"results"`
	}
	if err := json.Unmarshal(data, &report); err != nil {
		return Reading{}, fmt.Errorf("the report is not OSV-Scanner's JSON: %v", err)
	}
	var advisories []Advisory
	for _, result := range report.Results {
		for _, pkg := range result.Packages {
			for _, vulnerability := range pkg.Vulnerabilities {
				fixed := osvFixedVersion(vulnerability, pkg.Package.Name)
				if advisory, ok := makeAdvisory(vulnerability.Id, pkg.Package.Ecosystem, pkg.Package.Name, pkg.Package.Version, fixed, vulnerability.DatabaseSpecific.Severity, vulnerability.Summary); ok {
					advisories = append(advisories, advisory)
				}
			}
		}
	}
	return Reading{Advisories: advisories}, nil
}

func osvFixedVersion(vulnerability osvVulnerability, pkg string) string {
	for _, affected := range vulnerability.Affected {
		if affected.Package.Name != pkg {
			continue
		}
		for _, r := range affected.Ranges {
			for _, event := range r.Events {
				if fixed := event["fixed"]; fixed != "" {
					return fixed
				}
			}
		}
	}
	return ""
}
