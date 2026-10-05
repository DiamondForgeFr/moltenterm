// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package molten

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

// A project's pipeline (FR-MC-008, DS-MC-002): `.molten/project.json`, written by the user's coding agent following
// the molten-pipeline guide. It declares the commands Mission Control may run; Moltenterm runs them only through the
// trust rule, and asks before every release step. Validating it runs nothing.

const PipelineSchema = 1

// must match pkg/molten/agentdocs/pipeline-format.md
var PipelineVariables = []string{"{version}", "{tag}", "{branch}"}

type PipelineBranches struct {
	Trunk   string `json:"trunk,omitempty"`
	Release string `json:"release,omitempty"`
}

type PipelineVersions struct {
	TagPrefix string `json:"tagprefix,omitempty"`
	Notes     string `json:"notes,omitempty"`
	// The first public release's number (X.Y.Z): proposed for it, and tags below its first candidate are not releases.
	FirstPublic string `json:"firstpublic,omitempty"`
	// The files that carry the version; the first one holds the project's current version (FR-REL-001).
	Files []versions.VersionFile `json:"files,omitempty"`
}

// A command Moltenterm may run in the project: in `cwd` (relative to the project, default its root), with `env` added.
type PipelineCommand struct {
	Run string            `json:"run"`
	Cwd string            `json:"cwd,omitempty"`
	Env map[string]string `json:"env,omitempty"`
}

type PipelineJob struct {
	Name  string `json:"name"`
	Title string `json:"title,omitempty"`
	// Jobs of different lanes run side by side; jobs of one lane run in order.
	Lane string `json:"lane,omitempty"`
	PipelineCommand
}

type PipelineCi struct {
	Jobs []PipelineJob `json:"jobs"`
	// Run once in the CI worktree before the jobs (e.g. installing dependencies).
	Prepare *PipelineCommand `json:"prepare,omitempty"`
	// "github": each job's verdict is published as the commit status local-<job>.
	Statuses string `json:"statuses,omitempty"`
}

const PipelineCiStatusesGithub = "github"

// A phase a build announces with "▶ phase: <id>": the Timeline shows them all from the start, with their text.
type PipelinePhase struct {
	Id    string `json:"id"`
	Title string `json:"title,omitempty"`
	Text  string `json:"text,omitempty"`
}

const (
	PipelineBuildKindGold = "gold"
	PipelineBuildKindRc   = "rc"
	PipelineBuildVerifyCi = "ci"
	PipelineVerifyPhase   = "verify"
)

// must match the release phases in frontend/moltenterm-shell/mission and pipeline-format.md
var PipelineReleasePhases = []string{"prepare", "cut", "build", "publish", "back"}

const PipelineReleasePhasePrepare = "prepare"

type PipelineBuild struct {
	Id    string `json:"id"`
	Title string `json:"title,omitempty"`
	// Where the build leaves its result (a file or a folder, `~` allowed).
	Artifact    string `json:"artifact,omitempty"`
	Kind        string `json:"kind,omitempty"`
	Description string `json:"description,omitempty"`
	// The delivered build's manifest (`~` allowed); by default manifest.json beside the artifact.
	Manifest string          `json:"manifest,omitempty"`
	Phases   []PipelinePhase `json:"phases,omitempty"`
	// "ci": the local CI runs on the build's commit first, and the build stops unless it is green.
	Verify string `json:"verify,omitempty"`
	// Run in the build's worktree before the command (e.g. installing dependencies).
	Prepare *PipelineCommand `json:"prepare,omitempty"`
	PipelineCommand
}

type PipelineStep struct {
	Id    string `json:"id"`
	Title string `json:"title,omitempty"`
	// A release step's phase (FR-MC-015): the steps of the "prepare" phase run as soon as a release starts; every
	// later one waits for the user's click on the Timeline. See ReleaseStepPhase for a step that declares none.
	Phase string `json:"phase,omitempty"`
	// Said before the step runs, and confirmed, when it cannot be taken back (e.g. the cut that pushes the tag).
	Confirm string `json:"confirm,omitempty"`
	// The step rewrites the public notes: offered beside them, not run in order.
	Notes bool `json:"notes,omitempty"`
	PipelineCommand
}

