// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Step 1 of the stepper (FR-MC-038): the app type and what the repository shows of a pipeline, on real git tags and a
// fake gh; the answers kept per project.

const datedChangelog = "# Changelog\n\n## [1.0.1] - 2026-10-01\n\n- fix\n\n## [1.0.0] - 2026-09-20\n\n- first\n"

// surveyRunner: git for real, gh answering release list with the given JSON (or failing when it is "").
func surveyRunner(releases string) Runner {
	return func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		switch name {
		case "git":
			cmd := exec.CommandContext(ctx, "git", args...)
			cmd.Dir = dir
			return cmd.Output()
		case "gh":
			if strings.Join(args[:2], " ") == "release list" {
				if releases == "" {
					return []byte("gh: authentication required\n"), errors.New("exit status 4")
				}
				return []byte(releases), nil
			}
		}
		return nil, errors.New(name + ": unexpected " + strings.Join(args, " "))
	}
}

func surveyRepository(t *testing.T, files map[string]string, tags ...string) string {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "Setup test")
	t.Setenv("GIT_AUTHOR_EMAIL", "setup@example.invalid")
	t.Setenv("GIT_COMMITTER_NAME", "Setup test")
	t.Setenv("GIT_COMMITTER_EMAIL", "setup@example.invalid")
	dir := filepath.Join(t.TempDir(), "app")
	gitIn(t, filepath.Dir(dir), "init", "--quiet", "-b", "develop", dir)
	files["app.txt"] = "one\n"
	writeFiles(t, dir, files)
	gitIn(t, dir, "add", "-A")
	gitIn(t, dir, "commit", "--quiet", "-m", "chore: bootstrap")
	for _, tag := range tags {
		gitIn(t, dir, "tag", tag)
	}
	return dir
}

