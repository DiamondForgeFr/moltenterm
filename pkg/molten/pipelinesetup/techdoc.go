// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The pipeline's technical documentation (FR-MC-043, #1107): how the project is built and shipped, generated once by
// BuildTechDoc from the validated pipeline and the facts the setup read, then handed to a backend adapter
// (techdocbackend.go) or carried as a Markdown file in the pipeline's pull request. It is never edited by hand: the
// next setup or update rebuilds it and shows the difference first.

const (
	TechDocTopicRelease = "release-pipeline"
	TechDocTitle        = "Release pipeline"
	// The fallback when no documentation backend is declared or reachable.
	TechDocPath = "docs/engineering/release-pipeline.md"

	TechDocChangeSetup  = "setup"
	TechDocChangeUpdate = "update"

	// The history is carried from one version of the document to the next between these markers.
	techDocHistoryStart = "<!-- molten:history -->"
	techDocHistoryEnd   = "<!-- /molten:history -->"
	techDocHistoryHead  = "| Date | Change | By | Pull request | MoltenTerm template |"
	techDocHistoryRule  = "| --- | --- | --- | --- | --- |"

	maxTechDocBytes   = 512 << 10
	maxTechDocHistory = 200
	maxDiagramLabel   = 60
)

// TechDocChange is the change the document is written for: one row of its history.
type TechDocChange struct {
	Date   string `json:"date"`
	Kind   string `json:"kind"`
	Author string `json:"author,omitempty"`
	// The pipeline pull request's branch, and its address once it is known.
	Branch   string `json:"branch,omitempty"`
	PrUrl    string `json:"prurl,omitempty"`
	Template int    `json:"template"`
}

type TechDocInput struct {
	Pipeline *molten.Pipeline
	Facts    Facts
	Change   TechDocChange
	// The document as it is now ("" when there is none): its history rows are kept.
	Previous string
	// The GitHub repository (owner/name or host/owner/name), for the links; "" writes none.
	Repo string
}

func mdCell(text string) string {
	text = strings.ReplaceAll(text, "\r", "")
	text = strings.ReplaceAll(text, "\n", "<br>")
	return strings.ReplaceAll(text, "|", "\\|")
}

func mdCode(text string) string {
	if text == "" {
		return ""
	}
	fence := "`"
	for strings.Contains(text, fence) {
		fence += "`"
	}
	if strings.HasPrefix(text, "`") || strings.HasSuffix(text, "`") {
		return fence + " " + text + " " + fence
	}
	return fence + text + fence
}

func mdCodeList(items []string) string {
	if len(items) == 0 {
		return "—"
	}
	parts := make([]string, len(items))
	for i, item := range items {
		parts[i] = mdCode(item)
	}
	return strings.Join(parts, ", ")
}

func diagramLabel(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if r := []rune(text); len(r) > maxDiagramLabel {
		text = strings.TrimSpace(string(r[:maxDiagramLabel-1])) + "…"
	}
	return strings.ReplaceAll(text, "\"", "#quot;")
}

func diagramId(parts ...string) string {
	var b strings.Builder
	for i, part := range parts {
		if i > 0 {
			b.WriteString("_")
		}
		for _, r := range part {
			if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
				b.WriteRune(r)
			} else {
				b.WriteString("_")
			}
		}
	}
	return b.String()
}

var targetNames = map[string]string{
	"npm": "npm", "githubrelease": "GitHub Release", "pages": "GitHub Pages", "container": "Container image",
	"msi": "MSI installer", "nsis": "NSIS installer", "dmg": "DMG image", "appx": "AppX package", "linux": "Linux packages",
	"appimage": "AppImage", "deb": "Debian package", "rpm": "RPM package", "snap": "Snap", "pacman": "Pacman package",
}

func targetName(id string) string {
	if name, ok := targetNames[strings.ToLower(id)]; ok {
		return name
	}
	return id
}