type PipelineRelease struct {
	Rc     []PipelineStep `json:"rc,omitempty"`
	Public []PipelineStep `json:"public,omitempty"`
}

// An adapter step (FR-MC-007): a project-specific action shown in a panel section.
type PipelineAdapterStep struct {
	Id      string `json:"id"`
	Title   string `json:"title"`
	Section string `json:"section"`
	PipelineCommand
}

type Pipeline struct {
	Schema int    `json:"schema"`
	Name   string `json:"name"`
	// The project's own icon, relative to the project folder; offered before any guessed image (#189).
	Icon     string                `json:"icon,omitempty"`
	Branches *PipelineBranches     `json:"branches,omitempty"`
	Versions *PipelineVersions     `json:"versions,omitempty"`
	Ci       *PipelineCi           `json:"ci,omitempty"`
	Builds   []PipelineBuild       `json:"builds,omitempty"`
	Release  *PipelineRelease      `json:"release,omitempty"`
	Steps    []PipelineAdapterStep `json:"steps,omitempty"`
}

// must match the sections in frontend/moltenterm-shell/mission and pipeline-format.md
var PipelineSections = []string{"timeline", "cilocal", "ciremote", "cd"}

type PipelineReport struct {
	Path     string    `json:"path"`
	Present  bool      `json:"present"`
	Valid    bool      `json:"valid"`
	Errors   []string  `json:"errors"`
	Warnings []string  `json:"warnings"`
	Pipeline *Pipeline `json:"pipeline,omitempty"`
}

var pipelineIdRegex = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)
var pipelineVariableRegex = regexp.MustCompile(`\{[a-z]+\}`)

type pipelineChecker struct {
	dir    string
	report *PipelineReport
}

func (c *pipelineChecker) errorf(format string, args ...any) {
	c.report.Errors = append(c.report.Errors, fmt.Sprintf(format, args...))
}

func (c *pipelineChecker) warnf(format string, args ...any) {
	c.report.Warnings = append(c.report.Warnings, fmt.Sprintf(format, args...))
}

func (c *pipelineChecker) checkId(where string, id string, seen map[string]bool) {
	if !pipelineIdRegex.MatchString(id) {
		c.errorf("%s: id %q must be lowercase letters, digits, '.', '_' or '-'", where, id)
		return
	}
	if seen[id] {
		c.errorf("%s: id %q is used twice", where, id)
	}
	seen[id] = true
}

// insideProject tells whether a relative path stays in the project folder.
func insideProject(dir string, rel string) bool {
	if filepath.IsAbs(rel) {
		return false
	}
	full := filepath.Clean(filepath.Join(dir, rel))
	return full == filepath.Clean(dir) || strings.HasPrefix(full, filepath.Clean(dir)+string(filepath.Separator))
}

var scriptInterpreters = map[string]bool{
	"sh": true, "bash": true, "zsh": true, "node": true, "bun": true, "deno": true, "python": true, "python3": true,
	"ruby": true, "perl": true, "tsx": true,
}

// The script a command starts, when it names a file of the project: the program itself (`./scripts/x.sh`, after any
// VAR=value), or the script an interpreter runs (`bun scripts/x.mjs`). Arguments such as `./cmd/...` are not files.
func referencedScript(run string) string {
	fields := strings.Fields(run)
	i := 0
	for i < len(fields) && strings.Contains(fields[i], "=") && !strings.HasPrefix(fields[i], "-") {
		i++
	}
	if i >= len(fields) {
		return ""
	}
	candidate := fields[i]
	if scriptInterpreters[candidate] && i+1 < len(fields) {
		candidate = fields[i+1]
	}
	if strings.ContainsAny(candidate, "{}$`'\"|&;<>=*") || strings.HasPrefix(candidate, "-") {
		return ""
	}
	if strings.HasPrefix(candidate, "./") || strings.HasPrefix(candidate, "scripts/") {
		return candidate
	}
	return ""
}

