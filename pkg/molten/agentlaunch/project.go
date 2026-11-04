// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package agentlaunch

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// A project with a folder for its context and a code repository inside it (FR-SHELL-105) starts its agents in the
// repository, with the folder as an extra working directory and a short note on where each is (FR-SHELL-036,
// FR-SHELL-038). It is the same for both agents: Claude Code takes --add-dir and --append-system-prompt (the `=` form,
// so a prompt after them is not read as one more directory), Codex takes --add-dir and
// -c developer_instructions (codex --help, 0.163.0: "Additional directories that should be writable alongside the
// primary workspace"; the configuration reference: "Additional developer instructions injected into the session").
// Nothing is added for a terminal outside the project folder, nor for a project whose folder is its repository.

// ProjectPlaces are the two places of the terminal's workspace project, as wavesrv holds them.
type ProjectPlaces struct {
	Folder string
	Repo   string
}

// ProjectPlan is what the project adds to a run: arguments put before the user's, the items for the report, and the
// folder the run starts in when it is not the terminal's.
type ProjectPlan struct {
	Args      []string
	ShownArgs []string
	Added     []molten.IntegrationItem
	Skipped   []molten.IntegrationItem
	StartDir  string
}

// ProjectAdapter is implemented by an adapter whose agent takes the project's places.
type ProjectAdapter interface {
	PlanProject(ctx LaunchContext) ProjectPlan
}

// WithProject adds what the project brings to a plan. The project's arguments go first, before whatever the plan
// makes of the user's own (userArgs, when the plan makes none); a plan that stepped aside takes nothing.
func (p LaunchPlan) WithProject(pp ProjectPlan, userArgs []string) LaunchPlan {
	if p.StepAside != "" {
		return p
	}
	p.Added = append(p.Added, pp.Added...)
	p.Skipped = append(p.Skipped, pp.Skipped...)
	p.StartDir = pp.StartDir
	if len(pp.Args) == 0 {
		return p
	}
	inner := p.MakeArgs
	p.MakeArgs = func(paths []string) []string {
		base := userArgs
		if inner != nil {
			base = inner(paths)
		}
		rtn := make([]string, 0, len(pp.Args)+len(base))
		rtn = append(rtn, pp.Args...)
		return append(rtn, base...)
	}
	p.ShownArgs = append(append([]string{}, pp.ShownArgs...), p.ShownArgs...)
	return p
}

const (
	addDirFlag             = "--add-dir"
	claudeAppendPromptFlag = "--append-system-prompt"
	claudeAppendFileFlag   = "--append-system-prompt-file"
	codexDeveloperKey      = "developer_instructions"
)

var (
	projectNoteName = say(uimsg.Make("integration.name.projectnote"), "Start note: where the project's context and code are")
	yoursAddDir     = say(uimsg.Make("integration.reason.alreadyyoursadddir"), "already yours, in your "+addDirFlag)
)

func projectFolderName(folder string) phrase {
	return say(uimsg.Make("integration.name.projectfolder", "folder", folder), "Project folder as an extra working directory ("+folder+")")
}

func projectStartName(repo string) phrase {
	return say(uimsg.Make("integration.name.projectstart", "repo", repo), "Started in the project's repository ("+repo+")")
}

func projectRepoGone(repo string) phrase {
	return say(uimsg.Make("integration.reason.projectrepogone", "repo", repo), "the project's repository "+repo+" was not found")
}

func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// realPath resolves symbolic links when it can: a terminal's folder and the one the project was linked with may name
// the same place differently.
func realPath(path string) string {
	if real, err := filepath.EvalSymlinks(path); err == nil {
		return real
	}
	return filepath.Clean(path)
}

func insideFolder(path string, folder string) bool {
	return molten.CheckPathInside(path, folder) || molten.CheckPathInside(realPath(path), realPath(folder))
}

func sameFolder(a string, b string) bool {
	return filepath.Clean(a) == filepath.Clean(b) || realPath(a) == realPath(b)
}

// Separate tells whether the project has a code repository of its own, inside its folder.
func (p ProjectPlaces) Separate() bool {
	return filepath.IsAbs(p.Folder) && filepath.IsAbs(p.Repo) && molten.ProjectRepoOf(p.Folder, p.Repo) != p.Folder
}

// ProjectNote is the start note: short, in English (it is for the agent), with both places named.
func ProjectNote(p ProjectPlaces) string {
	return "This is a MoltenTerm project with two places. The project folder " + p.Folder +
		" holds the context (documents, mails, specs). The code repository " + p.Repo +
		" holds the code, git, tests and CI: do the code work there, and read the project folder when you need the context."
}