func channelTitle(channel string) string {
	if channel == ChannelRc {
		return "Release candidate"
	}
	return "Public release"
}

func releaseBranches(in TechDocInput) (string, string) {
	trunk, release := in.Facts.Branches.Trunk, in.Facts.Branches.Release
	if p := in.Pipeline; p != nil && p.Branches != nil {
		if p.Branches.Trunk != "" {
			trunk = p.Branches.Trunk
		}
		if p.Branches.Release != "" {
			release = p.Branches.Release
		}
	}
	if trunk == "" {
		trunk = "main"
	}
	if release == "" {
		release = trunk
	}
	return trunk, release
}

func tagPrefixOf(in TechDocInput) string {
	if p := in.Pipeline; p != nil && p.Versions != nil && p.Versions.TagPrefix != "" {
		return p.Versions.TagPrefix
	}
	if in.Facts.TagPrefix != "" {
		return in.Facts.TagPrefix
	}
	return "v"
}

func docSteps(p *molten.Pipeline, channel string) []molten.PipelineStep {
	if p == nil || p.Release == nil {
		return nil
	}
	if channel == ChannelRc {
		return p.Release.Rc
	}
	return p.Release.Public
}

// tagStarts: the workflows a channel's tag starts (publish and deploy, then its CI), each once.
func tagStarts(f Facts, channel string, prefix string) []Workflow {
	var rtn []Workflow
	seen := map[string]bool{}
	add := func(file string) {
		if seen[file] {
			return
		}
		seen[file] = true
		if wf, ok := workflowByFile(f, file); ok {
			rtn = append(rtn, wf)
		}
	}
	for _, wf := range tagWorkflowList(f, channel, prefix) {
		add(wf.File)
	}
	for _, file := range tagCiList(f, channel, prefix) {
		add(file)
	}
	return rtn
}

func stepWho(s molten.PipelineStep) string {
	if s.Manual != "" {
		return "By hand"
	}
	return "MoltenTerm"
}

func stepWhat(s molten.PipelineStep) string {
	if s.Manual != "" {
		return mdCell(s.Manual)
	}
	text := mdCode(s.Run)
	if s.Notes {
		text += " (writes the release notes)"
	}
	if s.Check != nil {
		text += "<br>Checked: " + mdCode(s.Check.Path) + " contains " + mdCode(s.Check.Contains)
	}
	return text
}

func writeDiagram(out *strings.Builder, in TechDocInput, channels []string) {
	trunk, _ := releaseBranches(in)
	prefix := tagPrefixOf(in)
	out.WriteString("```mermaid\nflowchart LR\n")
	for _, channel := range channels {
		steps := docSteps(in.Pipeline, channel)
		if len(steps) == 0 {
			continue
		}
		fmt.Fprintf(out, "  subgraph %s[\"%s\"]\n    direction LR\n", diagramId(channel), diagramLabel(channelTitle(channel)))
		start := diagramId(channel, "trunk")
		fmt.Fprintf(out, "    %s([\"%s\"])\n", start, diagramLabel(trunk))
		prev := start
		tagNode := ""
		for i, s := range steps {
			id := diagramId(channel, strconv.Itoa(i+1))
			label := diagramLabel(s.Title)
			if label == "" {
				label = diagramLabel(s.Id)
			}
			switch {
			case s.Manual != "":
				fmt.Fprintf(out, "    %s[/\"%s (by hand)\"/]\n", id, label)
			case s.Id == "tag":
				fmt.Fprintf(out, "    %s{{\"%s\"}}\n", id, label)
				tagNode = id
			default:
				fmt.Fprintf(out, "    %s[\"%s\"]\n", id, label)
			}
			fmt.Fprintf(out, "    %s --> %s\n", prev, id)
			prev = id
		}
		out.WriteString("  end\n")
		if tagNode == "" {
			continue
		}
		for _, wf := range tagStarts(in.Facts, channel, prefix) {
			id := diagramId(channel, "wf", wf.File)
			label := wf.File
			if len(wf.Environments) > 0 {
				label += " · approval: " + strings.Join(wf.Environments, ", ")
			}
			fmt.Fprintf(out, "  %s[\"%s\"]\n  %s -. tag starts .-> %s\n", id, diagramLabel(label), tagNode, id)
			for _, ship := range wf.Ships {
				target := diagramId(channel, "to", ship)
				fmt.Fprintf(out, "  %s[(\"%s\")]\n  %s --> %s\n", target, diagramLabel(targetName(ship)), id, target)
			}
		}
	}
	out.WriteString("```\n")
}