func (c *pipelineChecker) checkCommand(where string, cmd PipelineCommand) {
	if strings.TrimSpace(cmd.Run) == "" {
		c.errorf("%s: run is empty", where)
		return
	}
	cwd := cmd.Cwd
	if cwd == "" {
		cwd = "."
	}
	if !insideProject(c.dir, cwd) {
		c.errorf("%s: cwd %q leaves the project", where, cmd.Cwd)
		return
	}
	if info, err := os.Stat(filepath.Join(c.dir, cwd)); err != nil || !info.IsDir() {
		c.errorf("%s: cwd %q is not a folder of the project", where, cmd.Cwd)
		return
	}
	for _, variable := range pipelineVariableRegex.FindAllString(cmd.Run, -1) {
		known := false
		for _, v := range PipelineVariables {
			known = known || v == variable
		}
		if !known {
			c.errorf("%s: unknown variable %s (known: %s)", where, variable, strings.Join(PipelineVariables, ", "))
		}
	}
	if script := referencedScript(cmd.Run); script != "" {
		if _, err := os.Stat(filepath.Join(c.dir, cwd, script)); err != nil {
			c.errorf("%s: %s does not exist", where, script)
		}
	}
	for name := range cmd.Env {
		if name == "" || strings.ContainsAny(name, "= ") {
			c.errorf("%s: env name %q is not valid", where, name)
		}
	}
}

func releasePhaseIndex(phase string) int {
	for i, known := range PipelineReleasePhases {
		if known == phase {
			return i
		}
	}
	return -1
}

// The release contract's traps (#230): each warning names what would otherwise be skipped, run out of the declared
// order, or run without the confirmation the user may expect.
func (c *pipelineChecker) checkSteps(where string, steps []PipelineStep) {
	seen := map[string]bool{}
	phased := false
	for _, step := range steps {
		phased = phased || (step.Phase != "" && !step.Notes)
	}
	phases := ReleaseStepPhase(steps)
	last, lastId := -1, ""
	confirmed := false
	for i, step := range steps {
		label := fmt.Sprintf("%s[%d]", where, i)
		c.checkId(label, step.Id, seen)
		c.checkCommand(label+" ("+step.Id+")", step.PipelineCommand)
		confirmed = confirmed || step.Confirm != ""
		if step.Phase != "" && releasePhaseIndex(step.Phase) < 0 {
			c.errorf("%s (%s): phase %q is not one of %s", label, step.Id, step.Phase, strings.Join(PipelineReleasePhases, ", "))
			continue
		}
		if step.Notes || !phased {
			continue
		}
		if step.Phase == "" {
			c.warnf("%s (%s): no phase while other steps declare one: it runs in the phase of the step before it (%s)", label, step.Id, phases[i])
			continue
		}
		index := releasePhaseIndex(step.Phase)
		if index < last {
			c.warnf("%s (%s): declared after %s, a step of a later phase: it runs in its phase %s, before that step", label, step.Id, lastId, step.Phase)
			continue
		}
		last, lastId = index, step.Id
	}
	if len(steps) == 0 {
		return
	}
	if !phased {
		c.warnf("%s: no step declares its phase: the first one runs when a release starts, the next ones in order, each on its click, and those not run yet once the tag is pushed come after it (back to the trunk)", where)
	}
	if !confirmed {
		c.warnf("%s: no step declares confirm: the step that pushes the tag runs on a plain click, unless it waits on notes drafted for the release", where)
	}
}

// ReleaseStepPhase gives each release step its phase: as declared, or, for a step without one in a list that declares
// phases, the phase of the step before it (the first step: prepare). Without any declared phase, the first step
// prepares and the others get "", their phase being known only as the release goes (cut, or back once tagged).
// Steps that rewrite the notes run beside them, in no phase.
func ReleaseStepPhase(steps []PipelineStep) []string {
	rtn := make([]string, len(steps))
	phased := false
	for _, step := range steps {
		phased = phased || (step.Phase != "" && !step.Notes)
	}
	current := PipelineReleasePhasePrepare
	first := true
	for i, step := range steps {
		if step.Notes {
			continue
		}
		switch {
		case !phased && first:
			rtn[i] = PipelineReleasePhasePrepare
		case !phased:
			rtn[i] = ""
		case step.Phase != "":
			current = step.Phase
			rtn[i] = current
		default:
			rtn[i] = current
		}
		first = false
	}
	return rtn
}

