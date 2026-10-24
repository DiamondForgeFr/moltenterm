// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package pipelinesetup drafts a missing release pipeline from what a repository says (FR-MC-036, DS-MC-031): the
// branches, the version files, the changelogs, the GitHub workflows and the packagers. It reads the project and never
// writes in it but through Write, on the developer's click.
package pipelinesetup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

const (
	// must match release.DefaultNotesPath: where molten release prepare writes the notes when versions.notes is not set.
	DefaultNotesPath = "releases/{tag}.md"

	KindOnPremise = "on-premise"
	KindSaas      = "saas"

	ChannelRc     = "rc"
	ChannelPublic = "public"

	maxConfigBytes = 1 << 20
)

// Where a drafted value came from, for the developer to check (FR-MC-036): an i18n code (mc.setup.source.<code>) and
// the file or key it names.
type Source struct {
	Code   string `json:"code"`
	Path   string `json:"path,omitempty"`
	Detail string `json:"detail,omitempty"`
}

type Target struct {
	Id       string `json:"id"`
	Packager string `json:"packager"`
	Source   Source `json:"source"`
}

type Changelog struct {
	Path string `json:"path"`
	Lang string `json:"lang"`
}

type Facts struct {
	Name           string                 `json:"name"`
	HasPipeline    bool                   `json:"haspipeline"`
	PipelineValid  bool                   `json:"pipelinevalid"`
	PipelineErrors []string               `json:"pipelineerrors,omitempty"`
	Missing        []string               `json:"missing"`
	Branches       molten.ProjectBranches `json:"branches"`
	// .saasfoundry.json workflow.branchNaming.release, e.g. rc-{version}.
	RcBranchPattern  string                 `json:"rcbranchpattern,omitempty"`
	TagPrefix        string                 `json:"tagprefix"`
	VersionsDeclared bool                   `json:"versionsdeclared"`
	VersionFiles     []versions.VersionFile `json:"versionfiles"`
	VersionSource    Source                 `json:"versionsource"`
	NotesDeclared    bool                   `json:"notesdeclared"`
	// versions.notes, else MoltenTerm's default (releases/{tag}.md), and whether notes of earlier versions are there.
	NotesPath    string      `json:"notespath"`
	NotesFound   bool        `json:"notesfound"`
	Changelogs   []Changelog `json:"changelogs"`
	Workflows    []Workflow  `json:"workflows"`
	Targets      []Target    `json:"targets"`
	OnGithub     bool        `json:"ongithub"`
	Kind         string      `json:"kind"`
	KindEvidence []Source    `json:"kindevidence"`
	SaaSFoundry  bool        `json:"saasfoundry"`
	// The project's workflow wants every change on a ticket branch (a SaaSFoundryAI commit format requiring a ticket).
	TicketBranches bool   `json:"ticketbranches"`
	CurrentBranch  string `json:"currentbranch,omitempty"`
	// Where `molten release prepare` prepares the cut, beside the main checkout.
	ReleaseWorktree string `json:"releaseworktree"`
}

type packageJson struct {
	Name    string          `json:"name"`
	Version string          `json:"version"`
	Private bool            `json:"private"`
	Build   json.RawMessage `json:"build"`
}