func writeOverview(out *strings.Builder, in TechDocInput, o Options) {
	trunk, release := releaseBranches(in)
	prefix := tagPrefixOf(in)
	kind := "distributed (versions are published)"
	if in.Facts.Kind == KindSaas {
		kind = "SaaS (deployed to environments)"
	}
	model := "the trunk is promoted onto the published branch, and the tag is made there"
	switch {
	case trunk == release || o.BranchModel == BranchModelSingle:
		model = "versions are tagged on the trunk itself"
	case o.BranchModel == BranchModelRcPr:
		model = "a release branch made from the trunk reaches the published branch by pull request (" + mdCode(o.Merge) + "), and the tag is made on the merge commit"
	}
	fmt.Fprintf(out, "- **Kind:** %s\n", kind)
	fmt.Fprintf(out, "- **Trunk:** %s · **published branch:** %s: %s.\n", mdCode(trunk), mdCode(release), model)
	fmt.Fprintf(out, "- **Tags:** public %s, release candidates %s.\n", mdCode(prefix+"X.Y.Z"), mdCode(prefix+"X.Y.Z-N"))
	var targets []string
	seen := map[string]bool{}
	for _, t := range in.Facts.Targets {
		if !seen[t.Id] {
			seen[t.Id] = true
			targets = append(targets, targetName(t.Id))
		}
	}
	for _, wf := range in.Facts.Workflows {
		for _, ship := range wf.Ships {
			if !seen[ship] {
				seen[ship] = true
				targets = append(targets, targetName(ship))
			}
		}
	}
	if len(targets) > 0 {
		fmt.Fprintf(out, "- **Published to:** %s.\n", strings.Join(targets, ", "))
	}
}

func writeBranches(out *strings.Builder, in TechDocInput) {
	trunk, release := releaseBranches(in)
	out.WriteString("\n## Branches and protection\n\n")
	fmt.Fprintf(out, "- %s: the trunk, where work is merged.\n", mdCode(trunk))
	if release != trunk {
		fmt.Fprintf(out, "- %s: the published branch, which carries the public versions.\n", mdCode(release))
	}
	if in.Facts.RcBranchPattern != "" {
		fmt.Fprintf(out, "- %s: the release branches, made from the trunk for each version.\n", mdCode(in.Facts.RcBranchPattern))
	}
	p := in.Facts.Protection
	if p == nil {
		out.WriteString("\nThe published branch's protection was not read.\n")
		return
	}
	if !p.Read {
		fmt.Fprintf(out, "\nThe protection of %s could not be read", mdCode(p.Branch))
		if p.Error != "" {
			fmt.Fprintf(out, " (%s)", mdCell(p.Error))
		}
		out.WriteString(".\n")
		return
	}
	if !p.PullRequest && len(p.RequiredChecks) == 0 && !p.RestrictUpdates && !p.NoForcePush {
		fmt.Fprintf(out, "\n%s is not protected.\n", mdCode(p.Branch))
		return
	}
	fmt.Fprintf(out, "\nProtection of %s:\n\n", mdCode(p.Branch))
	if p.PullRequest {
		out.WriteString("- changes arrive by pull request;\n")
	}
	if len(p.RequiredChecks) > 0 {
		fmt.Fprintf(out, "- required checks: %s", mdCodeList(p.RequiredChecks))
		if p.Strict {
			out.WriteString(" (the branch must be up to date)")
		}
		out.WriteString(";\n")
	}
	if p.RestrictUpdates {
		out.WriteString("- updates are restricted;\n")
	}
	if p.NoForcePush {
		out.WriteString("- force pushes are refused;\n")
	}
	if len(p.MergeMethods) > 0 {
		fmt.Fprintf(out, "- merge methods allowed: %s;\n", mdCodeList(p.MergeMethods))
	}
	switch p.Bypass {
	case BypassAlways:
		out.WriteString("- the developer who set the pipeline up may bypass it.\n")
	case BypassPullRequestsOnly:
		out.WriteString("- the developer who set the pipeline up may bypass it in pull requests only.\n")
	default:
		out.WriteString("- nobody bypasses it.\n")
	}
	var sources []string
	for _, src := range p.Sources {
		switch src.Code {
		case "ruleset":
			sources = append(sources, "the GitHub ruleset "+mdCode(src.Path))
		case "classicProtection":
			sources = append(sources, "GitHub's branch protection")
		default:
			sources = append(sources, mdCell(src.Code))
		}
	}
	if len(sources) > 0 {
		fmt.Fprintf(out, "\nRead from %s.\n", strings.Join(sources, " and "))
	}
}