// ReleasePreparation returns the steps that run as soon as a release starts: those of the "prepare" phase, or the
// first step when none declares a phase.
func ReleasePreparation(steps []PipelineStep) []PipelineStep {
	var rtn []PipelineStep
	for i, phase := range ReleaseStepPhase(steps) {
		if phase == PipelineReleasePhasePrepare {
			rtn = append(rtn, steps[i])
		}
	}
	return rtn
}

func (c *pipelineChecker) checkIcon(icon string) {
	if icon == "" {
		return
	}
	if !IsProjectLogoFile(icon) {
		c.errorf("icon: %s is not an image (svg, png, ico, jpg, webp or gif)", icon)
		return
	}
	full := filepath.Clean(filepath.Join(c.dir, filepath.FromSlash(icon)))
	if !strings.HasPrefix(full, filepath.Clean(c.dir)+string(filepath.Separator)) {
		c.errorf("icon: %s is outside the project", icon)
		return
	}
	if stat, err := os.Stat(full); err != nil || !stat.Mode().IsRegular() {
		c.errorf("icon: %s does not exist", icon)
	}
}

func (c *pipelineChecker) checkVersions(v *PipelineVersions) {
	if v.Notes != "" && !strings.Contains(v.Notes, "{tag}") {
		c.errorf("versions.notes must contain {tag} (e.g. releases/{tag}.md)")
	}
	if v.FirstPublic != "" {
		if _, err := versions.ParseBase(v.FirstPublic); err != nil {
			c.errorf("versions.firstpublic must be a public version, X.Y.Z (got %q)", v.FirstPublic)
		}
	}
	current := ""
	for i, f := range v.Files {
		label := fmt.Sprintf("versions.files[%d]", i)
		if f.Path == "" || !insideProject(c.dir, filepath.FromSlash(f.Path)) {
			c.errorf("%s: path %q must be a file of the project", label, f.Path)
			continue
		}
		values, err := versions.ReadFileVersions(c.dir, f)
		if err != nil {
			c.errorf("%s (%s): %v", label, f.Path, err)
			continue
		}
		for _, value := range values {
			if current == "" {
				current = value
			} else if value != current {
				c.warnf("%s (%s): says %s while the project's version is %s", label, f.Path, value, current)
			}
		}
	}
}