// planProjectCommon decides what the project adds for a run started from ctx.Cwd: ok is false when it adds nothing.
// The run starts in the repository when the terminal sits in the project folder itself.
func planProjectCommon(ctx LaunchContext) (ProjectPlan, bool) {
	var plan ProjectPlan
	p := ctx.Project
	if !p.Separate() || !insideFolder(ctx.Cwd, p.Folder) || !isDir(p.Folder) {
		return plan, false
	}
	if !isDir(p.Repo) {
		plan.Skipped = append(plan.Skipped, skippedItem(molten.IntegrationProjectFolder, projectFolderName(p.Folder), projectRepoGone(p.Repo)))
		return plan, false
	}
	if sameFolder(ctx.Cwd, p.Folder) {
		plan.StartDir = filepath.Clean(p.Repo)
		plan.Added = append(plan.Added, addedItem(molten.IntegrationProjectStart, projectStartName(p.Repo)))
	}
	return plan, true
}

// optionValues reads every value of --name in args, in the `--name value` and `--name=value` forms, up to "--".
// greedy: Claude Code's --add-dir takes several values, up to the next option.
func optionValues(args []string, name string, greedy bool) []string {
	var rtn []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			break
		}
		if value, ok := strings.CutPrefix(arg, name+"="); ok {
			rtn = append(rtn, value)
			continue
		}
		if arg != name {
			continue
		}
		for i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
			i++
			rtn = append(rtn, args[i])
			if !greedy {
				break
			}
		}
	}
	return rtn
}

func hasOption(args []string, names ...string) bool {
	for _, arg := range args {
		if arg == "--" {
			break
		}
		for _, name := range names {
			if arg == name || strings.HasPrefix(arg, name+"=") {
				return true
			}
		}
	}
	return false
}

// coversFolder tells whether one of the user's own directories is the project folder or holds it.
func coversFolder(dirs []string, folder string, cwd string) bool {
	for _, d := range dirs {
		if !filepath.IsAbs(d) {
			d = filepath.Join(cwd, d)
		}
		if insideFolder(folder, d) {
			return true
		}
	}
	return false
}

func (claudeAdapter) PlanProject(ctx LaunchContext) ProjectPlan {
	plan, ok := planProjectCommon(ctx)
	if !ok {
		return plan
	}
	p := ctx.Project
	if coversFolder(optionValues(ctx.Args, addDirFlag, true), p.Folder, ctx.Cwd) {
		plan.Skipped = append(plan.Skipped, skippedItem(molten.IntegrationProjectFolder, projectFolderName(p.Folder), yoursAddDir))
	} else {
		arg := addDirFlag + "=" + p.Folder
		plan.Args = append(plan.Args, arg)
		plan.ShownArgs = append(plan.ShownArgs, arg)
		plan.Added = append(plan.Added, addedItem(molten.IntegrationProjectFolder, projectFolderName(p.Folder)))
	}
	if hasOption(ctx.Args, claudeAppendPromptFlag, claudeAppendFileFlag) {
		plan.Skipped = append(plan.Skipped, skippedItem(molten.IntegrationProjectNote, projectNoteName,
			say(uimsg.Make("integration.reason.alreadyyoursflag", "flag", claudeAppendPromptFlag), "already yours, in your "+claudeAppendPromptFlag)))
		return plan
	}
	plan.Args = append(plan.Args, claudeAppendPromptFlag+"="+ProjectNote(p))
	plan.ShownArgs = append(plan.ShownArgs, claudeAppendPromptFlag+"=<start note>")
	plan.Added = append(plan.Added, addedItem(molten.IntegrationProjectNote, projectNoteName))
	return plan
}

func (codexAdapter) PlanProject(ctx LaunchContext) ProjectPlan {
	plan, ok := planProjectCommon(ctx)
	if !ok {
		return plan
	}
	p := ctx.Project
	args := parseCodexArgs(ctx.Args)
	if coversFolder(optionValues(ctx.Args, addDirFlag, false), p.Folder, ctx.Cwd) {
		plan.Skipped = append(plan.Skipped, skippedItem(molten.IntegrationProjectFolder, projectFolderName(p.Folder), yoursAddDir))
	} else {
		plan.Args = append(plan.Args, addDirFlag, p.Folder)
		plan.ShownArgs = append(plan.ShownArgs, addDirFlag, p.Folder)
		plan.Added = append(plan.Added, addedItem(molten.IntegrationProjectFolder, projectFolderName(p.Folder)))
	}
	where := ""
	if args.overridesKey(codexDeveloperKey) {
		where = "-c " + codexDeveloperKey
	} else {
		// The project files Codex reads are those of the folder it starts in.
		configCtx := ctx
		if plan.StartDir != "" {
			configCtx.Cwd = plan.StartDir
		}
		where = readCodexConfig(configCtx, args.profile).setsKey(codexDeveloperKey)
	}
	if where != "" {
		plan.Skipped = append(plan.Skipped, skippedItem(molten.IntegrationProjectNote, projectNoteName, alreadyYours(where)))
		return plan
	}
	plan.Args = append(plan.Args, codexConfigFlag, codexDeveloperKey+"="+tomlString(ProjectNote(p)))
	plan.ShownArgs = append(plan.ShownArgs, codexConfigFlag, codexDeveloperKey+"=<start note>")
	plan.Added = append(plan.Added, addedItem(molten.IntegrationProjectNote, projectNoteName))
	return plan
}
