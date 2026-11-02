// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// Step 1 of the pipeline setup stepper (FR-MC-038): the app type in five values and what the repository shows of a
// pipeline (version tags, GitHub releases, workflows publishing on a tag, dated changelogs, MoltenTerm's own pipeline).
// It only reads: the files, git tags, and gh release list.

const (
	AppTypeDesktop = "desktop"
	AppTypeCli     = "cli"
	AppTypeWeb     = "web"
	AppTypeLibrary = "library"
	AppTypeOther   = "other"

	PathAnalyse  = "analyse"
	PathDescribe = "describe"

	PipelineNone      = "none"
	PipelineInvalid   = "invalid"
	PipelineNoRelease = "norelease"
	PipelinePartial   = "partial"
	PipelineComplete  = "complete"

	maxSurveyReleases = 200
)

var AppTypes = []string{AppTypeDesktop, AppTypeCli, AppTypeWeb, AppTypeLibrary, AppTypeOther}

type SurveyRequest struct {
	Dir string `json:"dir"`
}

type SurveyTags struct {
	Read   bool   `json:"read"`
	Prefix string `json:"prefix"`
	Count  int    `json:"count"`
	First  string `json:"first,omitempty"`
	Last   string `json:"last,omitempty"`
	// The pre-release tags among them (v1.0.0-1, v0.1.0-beta), the last public one, and whether its commit is a merge
	// commit: how the release branch took the last release (#1101).
	Pre        int    `json:"pre"`
	LastPublic string `json:"lastpublic,omitempty"`
	LastMerge  bool   `json:"lastmerge,omitempty"`
}

type SurveyReleases struct {
	// Read through gh when origin is on GitHub; Error is gh's own words when it could not, Problem what it means
	// (GhMissing, GhSignedOut, GhFailed).
	OnGithub bool   `json:"ongithub"`
	Read     bool   `json:"read"`
	Error    string `json:"error,omitempty"`
	Problem  string `json:"problem,omitempty"`
	Count    int    `json:"count"`
	Last     string `json:"last,omitempty"`
}

type SurveyWorkflow struct {
	File  string   `json:"file"`
	Tags  []string `json:"tags"`
	Ships []string `json:"ships"`
}

type SurveyChangelog struct {
	Path string `json:"path"`
	// The headings naming a version and a date; Last is the first one's version (changelogs put the newest on top).
	Sections int    `json:"sections"`
	Last     string `json:"last,omitempty"`
}

type SurveyAnswer struct {
	AppType         string   `json:"apptype"`
	AppTypeEvidence []Source `json:"apptypeevidence"`
	// The release template the type maps onto (on-premise or saas).
	Kind       string            `json:"kind"`
	Tags       SurveyTags        `json:"tags"`
	Releases   SurveyReleases    `json:"releases"`
	Publish    []SurveyWorkflow  `json:"publish"`
	Changelogs []SurveyChangelog `json:"changelogs"`
	// MoltenTerm's committed pipeline: none, invalid, norelease, partial or complete; Missing are its empty channels.
	Pipeline string   `json:"pipeline"`
	Missing  []string `json:"missing"`
	// The project already ships, and the path the stepper recommends.
	Ships       bool   `json:"ships"`
	Recommended string `json:"recommended"`
	// The committed pipeline's hash (DraftAnswer.Base), and the answers saved for this project.
	Base    string   `json:"base"`
	Answers *Answers `json:"answers,omitempty"`
	// What the empty and error states need (#1106): a git repository with commits, an origin remote, nothing to read
	// (no build file, workflow or tag), and the coding agent that proposes changes ("" when none can start;
	// AgentMissing names the chosen one when it is not installed). The pipeline's validation errors when it is invalid.
	Git            bool     `json:"git"`
	Remote         bool     `json:"remote"`
	Empty          bool     `json:"empty"`
	Agent          string   `json:"agent"`
	AgentName      string   `json:"agentname,omitempty"`
	AgentMissing   string   `json:"agentmissing,omitempty"`
	PipelineErrors []string `json:"pipelineerrors,omitempty"`
}

// What a failing gh means for the setup (#1106).
const (
	GhMissing   = "missing"
	GhSignedOut = "signedout"
	GhFailed    = "failed"
)

// ghProblem reads gh's failure: not installed, signed out, or any other failure (network, rate limit).
func ghProblem(text string) string {
	lower := strings.ToLower(text)
	switch {
	case strings.Contains(lower, "executable file not found") || (strings.Contains(lower, "no such file or directory") && strings.Contains(lower, "gh")):
		return GhMissing
	case strings.Contains(lower, "gh auth login") || strings.Contains(lower, "not logged") || strings.Contains(lower, "authentication") || strings.Contains(lower, "401"):
		return GhSignedOut
	}
	return GhFailed
}

// KindOfAppType: a web app or a SaaS is deployed (the saas template), every other type ships versions.
func KindOfAppType(appType string) string {
	if appType == AppTypeWeb {
		return KindSaas
	}
	return KindOnPremise
}

func validAppType(appType string) bool {
	for _, t := range AppTypes {
		if t == appType {
			return true
		}
	}
	return false
}