func (c *pipelineChecker) check(p *Pipeline) {
	if p.Schema != PipelineSchema {
		c.errorf("schema must be %d (got %d)", PipelineSchema, p.Schema)
	}
	if strings.TrimSpace(p.Name) == "" {
		c.errorf("name is required")
	}
	c.checkIcon(p.Icon)
	if p.Branches != nil {
		var sf struct {
			Workflow *struct{} `json:"workflow"`
		}
		if readProjectJson(filepath.Join(c.dir, ProjectSaaSFoundryFile), &sf) && sf.Workflow != nil {
			c.warnf("branches: .saasfoundry.json already declares them; leave them out so they are not kept twice")
		}
	}
	if p.Versions != nil {
		c.checkVersions(p.Versions)
	}
	if p.Ci != nil {
		seen := map[string]bool{}
		if len(p.Ci.Jobs) == 0 {
			c.errorf("ci.jobs is empty: leave ci out, or declare at least one job")
		}
		for i, job := range p.Ci.Jobs {
			label := fmt.Sprintf("ci.jobs[%d]", i)
			c.checkId(label, job.Name, seen)
			c.checkCommand(label+" ("+job.Name+")", job.PipelineCommand)
		}
		if p.Ci.Prepare != nil {
			c.checkCommand("ci.prepare", *p.Ci.Prepare)
		}
		if p.Ci.Statuses != "" && p.Ci.Statuses != PipelineCiStatusesGithub {
			c.errorf("ci.statuses must be %q or left out (got %q)", PipelineCiStatusesGithub, p.Ci.Statuses)
		}
	}
	seen := map[string]bool{}
	for i, build := range p.Builds {
		label := fmt.Sprintf("builds[%d]", i)
		c.checkId(label, build.Id, seen)
		c.checkCommand(label+" ("+build.Id+")", build.PipelineCommand)
		if build.Artifact == "" {
			c.warnf("%s (%s): no artifact, so it cannot be shown or opened", label, build.Id)
		}
		if build.Kind != "" && build.Kind != PipelineBuildKindGold && build.Kind != PipelineBuildKindRc {
			c.errorf("%s (%s): kind must be %q or %q (got %q)", label, build.Id, PipelineBuildKindGold, PipelineBuildKindRc, build.Kind)
		}
		if build.Verify != "" && build.Verify != PipelineBuildVerifyCi {
			c.errorf("%s (%s): verify must be %q or left out (got %q)", label, build.Id, PipelineBuildVerifyCi, build.Verify)
		}
		if build.Verify == PipelineBuildVerifyCi && (p.Ci == nil || len(p.Ci.Jobs) == 0) {
			c.errorf("%s (%s): verify is \"ci\" but the pipeline declares no ci.jobs", label, build.Id)
		}
		phases := map[string]bool{}
		for j, phase := range build.Phases {
			c.checkId(fmt.Sprintf("%s.phases[%d]", label, j), phase.Id, phases)
		}
		if build.Prepare != nil {
			c.checkCommand(label+" ("+build.Id+") prepare", *build.Prepare)
		}
	}
	if p.Release != nil {
		c.checkSteps("release.rc", p.Release.Rc)
		c.checkSteps("release.public", p.Release.Public)
	}
	seen = map[string]bool{}
	for i, step := range p.Steps {
		label := fmt.Sprintf("steps[%d]", i)
		c.checkId(label, step.Id, seen)
		if strings.TrimSpace(step.Title) == "" {
			c.errorf("%s (%s): title is required", label, step.Id)
		}
		known := false
		for _, section := range PipelineSections {
			known = known || section == step.Section
		}
		if !known {
			c.errorf("%s (%s): section %q is not one of %s", label, step.Id, step.Section, strings.Join(PipelineSections, ", "))
		}
		c.checkCommand(label+" ("+step.Id+")", step.PipelineCommand)
	}
	if p.Ci == nil && len(p.Builds) == 0 && p.Release == nil && len(p.Steps) == 0 {
		c.warnf("the pipeline declares nothing to run (ci, builds, release, steps)")
	}
}

func readProjectJson(path string, target any) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return json.Unmarshal(data, target) == nil
}

func unknownFieldError(err error) string {
	msg := err.Error()
	if field, ok := strings.CutPrefix(msg, "json: unknown field "); ok {
		return "unknown field " + field + " (see molten docs: pipeline-format.md)"
	}
	return msg
}

// ValidatePipeline reads and checks a project's `.molten/project.json`. It never runs a declared command.
func ValidatePipeline(dir string) PipelineReport {
	report := PipelineReport{Path: filepath.Join(dir, ProjectPipelineFile), Errors: []string{}, Warnings: []string{}}
	data, err := os.ReadFile(report.Path)
	if os.IsNotExist(err) {
		return report
	}
	report.Present = true
	if err != nil {
		report.Errors = append(report.Errors, err.Error())
		return report
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var pipeline Pipeline
	if err := decoder.Decode(&pipeline); err != nil {
		report.Errors = append(report.Errors, unknownFieldError(err))
		return report
	}
	checker := &pipelineChecker{dir: dir, report: &report}
	checker.check(&pipeline)
	sort.Strings(report.Warnings)
	report.Pipeline = &pipeline
	report.Valid = len(report.Errors) == 0
	return report
}