func writeFlow(out *strings.Builder, in TechDocInput, channel string) {
	steps := docSteps(in.Pipeline, channel)
	fmt.Fprintf(out, "\n## %s flow\n\n", channelTitle(channel))
	if len(steps) == 0 {
		out.WriteString("Not set up.\n")
		return
	}
	out.WriteString("| # | Phase | Step | Who | What runs, or the instructions | Asks to confirm |\n| --- | --- | --- | --- | --- | --- |\n")
	for i, s := range steps {
		phase := s.Phase
		if phase == "" {
			phase = "—"
		}
		confirm := mdCell(s.Confirm)
		if confirm == "" {
			confirm = "—"
		}
		fmt.Fprintf(out, "| %d | %s | %s | %s | %s | %s |\n", i+1, mdCell(phase), mdCell(s.Title), stepWho(s), stepWhat(s), confirm)
	}
	manual := 0
	for _, s := range steps {
		if s.Manual != "" {
			manual++
		}
	}
	fmt.Fprintf(out, "\n%d steps: %d run by MoltenTerm (`molten release`), %d by hand. Each command asks for the developer's trust once; a step by hand is recorded done when the developer marks it.\n", len(steps), len(steps)-manual, manual)
}

func triggersOf(wf Workflow) string {
	var parts []string
	if wf.Push {
		switch {
		case wf.Tags != nil && wf.Branches != nil:
			parts = append(parts, "push of tags "+mdCodeList(wf.Tags)+" or to "+mdCodeList(wf.Branches))
		case wf.Tags != nil:
			parts = append(parts, "push of tags "+mdCodeList(wf.Tags))
		case wf.Branches != nil:
			parts = append(parts, "push to "+mdCodeList(wf.Branches))
		default:
			parts = append(parts, "every push")
		}
	}
	if wf.PullRequest {
		parts = append(parts, "pull requests")
	}
	if wf.Dispatch {
		text := "run by hand (workflow_dispatch)"
		if len(wf.RequiredInputs) > 0 {
			text += ", inputs " + mdCodeList(wf.RequiredInputs)
		}
		parts = append(parts, text)
	}
	if len(parts) == 0 {
		return "—"
	}
	return strings.Join(parts, "; ")
}

