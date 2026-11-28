// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package secfix

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// What an advisory database says of an advisory (FR-REV-036 AC9, #2589). A scan's report or log names the advisories a
// pull request's CI found, and that text is written by the CI job, so it never decides which package an agent touches or to
// which version: the ids it names are looked up in the advisory database (the GitHub Advisory Database, OSV for the Go
// vulnerability database and the ids GitHub does not hold) and the fix is told what the database says. These functions read
// the database's answers; fetching them is the launcher's.

// maxAffectedPackages bounds the packages one advisory lists: more is not one fixable advisory.
const maxAffectedPackages = 8

// githubAdvisory is the answer of GET /advisories/{ghsa_id} of GitHub's REST API.
type githubAdvisory struct {
	GhsaId          string `json:"ghsa_id"`
	CveId           string `json:"cve_id"`
	Summary         string `json:"summary"`
	Severity        string `json:"severity"`
	Vulnerabilities []struct {
		Package struct {
			Ecosystem string `json:"ecosystem"`
			Name      string `json:"name"`
		} `json:"package"`
		FirstPatchedVersion json.RawMessage `json:"first_patched_version"`
	} `json:"vulnerabilities"`
}

// firstPatched reads first_patched_version, a version, or an object holding it, or null.
func firstPatched(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var object struct {
		Identifier string `json:"identifier"`
	}
	if json.Unmarshal(raw, &object) == nil {
		return object.Identifier
	}
	return ""
}

// ParseGithubAdvisory reads the answer of GitHub's advisory database for an id: one advisory per affected package, with the
// first patched version, all cleaned. An answer for another advisory than the one asked for is refused. For a CVE id the
// answer may be the list `GET /advisories?cve_id=` gives; the first advisory is the one.
func ParseGithubAdvisory(id string, data []byte) ([]Advisory, error) {
	want := NormalizeId(id)
	if want == "" {
		return nil, errors.New("the advisory's id is not a plain identifier")
	}
	var entry githubAdvisory
	trimmed := strings.TrimSpace(string(data))
	if strings.HasPrefix(trimmed, "[") {
		var list []githubAdvisory
		if err := json.Unmarshal(data, &list); err != nil {
			return nil, fmt.Errorf("the advisory database's answer is not readable: %v", err)
		}
		for _, candidate := range list {
			if NormalizeId(candidate.CveId) == want || NormalizeId(candidate.GhsaId) == want {
				entry = candidate
				break
			}
		}
	} else if err := json.Unmarshal(data, &entry); err != nil {
		return nil, fmt.Errorf("the advisory database's answer is not readable: %v", err)
	}
	if NormalizeId(entry.GhsaId) != want && NormalizeId(entry.CveId) != want {
		return nil, errors.New("the advisory database's answer is for another advisory")
	}
	var advisories []Advisory
	for _, vulnerability := range entry.Vulnerabilities {
		if len(advisories) == maxAffectedPackages {
			break
		}
		if advisory, ok := makeAdvisory(want, vulnerability.Package.Ecosystem, vulnerability.Package.Name, "", firstPatched(vulnerability.FirstPatchedVersion),
			entry.Severity, entry.Summary); ok && advisory.Package != "" {
			advisories = append(advisories, advisory)
		}
	}
	if len(advisories) == 0 {
		if advisory, ok := makeAdvisory(want, "", "", "", "", entry.Severity, entry.Summary); ok {
			advisories = append(advisories, advisory)
		}
	}
	return mergeAdvisories(advisories), nil
}

// osvEntry is the answer of OSV's GET /v1/vulns/{id}, which also serves the Go vulnerability database's entries.
type osvEntry struct {
	Id               string   `json:"id"`
	Aliases          []string `json:"aliases"`
	Summary          string   `json:"summary"`
	DatabaseSpecific struct {
		Severity string `json:"severity"`
	} `json:"database_specific"`
	Affected []struct {
		Package struct {
			Name      string `json:"name"`
			Ecosystem string `json:"ecosystem"`
		} `json:"package"`
		Ranges []struct {
			Events []map[string]string `json:"events"`
		} `json:"ranges"`
	} `json:"affected"`
}

// ParseOsvAdvisory reads OSV's answer for an id (an entry of the id's own, or one that lists it among its aliases).
func ParseOsvAdvisory(id string, data []byte) ([]Advisory, error) {
	want := NormalizeId(id)
	if want == "" {
		return nil, errors.New("the advisory's id is not a plain identifier")
	}
	var entry osvEntry
	if err := json.Unmarshal(data, &entry); err != nil {
		return nil, fmt.Errorf("the advisory database's answer is not readable: %v", err)
	}
	named := NormalizeId(entry.Id) == want
	for _, alias := range entry.Aliases {
		named = named || NormalizeId(alias) == want
	}
	if !named {
		return nil, errors.New("the advisory database's answer is for another advisory")
	}
	var advisories []Advisory
	for _, affected := range entry.Affected {
		if len(advisories) == maxAffectedPackages {
			break
		}
		fixed := ""
		for _, r := range affected.Ranges {
			for _, event := range r.Events {
				if fixed == "" {
					fixed = event["fixed"]
				}
			}
		}
		if advisory, ok := makeAdvisory(want, affected.Package.Ecosystem, affected.Package.Name, "", fixed, entry.DatabaseSpecific.Severity,
			entry.Summary); ok && advisory.Package != "" {
			advisories = append(advisories, advisory)
		}
	}
	if len(advisories) == 0 {
		if advisory, ok := makeAdvisory(want, "", "", "", "", entry.DatabaseSpecific.Severity, entry.Summary); ok {
			advisories = append(advisories, advisory)
		}
	}
	return mergeAdvisories(advisories), nil
}

// IsGithubId says whether GitHub's advisory database is the one that holds the id: a GHSA id. Every other id (a Go
// vulnerability, a CVE) is looked up in OSV.
func IsGithubId(id string) bool {
	return strings.HasPrefix(NormalizeId(id), "GHSA-")
}