// Survey reads step 1's facts on the committed pipeline (#1098); nothing is written.
func (s *Setup) Survey(ctx context.Context, req SurveyRequest) (SurveyAnswer, error) {
	dir, err := checkProjectDir(req.Dir)
	if err != nil {
		return SurveyAnswer{}, err
	}
	b, err := s.readBase(ctx, dir)
	if err != nil {
		return SurveyAnswer{}, err
	}
	report := pipelineReport(dir, b.Pipeline)
	f := DetectWith(dir, report)
	answer := SurveyAnswer{Base: hashOf(b.Pipeline), Missing: f.Missing, Publish: []SurveyWorkflow{}, Changelogs: []SurveyChangelog{}}
	answer.AppType, answer.AppTypeEvidence = detectAppType(dir, f)
	answer.Kind = KindOfAppType(answer.AppType)
	answer.Tags = s.readVersionTags(ctx, dir, f.TagPrefix)
	answer.Releases = s.readReleases(ctx, dir, f.OnGithub)
	for _, wf := range f.Workflows {
		if !wf.Push || len(wf.Tags) == 0 || !(wf.Role == RolePublish || len(wf.Ships) > 0) {
			continue
		}
		answer.Publish = append(answer.Publish, SurveyWorkflow{File: wf.File, Tags: wf.Tags, Ships: orEmpty(wf.Ships)})
	}
	for _, c := range f.Changelogs {
		answer.Changelogs = append(answer.Changelogs, readDatedSections(dir, c.Path))
	}
	answer.Pipeline = pipelineState(f)
	answer.Ships = answer.Tags.Count > 0 || answer.Releases.Count > 0 || len(answer.Publish) > 0 || answer.Pipeline == PipelineComplete
	for _, c := range answer.Changelogs {
		answer.Ships = answer.Ships || c.Sections > 0
	}
	answer.Recommended = PathDescribe
	if answer.Ships {
		answer.Recommended = PathAnalyse
	}
	answer.Answers = s.loadAnswers(dir, answer.Base)
	answer.Git = s.commitOf(ctx, dir, "HEAD") != ""
	answer.Remote = s.hasOrigin(ctx, dir)
	answer.Empty = surveyEmpty(dir, f, answer)
	if answer.Pipeline == PipelineInvalid {
		answer.PipelineErrors = f.PipelineErrors
	}
	if s.ChooseAgent != nil {
		choice := s.ChooseAgent(dir)
		if refineArgv(choice.Agent) != nil {
			answer.Agent, answer.AgentName = choice.Agent, choice.AgentName
		} else if choice.Missing {
			answer.AgentMissing = choice.ChosenName
		}
	}
	return answer, nil
}

// buildFiles: what tells MoltenTerm what a project builds; a folder with none of them, no workflow and no tag has
// nothing to read yet.
var buildFiles = []string{"package.json", "Cargo.toml", "go.mod", "pyproject.toml", "setup.py", "pom.xml", "build.gradle",
	"build.gradle.kts", "Gemfile", "composer.json", "Package.swift", "mix.exs", "deno.json", "Dockerfile", "Makefile",
	".goreleaser.yml", ".goreleaser.yaml", "tauri.conf.json", "electron-builder.yml", "electron-builder.json"}

func surveyEmpty(dir string, f Facts, answer SurveyAnswer) bool {
	if len(f.Workflows) > 0 || answer.Tags.Count > 0 || answer.Releases.Count > 0 || f.HasPipeline || len(f.Changelogs) > 0 {
		return false
	}
	for _, name := range buildFiles {
		if fileExists(filepath.Join(dir, name)) {
			return false
		}
	}
	return true
}

func orEmpty(list []string) []string {
	if list == nil {
		return []string{}
	}
	return list
}

func pipelineState(f Facts) string {
	switch {
	case !f.HasPipeline:
		return PipelineNone
	case !f.PipelineValid:
		return PipelineInvalid
	case len(f.Missing) == 2:
		return PipelineNoRelease
	case len(f.Missing) == 1:
		return PipelinePartial
	}
	return PipelineComplete
}

type surveyPackage struct {
	Name    string          `json:"name"`
	Private bool            `json:"private"`
	Bin     json.RawMessage `json:"bin"`
}

func hasBin(raw json.RawMessage) bool {
	var one string
	if json.Unmarshal(raw, &one) == nil {
		return one != ""
	}
	var many map[string]string
	return json.Unmarshal(raw, &many) == nil && len(many) > 0
}

var cargoBinRegex = regexp.MustCompile(`(?m)^\[\[bin\]\]`)