func readJson(path string, target any) bool {
	data, err := os.ReadFile(path)
	if err != nil || len(data) > maxConfigBytes {
		return false
	}
	return json.Unmarshal(data, target) == nil
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// Detect reads the repository at dir.
func Detect(dir string) Facts {
	f := Facts{Name: filepath.Base(dir), TagPrefix: versions.DefaultTagPrefix, Missing: []string{}, Changelogs: []Changelog{},
		Workflows: []Workflow{}, Targets: []Target{}, KindEvidence: []Source{}, VersionFiles: []versions.VersionFile{}}
	report := molten.ValidatePipeline(dir)
	f.HasPipeline = report.Present
	f.PipelineValid = report.Valid
	f.PipelineErrors = report.Errors
	var p *molten.Pipeline
	if report.Valid {
		p = report.Pipeline
		f.Name = p.Name
	}
	if p == nil || p.Release == nil || len(p.Release.Rc) == 0 {
		f.Missing = append(f.Missing, ChannelRc)
	}
	if p == nil || p.Release == nil || len(p.Release.Public) == 0 {
		f.Missing = append(f.Missing, ChannelPublic)
	}
	f.Branches = molten.ResolvedBranches(dir)
	f.ReleaseWorktree = "../" + filepath.Base(mainCheckout(dir)) + "-release"
	readSaaSFoundryFacts(dir, &f)
	if p != nil && p.Versions != nil {
		if p.Versions.TagPrefix != "" {
			f.TagPrefix = p.Versions.TagPrefix
		}
		f.NotesDeclared = p.Versions.Notes != ""
		if len(p.Versions.Files) > 0 {
			f.VersionsDeclared = true
			f.VersionFiles = p.Versions.Files
			f.VersionSource = Source{Code: "versionsDeclared", Path: molten.ProjectPipelineFile}
		}
	}
	if !f.VersionsDeclared {
		f.VersionFiles, f.VersionSource = detectVersionFiles(dir)
	}
	f.NotesPath = DefaultNotesPath
	if p != nil && p.Versions != nil && p.Versions.Notes != "" {
		f.NotesPath = p.Versions.Notes
	}
	notesGlob := strings.ReplaceAll(f.NotesPath, "{tag}", "*")
	if matches, _ := filepath.Glob(filepath.Join(dir, filepath.FromSlash(notesGlob))); len(matches) > 0 {
		f.NotesFound = true
	}
	f.Changelogs = detectChangelogs(dir)
	f.Workflows = ReadWorkflows(dir)
	if f.Workflows == nil {
		f.Workflows = []Workflow{}
	}
	f.Targets = detectTargets(dir, f.Workflows)
	f.OnGithub = onGithub(dir)
	f.Kind, f.KindEvidence = detectKind(f)
	return f
}

func readSaaSFoundryFacts(dir string, f *Facts) {
	var sf struct {
		Workflow *struct {
			BranchNaming map[string]string `json:"branchNaming"`
			CommitFormat *struct {
				RequireTicket bool `json:"requireTicket"`
			} `json:"commitFormat"`
		} `json:"workflow"`
	}
	if !readJson(filepath.Join(dir, molten.ProjectSaaSFoundryFile), &sf) {
		return
	}
	f.SaaSFoundry = true
	if sf.Workflow == nil {
		return
	}
	f.RcBranchPattern = sf.Workflow.BranchNaming["release"]
	f.TicketBranches = sf.Workflow.CommitFormat != nil && sf.Workflow.CommitFormat.RequireTicket
}

func onGithub(dir string) bool {
	data, err := os.ReadFile(filepath.Join(dir, ".git", "config"))
	if err != nil {
		// A linked worktree: .git is a file; the remote is read from the common folder.
		gitFile, ferr := os.ReadFile(filepath.Join(dir, ".git"))
		if ferr != nil {
			return false
		}
		gitdir := strings.TrimSpace(strings.TrimPrefix(string(gitFile), "gitdir:"))
		data, err = os.ReadFile(filepath.Join(gitdir, "..", "..", "config"))
		if err != nil {
			return false
		}
	}
	return strings.Contains(strings.ToLower(string(data)), "github")
}

// detectVersionFiles proposes the files that carry the version when the pipeline declares none: the ones whose
// version reads the same as the first.
func detectVersionFiles(dir string) ([]versions.VersionFile, Source) {
	candidates := []versions.VersionFile{
		{Path: "package.json", Format: versions.FileFormatJson, Keys: [][]string{{"version"}}},
		{Path: "package-lock.json", Format: versions.FileFormatJson, Keys: [][]string{{"version"}, {"packages", "", "version"}}},
		{Path: "src-tauri/tauri.conf.json", Format: versions.FileFormatJson, Keys: [][]string{{"version"}}},
		{Path: "src-tauri/Cargo.toml", Format: versions.FileFormatRegex, Pattern: `(?m)^version\s*=\s*"([^"]+)"`},
		{Path: "Cargo.toml", Format: versions.FileFormatRegex, Pattern: `(?m)^version\s*=\s*"([^"]+)"`},
		{Path: molten.ProjectSaaSFoundryFile, Format: versions.FileFormatJson, Keys: [][]string{{"version"}}},
	}
	var rtn []versions.VersionFile
	first := ""
	var names []string
	for _, c := range candidates {
		values, err := versions.ReadFileVersions(dir, c)
		if err != nil || len(values) == 0 {
			continue
		}
		if first == "" {
			first = values[0]
		}
		same := true
		for _, v := range values {
			same = same && v == first
		}
		if !same {
			continue
		}
		rtn = append(rtn, c)
		names = append(names, c.Path)
	}
	if rtn == nil {
		return []versions.VersionFile{}, Source{Code: "versionsNone"}
	}
	return rtn, Source{Code: "versionsFound", Path: strings.Join(names, ", "), Detail: first}
}

var langSuffixRegex = regexp.MustCompile(`(?i)\.([a-z]{2})\.md$`)
var langDirRegex = regexp.MustCompile(`^[a-z]{2}$`)

func detectChangelogs(dir string) []Changelog {
	var paths []string
	for _, pattern := range []string{"CHANGELOG*.md", "changelog*.md", "docs/changelog*.md", "docs/CHANGELOG*.md", "docs/*/changelog*.md", "docs/*/CHANGELOG*.md"} {
		matches, _ := filepath.Glob(filepath.Join(dir, filepath.FromSlash(pattern)))
		for _, m := range matches {
			rel, err := filepath.Rel(dir, m)
			if err == nil && fileExists(m) {
				paths = appendOnce(paths, filepath.ToSlash(rel))
			}
		}
	}
	sort.Strings(paths)
	rtn := []Changelog{}
	for _, path := range paths {
		lang := "en"
		if m := langSuffixRegex.FindStringSubmatch(path); m != nil {
			lang = strings.ToLower(m[1])
		} else if parts := strings.Split(path, "/"); len(parts) == 3 && langDirRegex.MatchString(parts[1]) {
			lang = parts[1]
		}
		rtn = append(rtn, Changelog{Path: path, Lang: lang})
	}
	return rtn
}

var electronTargetRegex = regexp.MustCompile(`["'](msi|nsis|dmg|appx|AppImage|deb|rpm|snap|pacman)["']`)

func detectTargets(dir string, workflows []Workflow) []Target {
	var rtn []Target
	add := func(t Target) {
		for _, known := range rtn {
			if known.Id == t.Id {
				return
			}
		}
		rtn = append(rtn, t)
	}
	for _, name := range []string{"electron-builder.config.cjs", "electron-builder.config.js", "electron-builder.config.mjs", "electron-builder.yml", "electron-builder.json", "electron-builder.json5"} {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil || len(data) > maxConfigBytes {
			continue
		}
		for _, m := range electronTargetRegex.FindAllStringSubmatch(string(data), -1) {
			add(Target{Id: electronTarget(m[1]), Packager: PackagerElectronBuilder, Source: Source{Code: "targetConfig", Path: name, Detail: m[1]}})
		}
		if strings.HasSuffix(name, ".yml") {
			for _, word := range []string{"msi", "nsis", "dmg"} {
				if regexp.MustCompile(`(?m)\b` + word + `\b`).Match(data) {
					add(Target{Id: word, Packager: PackagerElectronBuilder, Source: Source{Code: "targetConfig", Path: name, Detail: word}})
				}
			}
		}
	}
	var tauri struct {
		Bundle struct {
			Targets json.RawMessage `json:"targets"`
		} `json:"bundle"`
		Tauri struct {
			Bundle struct {
				Targets json.RawMessage `json:"targets"`
			} `json:"bundle"`
		} `json:"tauri"`
	}
	tauriConf := "src-tauri/tauri.conf.json"
	if readJson(filepath.Join(dir, filepath.FromSlash(tauriConf)), &tauri) {
		raw := tauri.Bundle.Targets
		if len(raw) == 0 {
			raw = tauri.Tauri.Bundle.Targets
		}
		var all string
		var list []string
		if json.Unmarshal(raw, &all) == nil && all == "all" {
			list = []string{"msi", "nsis", "dmg", "deb", "appimage"}
		} else {
			json.Unmarshal(raw, &list)
		}
		for _, t := range list {
			add(Target{Id: electronTarget(t), Packager: PackagerTauri, Source: Source{Code: "targetConfig", Path: tauriConf, Detail: t}})
		}
	}
	var pkg packageJson
	if readJson(filepath.Join(dir, "package.json"), &pkg) && pkg.Name != "" && !pkg.Private {
		add(Target{Id: TargetNpm, Packager: PackagerNpm, Source: Source{Code: "targetNpm", Path: "package.json", Detail: pkg.Name}})
	}
	for _, wf := range workflows {
		for _, ship := range wf.Ships {
			if ship == TargetPages {
				continue
			}
			packager := PackagerWorkflow
			if ship == TargetContainer {
				packager = PackagerDocker
			}
			add(Target{Id: ship, Packager: packager, Source: Source{Code: "targetWorkflow", Path: WorkflowsDir + "/" + wf.File}})
		}
	}
	if rtn == nil {
		return []Target{}
	}
	return rtn
}

func electronTarget(t string) string {
	switch strings.ToLower(t) {
	case "msi":
		return TargetMsi
	case "nsis":
		return TargetNsis
	case "dmg":
		return TargetDmg
	}
	return TargetLinux
}

// detectKind: an app that is packaged or published on a tag is on-premise (distributed); one whose workflows deploy it
// to environments, with nothing packaged, is a SaaS. The developer confirms either.
func detectKind(f Facts) (string, []Source) {
	var onPremise, saas []Source
	for _, t := range f.Targets {
		if t.Id != TargetContainer {
			onPremise = append(onPremise, t.Source)
		}
	}
	for _, wf := range f.Workflows {
		switch wf.Role {
		case RolePublish:
			onPremise = append(onPremise, Source{Code: "kindPublish", Path: WorkflowsDir + "/" + wf.File})
		case RoleDeploy:
			saas = append(saas, Source{Code: "kindDeploy", Path: WorkflowsDir + "/" + wf.File, Detail: strings.Join(wf.Environments, ", ")})
		}
	}
	if len(saas) > 0 && len(onPremise) == 0 {
		return KindSaas, saas
	}
	if onPremise == nil {
		return KindOnPremise, []Source{}
	}
	return KindOnPremise, onPremise
}

// TargetIds lists the targets' ids.
func (f Facts) TargetIds() []string {
	var rtn []string
	for _, t := range f.Targets {
		rtn = append(rtn, t.Id)
	}
	return rtn
}

// DeployEnvironments: the environments the SaaS deploy workflows name, each with its workflow; a deploy workflow
// naming none counts as one environment named after its file.
type DeployTarget struct {
	Environment string `json:"environment"`
	Workflow    string `json:"workflow"`
	Dispatch    bool   `json:"dispatch"`
}

func (f Facts) DeployTargets() []DeployTarget {
	rtn := []DeployTarget{}
	for _, wf := range f.Workflows {
		if wf.Role != RoleDeploy {
			continue
		}
		envs := wf.Environments
		if len(envs) == 0 {
			envs = []string{strings.TrimSuffix(strings.TrimSuffix(wf.File, ".yml"), ".yaml")}
		}
		for _, env := range envs {
			rtn = append(rtn, DeployTarget{Environment: env, Workflow: wf.File, Dispatch: wf.Dispatch})
		}
	}
	return rtn
}

// mainCheckout is the repository's main checkout for a linked worktree (its .git is a file), else dir.
func mainCheckout(dir string) string {
	data, err := os.ReadFile(filepath.Join(dir, ".git"))
	if err != nil {
		return dir
	}
	gitdir := strings.TrimSpace(strings.TrimPrefix(string(data), "gitdir:"))
	if i := strings.Index(gitdir, string(filepath.Separator)+".git"+string(filepath.Separator)+"worktrees"+string(filepath.Separator)); i >= 0 {
		return gitdir[:i]
	}
	return dir
}
