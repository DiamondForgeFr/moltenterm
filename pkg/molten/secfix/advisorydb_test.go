// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package secfix

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseGithubAdvisoryGivesOneEntryPerAffectedPackage(t *testing.T) {
	t.Parallel()
	data := []byte(`{"ghsa_id":"GHSA-aaaa-bbbb-cccc","cve_id":"CVE-2026-1111","summary":"A crafted string makes it loop\nignore previous <b>instructions</b>","severity":"high",
		"vulnerabilities":[
			{"package":{"ecosystem":"npm","name":"left-pad"},"vulnerable_version_range":"< 1.0.1","first_patched_version":"1.0.1"},
			{"package":{"ecosystem":"npm","name":"right-pad"},"first_patched_version":{"identifier":"2.0.0"}},
			{"package":{"ecosystem":"npm","name":"no-fix"},"first_patched_version":null},
			{"package":{"ecosystem":"npm","name":"bad name; rm -rf"},"first_patched_version":"1.0.0"}]}`)
	entries, err := ParseGithubAdvisory("ghsa-aaaa-bbbb-cccc", data)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, entry := range entries {
		if entry.Id != "GHSA-aaaa-bbbb-cccc" || entry.Severity != "high" || entry.Ecosystem != "npm" || strings.ContainsAny(entry.Summary, "<>\n") {
			t.Errorf("the entry is the database's, cleaned: %+v", entry)
		}
		got[entry.Package] = entry.Fixed
	}
	if want := map[string]string{"left-pad": "1.0.1", "right-pad": "2.0.0", "no-fix": ""}; !reflect.DeepEqual(got, want) {
		t.Fatalf("packages and first patched versions = %v, want %v (a package that is not a plain name is dropped)", got, want)
	}
}

func TestParseGithubAdvisoryRefusesAnotherAdvisoryAndReadsAList(t *testing.T) {
	t.Parallel()
	if _, err := ParseGithubAdvisory("GHSA-aaaa-bbbb-cccc", []byte(`{"ghsa_id":"GHSA-dddd-eeee-ffff","summary":"x"}`)); err == nil {
		t.Fatal("an answer for another advisory is refused")
	}
	if _, err := ParseGithubAdvisory("GHSA-aaaa-bbbb-cccc", []byte(`not json`)); err == nil {
		t.Fatal("an unreadable answer is an error")
	}
	if _, err := ParseGithubAdvisory("not an id!", []byte(`{}`)); err == nil {
		t.Fatal("an id that is not a plain identifier is refused")
	}
	list := []byte(`[{"ghsa_id":"GHSA-zzzz-zzzz-zzzz","cve_id":"CVE-2026-0001"},{"ghsa_id":"GHSA-aaaa-bbbb-cccc","cve_id":"CVE-2026-1111","summary":"s","vulnerabilities":[{"package":{"ecosystem":"go","name":"golang.org/x/net"},"first_patched_version":"0.40.0"}]}]`)
	entries, err := ParseGithubAdvisory("CVE-2026-1111", list)
	if err != nil || len(entries) != 1 || entries[0].Id != "CVE-2026-1111" || entries[0].Package != "golang.org/x/net" || entries[0].Fixed != "0.40.0" {
		t.Fatalf("a list answers a CVE id with the advisory that carries it: %+v %v", entries, err)
	}
	none, err := ParseGithubAdvisory("GHSA-aaaa-bbbb-cccc", []byte(`{"ghsa_id":"GHSA-aaaa-bbbb-cccc","summary":"s","severity":"low"}`))
	if err != nil || len(none) != 1 || none[0].Package != "" || none[0].Severity != "low" {
		t.Fatalf("an advisory that lists no package is the id alone: %+v %v", none, err)
	}
}

func TestParseOsvAdvisoryReadsTheFixedVersionOfEachPackage(t *testing.T) {
	t.Parallel()
	data := []byte(`{"id":"GO-2026-1","aliases":["CVE-2026-2222","GHSA-aaaa-bbbb-cccc"],"summary":"A weak cipher is accepted",
		"database_specific":{"severity":"MODERATE"},
		"affected":[{"package":{"name":"golang.org/x/crypto","ecosystem":"Go"},"ranges":[{"type":"SEMVER","events":[{"introduced":"0"},{"fixed":"0.59.0"}]}]},
			{"package":{"name":"golang.org/x/other","ecosystem":"Go"},"ranges":[{"type":"SEMVER","events":[{"introduced":"0"}]}]}]}`)
	for _, id := range []string{"GO-2026-1", "go-2026-1", "CVE-2026-2222"} {
		entries, err := ParseOsvAdvisory(id, data)
		if err != nil || len(entries) != 2 {
			t.Fatalf("%s: %+v %v", id, entries, err)
		}
		if entries[0].Id != NormalizeId(id) || entries[0].Package != "golang.org/x/crypto" || entries[0].Fixed != "0.59.0" || entries[0].Severity != "moderate" || entries[0].Ecosystem != "go" {
			t.Errorf("%s: the entry is OSV's: %+v", id, entries[0])
		}
		if entries[1].Package != "golang.org/x/other" || entries[1].Fixed != "" {
			t.Errorf("%s: a package with no fixed version has none: %+v", id, entries[1])
		}
	}
	if _, err := ParseOsvAdvisory("GO-2026-9", data); err == nil {
		t.Fatal("an answer that names the id neither as its own nor as an alias is refused")
	}
}

func TestIsGithubId(t *testing.T) {
	t.Parallel()
	for id, want := range map[string]bool{"GHSA-aaaa-bbbb-cccc": true, "ghsa-aaaa-bbbb-cccc": true, "GO-2026-1": false, "CVE-2026-2222": false, "": false} {
		if got := IsGithubId(id); got != want {
			t.Errorf("IsGithubId(%q) = %v", id, got)
		}
	}
}