func TestSurveySaaSFoundryShapedCli(t *testing.T) {
	dir := surveyRepository(t, map[string]string{
		".molten/project.json":                 sfPipeline,
		".saasfoundry.json":                    sfManifest,
		"package.json":                         `{ "name": "saasfoundryai", "version": "1.0.4", "bin": { "sf": "bin/sf.js" } }`,
		".github/workflows/publish-stable.yml": publishStable,
		".github/workflows/test.yml":           testYml,
		"docs/changelog.md":                    datedChangelog,
		"docs/fr/changelog.md":                 "# Journal\n",
	}, "v0.1.0-beta", "v1.0.1", "v1.0.0", "v1.0.0-1", "other-tag")
	gitIn(t, dir, "remote", "add", "origin", "git@github.com:DiamondForgeFr/SaasFoundryAI.git")
	s := MakeSetup(surveyRunner(`[{"tagName":"v1.0.1","isLatest":true},{"tagName":"v1.0.0","isLatest":false}]`), nil)
	before, _ := os.ReadFile(filepath.Join(dir, ".molten/project.json"))
	answer, err := s.Survey(context.Background(), SurveyRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if answer.AppType != AppTypeCli || answer.Kind != KindOnPremise || len(answer.AppTypeEvidence) != 1 || answer.AppTypeEvidence[0].Code != "typeNpmBin" {
		t.Fatalf("type %s kind %s evidence %+v", answer.AppType, answer.Kind, answer.AppTypeEvidence)
	}
	tags := answer.Tags
	if !tags.Read || tags.Count != 4 || tags.First != "v0.1.0-beta" || tags.Last != "v1.0.1" || tags.Prefix != "v" {
		t.Fatalf("tags %+v", tags)
	}
	if !answer.Releases.Read || answer.Releases.Count != 2 || answer.Releases.Last != "v1.0.1" {
		t.Fatalf("releases %+v", answer.Releases)
	}
	if len(answer.Publish) != 1 || answer.Publish[0].File != "publish-stable.yml" {
		t.Fatalf("publish %+v", answer.Publish)
	}
	if len(answer.Changelogs) != 2 || answer.Changelogs[0].Path != "docs/changelog.md" || answer.Changelogs[0].Sections != 2 || answer.Changelogs[0].Last != "1.0.1" || answer.Changelogs[1].Sections != 0 {
		t.Fatalf("changelogs %+v", answer.Changelogs)
	}
	if answer.Pipeline != PipelineNoRelease || !answer.Ships || answer.Recommended != PathAnalyse || answer.Base == "" {
		t.Fatalf("pipeline %s ships %v recommended %s base %q", answer.Pipeline, answer.Ships, answer.Recommended, answer.Base)
	}
	after, _ := os.ReadFile(filepath.Join(dir, ".molten/project.json"))
	if string(before) != string(after) {
		t.Fatal("the survey wrote the pipeline")
	}
}

func TestSurveyEmptyRepositoryRecommendsDescribing(t *testing.T) {
	dir := surveyRepository(t, map[string]string{"README.md": "# App\n"})
	s := MakeSetup(surveyRunner(""), nil)
	answer, err := s.Survey(context.Background(), SurveyRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if answer.AppType != AppTypeOther || answer.Ships || answer.Recommended != PathDescribe || answer.Pipeline != PipelineNone {
		t.Fatalf("%+v", answer)
	}
	if !answer.Tags.Read || answer.Tags.Count != 0 || answer.Releases.OnGithub || answer.Releases.Read {
		t.Fatalf("tags %+v releases %+v", answer.Tags, answer.Releases)
	}
}

func TestSurveyReleasesUnreadSaysWhy(t *testing.T) {
	dir := surveyRepository(t, map[string]string{"README.md": "# App\n"})
	gitIn(t, dir, "remote", "add", "origin", "https://github.com/acme/app.git")
	answer, err := MakeSetup(surveyRunner(""), nil).Survey(context.Background(), SurveyRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if !answer.Releases.OnGithub || answer.Releases.Read || !strings.Contains(answer.Releases.Error, "authentication") {
		t.Fatalf("releases %+v", answer.Releases)
	}
}

func TestAppTypes(t *testing.T) {
	cases := []struct {
		name  string
		files map[string]string
		want  string
	}{
		{"electron", map[string]string{"package.json": `{ "name": "app", "private": true }`, "electron-builder.yml": "win:\n  target: nsis\n"}, AppTypeDesktop},
		{"web", map[string]string{".github/workflows/deploy.yml": deployApi}, AppTypeWeb},
		{"library", map[string]string{"package.json": `{ "name": "lib", "version": "1.0.0" }`}, AppTypeLibrary},
		{"cli", map[string]string{"package.json": `{ "name": "tool", "bin": "cli.js" }`}, AppTypeCli},
		{"go cli", map[string]string{".goreleaser.yaml": "builds: []\n"}, AppTypeCli},
		{"rust lib", map[string]string{"Cargo.toml": "[package]\nname = \"x\"\n", "src/lib.rs": ""}, AppTypeLibrary},
		{"private package", map[string]string{"package.json": `{ "name": "site", "private": true }`}, AppTypeOther},
	}
	for _, c := range cases {
		dir := t.TempDir()
		writeFiles(t, dir, c.files)
		got, _ := detectAppType(dir, Detect(dir))
		if got != c.want {
			t.Errorf("%s: %s, want %s", c.name, got, c.want)
		}
	}
	if KindOfAppType(AppTypeWeb) != KindSaas || KindOfAppType(AppTypeLibrary) != KindOnPremise {
		t.Fatal("type to kind")
	}
}

func TestAnswersResumeAndDropOnANewBase(t *testing.T) {
	dir := t.TempDir()
	s := MakeSetup(noSf, nil)
	s.AnswersDir = filepath.Join(t.TempDir(), "answers")
	if s.loadAnswers(dir, "h1") != nil {
		t.Fatal("answers before any save")
	}
	opts := Options{Kind: KindOnPremise, Channels: []string{ChannelRc}, TagPrefix: "v"}
	saved := Answers{Base: "h1", Step: StepUnderstand, AppType: AppTypeCli, Path: PathAnalyse, Touched: true, Options: &opts}
	if _, err := s.SaveAnswers(AnswersRequest{Dir: dir, Answers: &saved}); err != nil {
		t.Fatal(err)
	}
	got := s.loadAnswers(dir, "h1")
	if got == nil || got.Step != StepUnderstand || got.AppType != AppTypeCli || !got.Touched || got.Options == nil || got.Options.Channels[0] != ChannelRc {
		t.Fatalf("resumed %+v", got)
	}
	moved := s.loadAnswers(dir, "h2")
	if moved == nil || moved.Step != "" || moved.Options != nil || moved.Touched || moved.AppType != AppTypeCli || moved.Path != PathAnalyse {
		t.Fatalf("after the pipeline moved %+v", moved)
	}
	if s.loadAnswers(t.TempDir(), "h1") != nil {
		t.Fatal("another project's answers")
	}
	if _, err := s.SaveAnswers(AnswersRequest{Dir: dir, Answers: &Answers{Step: "elsewhere"}}); err == nil {
		t.Fatal("an unknown step is saved")
	}
	if _, err := s.SaveAnswers(AnswersRequest{Dir: dir}); err != nil {
		t.Fatal(err)
	}
	if s.loadAnswers(dir, "h1") != nil {
		t.Fatal("cleared answers still load")
	}
}
