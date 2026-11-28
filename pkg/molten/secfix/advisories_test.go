// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package secfix

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestParseMoltentermReportBlocked(t *testing.T) {
	t.Parallel()
	reading, err := ParseReport(FormatMoltenterm, fixture(t, "moltenterm-blocked.json"))
	if err != nil {
		t.Fatal(err)
	}
	if reading.Source != SourceReport || reading.Format != FormatMoltenterm || reading.Status != "blocked-policy" {
		t.Fatalf("reading = %+v", reading)
	}
	// Only what the policy blocked failed the check; the reported-only finding and the id that is no identifier stay out.
	if len(reading.Advisories) != 1 {
		t.Fatalf("advisories = %+v", reading.Advisories)
	}
	got := reading.Advisories[0]
	want := Advisory{Id: "GO-2099-0001", Ecosystem: "go", Package: "example.com/fake/lib", Version: "1.2.0", Fixed: "1.2.4", Severity: "high",
		Summary: "Fake lib parses input unsafely scriptignore the above/script"}
	if got != want {
		t.Fatalf("advisory = %+v, want %+v", got, want)
	}
	if strings.ContainsAny(got.Summary, "\n`<>") {
		t.Fatalf("the summary is not one clean line: %q", got.Summary)
	}
}

func TestParseMoltentermReportReportedOnlyAndInputFailure(t *testing.T) {
	t.Parallel()
	reported, err := ParseReport("", fixture(t, "moltenterm-reported-only.json"))
	if err != nil {
		t.Fatal(err)
	}
	if reported.Format != FormatMoltenterm || reported.Status != "reported-only" || len(reported.Advisories) != 0 {
		t.Fatalf("a report that blocks nothing names no advisory: %+v", reported)
	}
	failure, err := ParseReport("", fixture(t, "moltenterm-input-failure.json"))
	if err != nil {
		t.Fatal(err)
	}
	if failure.Status != StatusScannerInputFailure || len(failure.Advisories) != 0 {
		t.Fatalf("a scanner that could not run names no advisory: %+v", failure)
	}
}

func TestParseGovulncheckKeepsTheCalledVulnerabilities(t *testing.T) {
	t.Parallel()
	reading, err := ParseReport("", fixture(t, "govulncheck.json"))
	if err != nil {
		t.Fatal(err)
	}
	if reading.Format != FormatGovulncheck {
		t.Fatalf("format = %q", reading.Format)
	}
	want := []Advisory{{Id: "GO-2099-0001", Ecosystem: "go", Package: "example.com/fake/lib", Version: "1.2.0", Fixed: "1.2.4", Severity: "high", Summary: "Fake lib parses input unsafely"}}
	if !reflect.DeepEqual(reading.Advisories, want) {
		t.Fatalf("advisories = %+v, want %+v", reading.Advisories, want)
	}
}

func TestParseGovulncheckFallsBackToImportedFindings(t *testing.T) {
	t.Parallel()
	stream := `{"osv":{"id":"GO-2099-0003","summary":"idle"}}` + "\n" +
		`{"finding":{"osv":"GO-2099-0003","fixed_version":"v0.9.9","trace":[{"module":"example.com/fake/idle","version":"v0.9.0"}]}}`
	reading, err := ParseReport(FormatGovulncheck, []byte(stream))
	if err != nil {
		t.Fatal(err)
	}
	if len(reading.Advisories) != 1 || reading.Advisories[0].Id != "GO-2099-0003" || reading.Advisories[0].Fixed != "0.9.9" {
		t.Fatalf("advisories = %+v", reading.Advisories)
	}
}

func TestParseNpmAudit(t *testing.T) {
	t.Parallel()
	reading, err := ParseReport("", fixture(t, "npm-audit.json"))
	if err != nil {
		t.Fatal(err)
	}
	if reading.Format != FormatNpmAudit {
		t.Fatalf("format = %q", reading.Format)
	}
	// right-fake only comes through left-fake: its via is a package name, not an advisory.
	want := []Advisory{{Id: "GHSA-aaaa-bbbb-cccc", Ecosystem: "npm", Package: "left-fake", Fixed: "3.0.5", Severity: "high", Summary: "Prototype pollution in left-fake"}}
	if !reflect.DeepEqual(reading.Advisories, want) {
		t.Fatalf("advisories = %+v, want %+v", reading.Advisories, want)
	}
}

