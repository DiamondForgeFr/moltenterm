// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package secfix

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestClassify(t *testing.T) {
	t.Parallel()
	declared := &Declaration{Checks: []string{"Dependency security / Scan dependencies", "CI / Audit (*)"}}
	failed := func(name string, workflow string) Check {
		return Check{Name: name, Workflow: workflow, Failed: true, RunId: 1, JobId: 2}
	}
	for name, test := range map[string]struct {
		policy Policy
		check  Check
		want   string
	}{
		"a declared check":                    {Policy{Declaration: declared}, failed("Dependency security / Scan dependencies", "CI"), ClassDeclared},
		"a declared check, any case":          {Policy{Declaration: declared}, failed("dependency security / scan   dependencies", "CI"), ClassDeclared},
		"declared as workflow and job":        {Policy{Declaration: &Declaration{Checks: []string{"CI / Scan"}}}, failed("Scan", "CI"), ClassDeclared},
		"declared with a wildcard":            {Policy{Declaration: declared}, failed("Audit (ubuntu)", "CI"), ClassDeclared},
		"a declared check that passes":        {Policy{Declaration: declared}, Check{Name: "Dependency security / Scan dependencies", Workflow: "CI"}, ClassNone},
		"another job when a scan is declared": {Policy{Declaration: declared}, failed("Security audit", "Audit"), ClassNone},
		"a confirmed check":                   {Policy{Confirmed: []string{"Security audit"}}, failed("Security audit", "Audit"), ClassConfirmed},
		"a dismissed check":                   {Policy{Dismissed: []string{"Security audit"}}, failed("Security audit", "Audit"), ClassNone},
		"a name that looks like a scan":       {Policy{}, failed("Security audit", "Audit"), ClassCandidate},
		"a workflow that looks like a scan":   {Policy{}, failed("Job", "Dependency review"), ClassCandidate},
		"a name that does not":                {Policy{}, failed("Unit tests", "CI"), ClassNone},
		"a local status":                      {Policy{Declaration: &Declaration{Checks: []string{"local-security"}}}, Check{Name: "local-security", Local: true, Failed: true}, ClassNone},
		"a local status by its name":          {Policy{}, failed("AI testing / Local CI", ""), ClassNone},
		"a local status that looks like one":  {Policy{}, failed("local-vuln-check", ""), ClassNone},
		"a declaration with no check":         {Policy{Declaration: &Declaration{}}, failed("Security audit", "Audit"), ClassCandidate},
	} {
		if got := test.policy.Classify(test.check); got != test.want {
			t.Errorf("%s: Classify = %q, want %q", name, got, test.want)
		}
	}
}

func TestDeclarationProblems(t *testing.T) {
	t.Parallel()
	good := &Declaration{
		Checks:          []string{"Dependency security / Scan dependencies"},
		Report:          &ReportSpec{Artifact: "dependency-security-*", File: "security-report/report.json", Format: FormatMoltenterm},
		DependencyFiles: []string{"security/dependencies.json", "*.lock"},
	}
	if problems := good.Problems(); len(problems) != 0 {
		t.Fatalf("a good declaration has problems: %v", problems)
	}
	var none *Declaration
	if none.Problems() != nil {
		t.Fatal("no declaration, no problem")
	}
	for name, test := range map[string]struct {
		declaration Declaration
		want        string
	}{
		"no check":         {Declaration{}, "at least one check"},
		"a blank check":    {Declaration{Checks: []string{"  "}}, "checks[0] is empty"},
		"no artifact":      {Declaration{Checks: []string{"x"}, Report: &ReportSpec{}}, "report.artifact is required"},
		"a flag":           {Declaration{Checks: []string{"x"}, Report: &ReportSpec{Artifact: "--repo=other/repo"}}, "name or a glob"},
		"a bad glob":       {Declaration{Checks: []string{"x"}, Report: &ReportSpec{Artifact: "[a"}}, "not a valid glob"},
		"an absolute file": {Declaration{Checks: []string{"x"}, Report: &ReportSpec{Artifact: "a", File: "/etc/passwd"}}, "relative path inside"},
		"a climbing file":  {Declaration{Checks: []string{"x"}, Report: &ReportSpec{Artifact: "a", File: "../../secret.json"}}, "relative path inside"},
		"a format":         {Declaration{Checks: []string{"x"}, Report: &ReportSpec{Artifact: "a", Format: "sarif"}}, "report.format must be one of"},
		"a bad file glob":  {Declaration{Checks: []string{"x"}, DependencyFiles: []string{"[a"}}, "dependencyfiles[0]"},
	} {
		problems := strings.Join(test.declaration.Problems(), "\n")
		if !strings.Contains(problems, test.want) {
			t.Errorf("%s: problems = %q, want one that says %q", name, problems, test.want)
		}
	}
}

func TestReportFileDefaultsToReportJson(t *testing.T) {
	t.Parallel()
	if got := (&ReportSpec{Artifact: "a"}).ReportFile(); got != DefaultReportFile {
		t.Fatalf("ReportFile = %q", got)
	}
	var none *ReportSpec
	if got := none.ReportFile(); got != DefaultReportFile {
		t.Fatalf("ReportFile of nothing = %q", got)
	}
	if got := (&ReportSpec{Artifact: "a", File: "./out//report.json"}).ReportFile(); got != "out/report.json" {
		t.Fatalf("ReportFile = %q", got)
	}
}

func TestProjectDeclarationOfThisRepositoryIsValid(t *testing.T) {
	t.Parallel()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", ".molten", "project.json"))
	if err != nil {
		t.Fatal(err)
	}
	var project struct {
		Ci struct {
			Security *Declaration `json:"security"`
		} `json:"ci"`
	}
	if err := json.Unmarshal(data, &project); err != nil {
		t.Fatal(err)
	}
	declaration := project.Ci.Security
	if declaration == nil {
		t.Fatal("MoltenTerm declares its own dependency scan in .molten/project.json (ci.security)")
	}
	if problems := declaration.Problems(); len(problems) != 0 {
		t.Fatalf("the repository's declaration has problems: %v", problems)
	}
	policy := Policy{Declaration: declaration}
	// The check as GitHub names the job of the reusable workflow ci.yml calls.
	check := Check{Name: "Dependency security / Scan dependencies", Workflow: "CI", Failed: true, RunId: 1, JobId: 2}
	if got := policy.Classify(check); got != ClassDeclared {
		t.Fatalf("MoltenTerm's own scan is %q", got)
	}
	if got := declaration.Report.Format; got != FormatMoltenterm {
		t.Fatalf("report format = %q", got)
	}
	if !reflect.DeepEqual(declaration.DependencyFiles, []string{"security/dependencies.json"}) {
		t.Fatalf("dependency files = %v", declaration.DependencyFiles)
	}
}