func writeWorkflows(out *strings.Builder, in TechDocInput) {
	out.WriteString("\n## CI workflows\n\n")
	if len(in.Facts.Workflows) == 0 {
		fmt.Fprintf(out, "No workflow in %s.\n", mdCode(WorkflowsDir))
	} else {
		out.WriteString("| Workflow | Name | Role | Triggers | Environments | Ships |\n| --- | --- | --- | --- | --- | --- |\n")
		for _, wf := range in.Facts.Workflows {
			ships := make([]string, len(wf.Ships))
			for i, s := range wf.Ships {
				ships[i] = targetName(s)
			}
			shipText := strings.Join(ships, ", ")
			if shipText == "" {
				shipText = "—"
			}
			name := mdCell(wf.Name)
			if name == "" {
				name = "—"
			}
			fmt.Fprintf(out, "| %s | %s | %s | %s | %s | %s |\n", mdCode(WorkflowsDir+"/"+wf.File), name, wf.Role, triggersOf(wf), mdCodeList(wf.Environments), shipText)
		}
	}
	if p := in.Pipeline; p != nil && p.Ci != nil && len(p.Ci.Jobs) > 0 {
		out.WriteString("\nLocal CI (`molten ci`), declared in `.molten/project.json`:\n\n| Job | Lane | Runs |\n| --- | --- | --- |\n")
		for _, job := range p.Ci.Jobs {
			title := job.Title
			if title == "" {
				title = job.Name
			}
			lane := job.Lane
			if lane == "" {
				lane = "—"
			}
			fmt.Fprintf(out, "| %s | %s | %s |\n", mdCell(title), mdCell(lane), mdCode(job.Run))
		}
	}
}

func writeApprovals(out *strings.Builder, in TechDocInput) {
	out.WriteString("\n## Approvals and environments\n\n")
	found := false
	for _, wf := range in.Facts.Workflows {
		for _, env := range wf.Environments {
			found = true
			fmt.Fprintf(out, "- %s (%s): GitHub applies the environment's protection rules (reviewers, wait timer) before the job runs; the release panel shows it waiting for approval.\n", mdCode(env), mdCode(wf.File))
		}
	}
	for _, channel := range []string{ChannelRc, ChannelPublic} {
		for _, s := range docSteps(in.Pipeline, channel) {
			if s.Confirm != "" && s.Id == "tag" {
				found = true
				fmt.Fprintf(out, "- %s, step %s: MoltenTerm asks the developer to confirm before running it.\n", channelTitle(channel), mdCode(s.Id))
			}
		}
	}
	if !found {
		out.WriteString("No environment approval; every step runs on the developer's click.\n")
	}
}

func writeTargets(out *strings.Builder, in TechDocInput) {
	out.WriteString("\n## Publish targets\n\n")
	found := false
	// One line per target: what builds it and what publishes it.
	var order []string
	built := map[string]string{}
	published := map[string][]string{}
	note := func(id string) {
		if _, ok := built[id]; !ok {
			if _, ok := published[id]; !ok {
				order = append(order, id)
			}
		}
	}
	for _, t := range in.Facts.Targets {
		note(t.Id)
		where := t.Source.Path
		if where == "" {
			where = t.Source.Detail
		}
		text := mdCell(t.Packager)
		if where != "" && !strings.HasPrefix(where, WorkflowsDir+"/") {
			text += " (" + mdCode(where) + ")"
		}
		built[t.Id] = text
	}
	for _, wf := range in.Facts.Workflows {
		for _, ship := range wf.Ships {
			note(ship)
			published[ship] = append(published[ship], mdCode(wf.File))
		}
	}
	for _, id := range order {
		found = true
		fmt.Fprintf(out, "- %s", targetName(id))
		var parts []string
		if b, ok := built[id]; ok && b != "" && b != "workflow" {
			parts = append(parts, "built by "+b)
		}
		if len(published[id]) > 0 {
			parts = append(parts, "published by "+strings.Join(published[id], ", "))
		}
		if len(parts) > 0 {
			out.WriteString(": " + strings.Join(parts, ", "))
		}
		out.WriteString(".\n")
	}
	for _, d := range in.Facts.DeployTargets() {
		found = true
		fmt.Fprintf(out, "- Environment %s, deployed by %s.\n", mdCode(d.Environment), mdCode(d.Workflow))
	}
	if !found {
		out.WriteString("No publish target detected: versions are tags only.\n")
	}
}