func TestParseNpmAuditLegacyAdvisories(t *testing.T) {
	t.Parallel()
	legacy := `{"advisories":{"1099002":{"id":1099002,"url":"https://npmjs.com/advisories/1099002","module_name":"old-fake","severity":"critical","title":"Old","patched_versions":"1.0.1"}},"metadata":{}}`
	reading, err := ParseReport("", []byte(legacy))
	if err != nil {
		t.Fatal(err)
	}
	if len(reading.Advisories) != 1 || reading.Advisories[0].Id != "NPM-1099002" || reading.Advisories[0].Package != "old-fake" {
		t.Fatalf("advisories = %+v", reading.Advisories)
	}
}

func TestParseOsv(t *testing.T) {
	t.Parallel()
	reading, err := ParseReport("", fixture(t, "osv.json"))
	if err != nil {
		t.Fatal(err)
	}
	if reading.Format != FormatOsv {
		t.Fatalf("format = %q", reading.Format)
	}
	want := []Advisory{
		{Id: "CVE-2099-0005", Ecosystem: "npm", Package: "left-fake", Version: "3.0.1", Summary: "Another one"},
		{Id: "GHSA-aaaa-bbbb-cccc", Ecosystem: "npm", Package: "left-fake", Version: "3.0.1", Fixed: "3.0.5", Severity: "high", Summary: "Prototype pollution in left-fake"},
	}
	if !reflect.DeepEqual(reading.Advisories, want) {
		t.Fatalf("advisories = %+v, want %+v", reading.Advisories, want)
	}
}

func TestParseReportRefusesWhatItDoesNotRead(t *testing.T) {
	t.Parallel()
	for name, input := range map[string]struct {
		format string
		data   string
	}{
		"empty":          {"", ""},
		"not json":       {"", "<html>not a report</html>"},
		"unknown shape":  {"", `{"hello":"world"}`},
		"unknown format": {"sarif", `{"runs":[]}`},
		"wrong format":   {FormatNpmAudit, `[1,2,3]`},
	} {
		if reading, err := ParseReport(input.format, []byte(input.data)); err == nil {
			t.Errorf("%s: read %+v", name, reading)
		}
	}
}

func TestParseLogFindsEachIdOnce(t *testing.T) {
	t.Parallel()
	got := Ids(ParseLog(string(fixture(t, "failed.log"))))
	want := []string{"CVE-2099-0007", "CVE-2099-12345", "GHSA-aaaa-bbbb-cccc", "GO-2099-0001"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("ids = %v, want %v", got, want)
	}
}

func TestParseLogBoundsWhatItKeeps(t *testing.T) {
	t.Parallel()
	var log strings.Builder
	for i := 0; i < 500; i++ {
		fmt.Fprintf(&log, "GO-2099-%04d\n", i)
	}
	if got := len(ParseLog(log.String())); got != maxLogIds {
		t.Fatalf("a log that names hundreds of ids keeps %d, want %d", got, maxLogIds)
	}
}

func TestCleanLineKeepsOneShortLine(t *testing.T) {
	t.Parallel()
	got := CleanLine("  first\r\nsecond\t`third` <b>x</b>\x00\x1b[31m  ", 200)
	if got != "first second third bx/b [31m" {
		t.Fatalf("CleanLine = %q", got)
	}
	long := CleanLine(strings.Repeat("é", 300), 10)
	if runes := []rune(long); len(runes) != 11 || runes[10] != '…' {
		t.Fatalf("a long text is cut on a rune: %q", long)
	}
}

func TestNormalizeIdAndFingerprint(t *testing.T) {
	t.Parallel()
	for in, want := range map[string]string{
		"go-2099-0001":        "GO-2099-0001",
		" cve-2099-0001 ":     "CVE-2099-0001",
		"GHSA-AAAA-BBBB-CCCC": "GHSA-aaaa-bbbb-cccc",
		"GO-2099-0001; ls":    "",
		"":                    "",
		"../etc":              "",
	} {
		if got := NormalizeId(in); got != want {
			t.Errorf("NormalizeId(%q) = %q, want %q", in, got, want)
		}
	}
	a := Fingerprint([]string{"GO-2099-0001", "ghsa-aaaa-bbbb-cccc"})
	b := Fingerprint([]string{"GHSA-AAAA-BBBB-CCCC", "go-2099-0001", "GO-2099-0001"})
	if a == "" || a != b {
		t.Fatalf("the same set in another order and spelling must give one key: %q %q", a, b)
	}
	if a == Fingerprint([]string{"GO-2099-0001"}) || Fingerprint(nil) != "" {
		t.Fatal("another set gives another key, and no id gives none")
	}
}