// detectAppType: installers make a desktop app; a package with a command, or a Go release config, a command-line
// tool; deploy workflows with nothing packaged a web app; a package without a command a library. The developer
// confirms it.
func detectAppType(dir string, f Facts) (string, []Source) {
	var desktop []Source
	for _, t := range f.Targets {
		if t.Packager == PackagerElectronBuilder || t.Packager == PackagerTauri {
			desktop = append(desktop, t.Source)
		}
	}
	if len(desktop) > 0 {
		return AppTypeDesktop, desktop
	}
	var pkg surveyPackage
	npm := readJson(filepath.Join(dir, "package.json"), &pkg) && pkg.Name != "" && !pkg.Private
	if npm && hasBin(pkg.Bin) {
		return AppTypeCli, []Source{{Code: "typeNpmBin", Path: "package.json", Detail: pkg.Name}}
	}
	for _, name := range []string{".goreleaser.yml", ".goreleaser.yaml"} {
		if fileExists(filepath.Join(dir, name)) {
			return AppTypeCli, []Source{{Code: "typeGoreleaser", Path: name}}
		}
	}
	cargo, _ := os.ReadFile(filepath.Join(dir, "Cargo.toml"))
	if cargo != nil && (cargoBinRegex.Match(cargo) || fileExists(filepath.Join(dir, "src", "main.rs"))) {
		return AppTypeCli, []Source{{Code: "typeCargoBin", Path: "Cargo.toml"}}
	}
	if f.Kind == KindSaas {
		return AppTypeWeb, f.KindEvidence
	}
	if npm {
		return AppTypeLibrary, []Source{{Code: "targetNpm", Path: "package.json", Detail: pkg.Name}}
	}
	if cargo != nil && fileExists(filepath.Join(dir, "src", "lib.rs")) {
		return AppTypeLibrary, []Source{{Code: "typeCargoLib", Path: "Cargo.toml"}}
	}
	if fileExists(filepath.Join(dir, "pyproject.toml")) {
		return AppTypeLibrary, []Source{{Code: "typePython", Path: "pyproject.toml"}}
	}
	return AppTypeOther, []Source{}
}

// A version tag: the prefix, X.Y.Z, and any pre-release or build suffix (v0.1.0-beta counts).
func versionTagRegex(prefix string) *regexp.Regexp {
	return regexp.MustCompile(`^` + regexp.QuoteMeta(prefix) + `\d+\.\d+\.\d+([-+][0-9A-Za-z.+-]*)?$`)
}

// readVersionTags lists the local tags in version order, a pre-release before its release.
func (s *Setup) readVersionTags(ctx context.Context, dir string, prefix string) SurveyTags {
	tags := SurveyTags{Prefix: prefix}
	out, err := s.git(ctx, dir, "-c", "versionsort.suffix=-", "tag", "--list", "--sort=v:refname", prefix+"*")
	if err != nil {
		return tags
	}
	tags.Read = true
	re := versionTagRegex(prefix)
	for _, line := range strings.Split(string(out), "\n") {
		name := strings.TrimSpace(line)
		if !re.MatchString(name) {
			continue
		}
		if tags.Count == 0 {
			tags.First = name
		}
		tags.Last = name
		tags.Count++
		if strings.ContainsAny(strings.TrimPrefix(name, prefix), "-+") {
			tags.Pre++
		} else {
			tags.LastPublic = name
		}
	}
	if tags.LastPublic != "" {
		// "<commit> <parent> <parent>": two parents make a merge commit.
		if out, err := s.git(ctx, dir, "rev-list", "--parents", "-n", "1", tags.LastPublic+"^{commit}"); err == nil {
			tags.LastMerge = len(strings.Fields(string(out))) > 2
		}
	}
	return tags
}

func (s *Setup) readReleases(ctx context.Context, dir string, github bool) SurveyReleases {
	rel := SurveyReleases{OnGithub: github}
	if !github || s.Run == nil {
		return rel
	}
	out, err := s.Run(ctx, dir, "gh", "release", "list", "--limit", strconv.Itoa(maxSurveyReleases), "--json", "tagName,isLatest")
	if err != nil {
		rel.Error = errText(err, out)
		rel.Problem = ghProblem(rel.Error + " " + err.Error())
		return rel
	}
	var list []struct {
		TagName  string `json:"tagName"`
		IsLatest bool   `json:"isLatest"`
	}
	if err := json.Unmarshal(out, &list); err != nil {
		rel.Error = err.Error()
		return rel
	}
	rel.Read = true
	rel.Count = len(list)
	for _, r := range list {
		if r.IsLatest {
			rel.Last = r.TagName
		}
	}
	if rel.Last == "" && len(list) > 0 {
		rel.Last = list[0].TagName
	}
	return rel
}

// "## [1.0.1] - 2026-10-01", "## v1.0.1 (2026-10-01)", "### 1.0.1 — 2026-10-01".
var datedSectionRegex = regexp.MustCompile(`(?m)^#{1,3}\s.*?\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b.*\b\d{4}-\d{2}-\d{2}\b`)

func readDatedSections(dir string, path string) SurveyChangelog {
	c := SurveyChangelog{Path: path}
	full := filepath.Join(dir, filepath.FromSlash(path))
	info, err := os.Lstat(full)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxConfigBytes {
		return c
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return c
	}
	matches := datedSectionRegex.FindAllSubmatch(data, -1)
	c.Sections = len(matches)
	if len(matches) > 0 {
		c.Last = string(matches[0][1])
	}
	return c
}