func writeSyncBack(out *strings.Builder, in TechDocInput) {
	trunk, release := releaseBranches(in)
	out.WriteString("\n## Sync-back\n\n")
	if s, ok := stepById(docSteps(in.Pipeline, ChannelPublic), "sync-back"); ok {
		fmt.Fprintf(out, "%s merges %s back into %s after a public release (%s).", mdCell(s.Title), mdCode(release), mdCode(trunk), mdCode(s.Run))
		if s.Confirm != "" {
			fmt.Fprintf(out, " %s", mdCell(s.Confirm))
		}
		out.WriteString("\n")
		return
	}
	if trunk == release {
		out.WriteString("None needed: versions are tagged on the trunk.\n")
		return
	}
	fmt.Fprintf(out, "No sync-back step: %s does not come back into %s by the release.\n", mdCode(release), mdCode(trunk))
}

func writeVersions(out *strings.Builder, in TechDocInput) {
	out.WriteString("\n## Version files and changelogs\n\n")
	v := &molten.PipelineVersions{}
	if in.Pipeline != nil && in.Pipeline.Versions != nil {
		v = in.Pipeline.Versions
	}
	if len(v.Files) == 0 {
		out.WriteString("No version file is declared: the version lives in the tags only.\n")
	} else {
		out.WriteString("The release writes the version into these files (the first one holds the project's current version):\n\n| File | Format | Where |\n| --- | --- | --- |\n")
		for _, f := range v.Files {
			where := mdCode(f.Pattern)
			if len(f.Keys) > 0 {
				keys := make([]string, len(f.Keys))
				for i, k := range f.Keys {
					keys[i] = strings.Join(k, ".")
				}
				where = mdCodeList(keys)
			}
			fmt.Fprintf(out, "| %s | %s | %s |\n", mdCode(f.Path), f.Format, where)
		}
	}
	if len(v.Changelogs) > 0 {
		fmt.Fprintf(out, "\nChangelogs, written by hand before the cut and committed with the version: %s.\n", mdCodeList(v.Changelogs))
	}
	notes := v.Notes
	if notes == "" {
		notes = DefaultNotesPath
	}
	fmt.Fprintf(out, "\nRelease notes: %s.", mdCode(notes))
	if v.FirstPublic != "" {
		fmt.Fprintf(out, " First public version: %s.", mdCode(v.FirstPublic))
	}
	if v.Format != "" {
		fmt.Fprintf(out, " Files the release writes are formatted with %s.", mdCode(v.Format))
	}
	out.WriteString("\n")
}

// previousHistory reads the history rows of an earlier document, newest first as written.
func previousHistory(doc string) []string {
	start := strings.Index(doc, techDocHistoryStart)
	end := strings.Index(doc, techDocHistoryEnd)
	if start < 0 || end < start {
		return nil
	}
	var rows []string
	for _, line := range strings.Split(doc[start+len(techDocHistoryStart):end], "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "|") || line == techDocHistoryHead || line == techDocHistoryRule {
			continue
		}
		rows = append(rows, line)
	}
	return rows
}

func prLink(c TechDocChange, repo string) string {
	if c.PrUrl != "" {
		return "[" + mdCell(c.PrUrl) + "](" + c.PrUrl + ")"
	}
	if c.Branch == "" {
		return "—"
	}
	if repo == "" {
		return mdCode(c.Branch)
	}
	host, path := "github.com", repo
	if parts := strings.Split(repo, "/"); len(parts) == 3 {
		host, path = parts[0], parts[1]+"/"+parts[2]
	}
	query := url.QueryEscape("is:pr head:" + c.Branch)
	return "[" + mdCode(c.Branch) + "](https://" + host + "/" + path + "/pulls?q=" + query + ")"
}

func historyRow(c TechDocChange, repo string) string {
	kind := "Pipeline set up"
	if c.Kind == TechDocChangeUpdate {
		kind = "Pipeline updated"
	}
	author := mdCell(c.Author)
	if author == "" {
		author = "—"
	}
	date := mdCell(c.Date)
	if date == "" {
		date = "—"
	}
	return fmt.Sprintf("| %s | %s | %s | %s | %d |", date, kind, author, prLink(c, repo), c.Template)
}

func writeHistory(out *strings.Builder, in TechDocInput) {
	out.WriteString("\n## Change history\n\n" + techDocHistoryStart + "\n" + techDocHistoryHead + "\n" + techDocHistoryRule + "\n")
	rows := []string{historyRow(in.Change, in.Repo)}
	for _, row := range previousHistory(in.Previous) {
		if row != rows[0] && len(rows) < maxTechDocHistory {
			rows = append(rows, row)
		}
	}
	for _, row := range rows {
		out.WriteString(row + "\n")
	}
	out.WriteString(techDocHistoryEnd + "\n")
}

// BuildTechDoc writes the document from the pipeline model: the same text for the same pipeline, facts and change, so
// the preview of step 3 is what the pull request carries.
func BuildTechDoc(in TechDocInput) string {
	var out strings.Builder
	name := in.Facts.Name
	if in.Pipeline != nil && in.Pipeline.Name != "" {
		name = in.Pipeline.Name
	}
	fmt.Fprintf(&out, "# %s: %s\n\n", TechDocTitle, mdCell(name))
	fmt.Fprintf(&out, "> Generated by MoltenTerm from %s with each pipeline setup or update; do not edit it by hand: the next update rewrites it, and shows the difference before writing.\n\n", mdCode(molten.ProjectPipelineFile))
	o := InferOptions(in.Facts, in.Pipeline)
	out.WriteString("## Overview\n\n")
	writeOverview(&out, in, o)
	var channels []string
	for _, c := range []string{ChannelRc, ChannelPublic} {
		if len(docSteps(in.Pipeline, c)) > 0 {
			channels = append(channels, c)
		}
	}
	out.WriteString("\n## Flow diagram\n\n")
	if len(channels) == 0 {
		out.WriteString("No release flow is set up.\n")
	} else {
		writeDiagram(&out, in, channels)
		out.WriteString("\nRounded: the trunk. Slanted: a step done by hand. Hexagon: the tag. Dotted: what the tag starts on GitHub. Cylinder: where versions are published.\n")
	}
	writeBranches(&out, in)
	writeFlow(&out, in, ChannelRc)
	writeFlow(&out, in, ChannelPublic)
	prefix := tagPrefixOf(in)
	out.WriteString("\n## Tags\n\n")
	fmt.Fprintf(&out, "- Public versions: %s, made by the public flow's %s step.\n", mdCode(prefix+"X.Y.Z"), mdCode("tag"))
	fmt.Fprintf(&out, "- Release candidates: %s (N counts from 1 for each version), made by the release candidate flow.\n", mdCode(prefix+"X.Y.Z-N"))
	for _, channel := range channels {
		starts := tagStarts(in.Facts, channel, prefix)
		files := make([]string, len(starts))
		for i, wf := range starts {
			files[i] = wf.File
		}
		sort.Strings(files)
		if len(files) == 0 {
			fmt.Fprintf(&out, "- A %s tag starts no workflow.\n", strings.ToLower(channelTitle(channel)))
			continue
		}
		fmt.Fprintf(&out, "- A %s tag starts %s.\n", strings.ToLower(channelTitle(channel)), mdCodeList(files))
	}
	writeWorkflows(&out, in)
	writeApprovals(&out, in)
	writeTargets(&out, in)
	writeSyncBack(&out, in)
	writeVersions(&out, in)
	writeHistory(&out, in)
	return out.String()
}
