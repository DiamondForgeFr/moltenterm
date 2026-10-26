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
	"github.com/wavetermdev/waveterm/pkg/molten/versions"
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
	// The project's documentation language (.saasfoundry.json language.srs); "" or an unknown one writes English.
	Lang string
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

// Product names stay as they are; the others are worded (target.<id>).
var targetNames = map[string]string{
	"npm": "npm", "githubrelease": "GitHub Release", "pages": "GitHub Pages", "appimage": "AppImage", "snap": "Snap",
}

var wordedTargets = map[string]bool{
	"container": true, "msi": true, "nsis": true, "dmg": true, "appx": true, "linux": true, "deb": true, "rpm": true, "pacman": true,
}

func (w docWords) targetName(id string) string {
	key := strings.ToLower(id)
	if name, ok := targetNames[key]; ok {
		return name
	}
	if wordedTargets[key] {
		return w.s("target." + key)
	}
	return id
}

// channelKey: the words' suffix of a channel ("rc", "pub").
func channelKey(channel string) string {
	if channel == ChannelRc {
		return "rc"
	}
	return "pub"
}

func (w docWords) channelTitle(channel string) string {
	return w.s("channel." + channelKey(channel))
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

// rcPatternOf: how the documented project's candidates read (versions.rcformat).
func rcPatternOf(in TechDocInput) string {
	rules := versions.Rules{RcFormat: in.Facts.RcFormat}
	if p := in.Pipeline; p != nil && p.Versions != nil {
		rules.RcFormat = p.Versions.RcFormat
	}
	return rules.RcPattern()
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

func (w docWords) stepWho(s molten.PipelineStep) string {
	if s.Manual != "" {
		return w.s("who.hand")
	}
	return "MoltenTerm"
}

func (w docWords) stepWhat(s molten.PipelineStep) string {
	if s.Manual != "" {
		return mdCell(s.Manual)
	}
	text := mdCode(s.Run)
	if s.Notes {
		text += w.s("what.notes")
	}
	if s.Check != nil {
		text += w.f("what.checked", mdCode(s.Check.Path), mdCode(s.Check.Contains))
	}
	return text
}

func writeDiagram(out *strings.Builder, in TechDocInput, w docWords, channels []string) {
	trunk, _ := releaseBranches(in)
	prefix := tagPrefixOf(in)
	out.WriteString("```mermaid\nflowchart LR\n")
	for _, channel := range channels {
		steps := docSteps(in.Pipeline, channel)
		if len(steps) == 0 {
			continue
		}
		fmt.Fprintf(out, "  subgraph %s[\"%s\"]\n    direction LR\n", diagramId(channel), diagramLabel(w.channelTitle(channel)))
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
				fmt.Fprintf(out, "    %s[/\"%s\"/]\n", id, w.f("diagram.hand", label))
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
				label += w.s("diagram.approval") + strings.Join(wf.Environments, ", ")
			}
			fmt.Fprintf(out, "  %s[\"%s\"]\n  %s -. %s .-> %s\n", id, diagramLabel(label), tagNode, w.s("diagram.starts"), id)
			for _, ship := range wf.Ships {
				target := diagramId(channel, "to", ship)
				fmt.Fprintf(out, "  %s[(\"%s\")]\n  %s --> %s\n", target, diagramLabel(w.targetName(ship)), id, target)
			}
		}
	}
	out.WriteString("```\n")
}

func writeOverview(out *strings.Builder, in TechDocInput, w docWords, o Options) {
	trunk, release := releaseBranches(in)
	prefix := tagPrefixOf(in)
	kind := w.s("kind.dist")
	if in.Facts.Kind == KindSaas {
		kind = w.s("kind.saas")
	}
	model := w.s("model.promote")
	switch {
	case trunk == release || o.BranchModel == BranchModelSingle:
		model = w.s("model.single")
	case o.BranchModel == BranchModelRcPr:
		model = w.f("model.rcpr", mdCode(o.Merge))
	}
	out.WriteString(w.f("ov.kind", kind))
	out.WriteString(w.f("ov.trunk", mdCode(trunk), mdCode(release), model))
	out.WriteString(w.f("ov.tags", mdCode(prefix+"X.Y.Z"), mdCode(prefix+rcPatternOf(in))))
	var targets []string
	seen := map[string]bool{}
	for _, t := range in.Facts.Targets {
		if !seen[t.Id] {
			seen[t.Id] = true
			targets = append(targets, w.targetName(t.Id))
		}
	}
	for _, wf := range in.Facts.Workflows {
		for _, ship := range wf.Ships {
			if !seen[ship] {
				seen[ship] = true
				targets = append(targets, w.targetName(ship))
			}
		}
	}
	if len(targets) > 0 {
		out.WriteString(w.f("ov.targets", strings.Join(targets, ", ")))
	}
}

func writeHeading(out *strings.Builder, text string) {
	out.WriteString("\n## " + text + "\n\n")
}

func writeBranches(out *strings.Builder, in TechDocInput, w docWords) {
	trunk, release := releaseBranches(in)
	writeHeading(out, w.s("br.title"))
	out.WriteString(w.f("br.trunk", mdCode(trunk)))
	if release != trunk {
		out.WriteString(w.f("br.release", mdCode(release)))
	}
	if in.Facts.RcBranchPattern != "" {
		out.WriteString(w.f("br.rc", mdCode(in.Facts.RcBranchPattern)))
	}
	p := in.Facts.Protection
	if p == nil {
		out.WriteString(w.s("br.notRead"))
		return
	}
	if !p.Read {
		out.WriteString(w.f("br.unread", mdCode(p.Branch)))
		if p.Error != "" {
			fmt.Fprintf(out, " (%s)", mdCell(p.Error))
		}
		out.WriteString(".\n")
		return
	}
	if !p.PullRequest && len(p.RequiredChecks) == 0 && !p.RestrictUpdates && !p.NoForcePush {
		out.WriteString(w.f("br.unprotected", mdCode(p.Branch)))
		return
	}
	out.WriteString(w.f("br.protection", mdCode(p.Branch)))
	if p.PullRequest {
		out.WriteString(w.s("br.pr"))
	}
	if len(p.RequiredChecks) > 0 {
		out.WriteString(w.f("br.checks", mdCodeList(p.RequiredChecks)))
		if p.Strict {
			out.WriteString(w.s("br.strict"))
		}
		out.WriteString(w.s("br.end"))
	}
	if p.RestrictUpdates {
		out.WriteString(w.s("br.restricted"))
	}
	if p.NoForcePush {
		out.WriteString(w.s("br.noForce"))
	}
	if len(p.MergeMethods) > 0 {
		out.WriteString(w.f("br.methods", mdCodeList(p.MergeMethods)))
	}
	switch p.Bypass {
	case BypassAlways:
		out.WriteString(w.s("br.bypassAlways"))
	case BypassPullRequestsOnly:
		out.WriteString(w.s("br.bypassPr"))
	default:
		out.WriteString(w.s("br.bypassNone"))
	}
	var sources []string
	for _, src := range p.Sources {
		switch src.Code {
		case "ruleset":
			sources = append(sources, w.f("br.ruleset", mdCode(src.Path)))
		case "classicProtection":
			sources = append(sources, w.s("br.classic"))
		default:
			sources = append(sources, mdCell(src.Code))
		}
	}
	if len(sources) > 0 {
		out.WriteString(w.f("br.readFrom", strings.Join(sources, w.s("br.and"))))
	}
}

func writeFlow(out *strings.Builder, in TechDocInput, w docWords, channel string) {
	steps := docSteps(in.Pipeline, channel)
	writeHeading(out, w.s("flow."+channelKey(channel)))
	if len(steps) == 0 {
		out.WriteString(w.s("flow.none"))
		return
	}
	out.WriteString(w.s("flow.head"))
	for i, s := range steps {
		phase := s.Phase
		if phase == "" {
			phase = "—"
		}
		confirm := mdCell(s.Confirm)
		if confirm == "" {
			confirm = "—"
		}
		fmt.Fprintf(out, "| %d | %s | %s | %s | %s | %s |\n", i+1, mdCell(phase), mdCell(s.Title), w.stepWho(s), w.stepWhat(s), confirm)
	}
	manual := 0
	for _, s := range steps {
		if s.Manual != "" {
			manual++
		}
	}
	out.WriteString(w.f("flow.summary", len(steps), len(steps)-manual, manual))
}

func (w docWords) triggersOf(wf Workflow) string {
	var parts []string
	if wf.Push {
		switch {
		case wf.Tags != nil && wf.Branches != nil:
			parts = append(parts, w.f("trig.tagsOr", mdCodeList(wf.Tags), mdCodeList(wf.Branches)))
		case wf.Tags != nil:
			parts = append(parts, w.f("trig.tags", mdCodeList(wf.Tags)))
		case wf.Branches != nil:
			parts = append(parts, w.f("trig.branches", mdCodeList(wf.Branches)))
		default:
			parts = append(parts, w.s("trig.every"))
		}
	}
	if wf.PullRequest {
		parts = append(parts, w.s("trig.pr"))
	}
	if wf.Dispatch {
		text := w.s("trig.dispatch")
		if len(wf.RequiredInputs) > 0 {
			text += w.f("trig.inputs", mdCodeList(wf.RequiredInputs))
		}
		parts = append(parts, text)
	}
	if len(parts) == 0 {
		return "—"
	}
	return strings.Join(parts, "; ")
}

func writeWorkflows(out *strings.Builder, in TechDocInput, w docWords) {
	writeHeading(out, w.s("wf.title"))
	if len(in.Facts.Workflows) == 0 {
		out.WriteString(w.f("wf.none", mdCode(WorkflowsDir)))
	} else {
		out.WriteString(w.s("wf.head"))
		for _, wf := range in.Facts.Workflows {
			ships := make([]string, len(wf.Ships))
			for i, s := range wf.Ships {
				ships[i] = w.targetName(s)
			}
			shipText := strings.Join(ships, ", ")
			if shipText == "" {
				shipText = "—"
			}
			name := mdCell(wf.Name)
			if name == "" {
				name = "—"
			}
			fmt.Fprintf(out, "| %s | %s | %s | %s | %s | %s |\n", mdCode(WorkflowsDir+"/"+wf.File), name, wf.Role, w.triggersOf(wf), mdCodeList(wf.Environments), shipText)
		}
	}
	if p := in.Pipeline; p != nil && p.Ci != nil && len(p.Ci.Jobs) > 0 {
		out.WriteString(w.s("wf.local"))
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

func writeApprovals(out *strings.Builder, in TechDocInput, w docWords) {
	writeHeading(out, w.s("ap.title"))
	found := false
	for _, wf := range in.Facts.Workflows {
		for _, env := range wf.Environments {
			found = true
			out.WriteString(w.f("ap.env", mdCode(env), mdCode(wf.File)))
		}
	}
	for _, channel := range []string{ChannelRc, ChannelPublic} {
		for _, s := range docSteps(in.Pipeline, channel) {
			if s.Confirm != "" && s.Id == "tag" {
				found = true
				out.WriteString(w.f("ap.confirm", w.channelTitle(channel), mdCode(s.Id)))
			}
		}
	}
	if !found {
		out.WriteString(w.s("ap.none"))
	}
}

func writeTargets(out *strings.Builder, in TechDocInput, w docWords) {
	writeHeading(out, w.s("tg.title"))
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
		fmt.Fprintf(out, "- %s", w.targetName(id))
		var parts []string
		if b, ok := built[id]; ok && b != "" && b != "workflow" {
			parts = append(parts, w.f("tg.built", b))
		}
		if len(published[id]) > 0 {
			parts = append(parts, w.f("tg.published", strings.Join(published[id], ", ")))
		}
		if len(parts) > 0 {
			out.WriteString(": " + strings.Join(parts, ", "))
		}
		out.WriteString(".\n")
	}
	for _, d := range in.Facts.DeployTargets() {
		found = true
		out.WriteString(w.f("tg.env", mdCode(d.Environment), mdCode(d.Workflow)))
	}
	if !found {
		out.WriteString(w.s("tg.none"))
	}
}

func writeSyncBack(out *strings.Builder, in TechDocInput, w docWords) {
	trunk, release := releaseBranches(in)
	writeHeading(out, w.s("sb.title"))
	if s, ok := stepById(docSteps(in.Pipeline, ChannelPublic), "sync-back"); ok {
		out.WriteString(w.f("sb.step", mdCell(s.Title), mdCode(release), mdCode(trunk), mdCode(s.Run)))
		if s.Confirm != "" {
			fmt.Fprintf(out, " %s", mdCell(s.Confirm))
		}
		out.WriteString("\n")
		return
	}
	if trunk == release {
		out.WriteString(w.s("sb.single"))
		return
	}
	out.WriteString(w.f("sb.none", mdCode(release), mdCode(trunk)))
}

func writeVersions(out *strings.Builder, in TechDocInput, w docWords) {
	writeHeading(out, w.s("ver.title"))
	v := &molten.PipelineVersions{}
	if in.Pipeline != nil && in.Pipeline.Versions != nil {
		v = in.Pipeline.Versions
	}
	if len(v.Files) == 0 {
		out.WriteString(w.s("ver.none"))
	} else {
		out.WriteString(w.s("ver.head"))
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
		out.WriteString(w.f("ver.changelogs", mdCodeList(v.Changelogs)))
	}
	notes := v.Notes
	if notes == "" {
		notes = DefaultNotesPath
	}
	out.WriteString(w.f("ver.notes", mdCode(notes)))
	if v.FirstPublic != "" {
		out.WriteString(w.f("ver.first", mdCode(v.FirstPublic)))
	}
	if v.Format != "" {
		out.WriteString(w.f("ver.format", mdCode(v.Format)))
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
	heads := historyHeads()
	for _, line := range strings.Split(doc[start+len(techDocHistoryStart):end], "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "|") || heads[line] || line == techDocHistoryRule {
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

func historyRow(c TechDocChange, repo string, w docWords) string {
	kind := w.s("hist.setup")
	if c.Kind == TechDocChangeUpdate {
		kind = w.s("hist.update")
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

func writeHistory(out *strings.Builder, in TechDocInput, w docWords) {
	writeHeading(out, w.s("hist.title"))
	out.WriteString(techDocHistoryStart + "\n" + w.s("hist.head") + "\n" + techDocHistoryRule + "\n")
	rows := []string{historyRow(in.Change, in.Repo, w)}
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
	w := wordsOf(in.Lang)
	fmt.Fprintf(&out, "# %s: %s\n\n", w.s("title"), mdCell(name))
	out.WriteString(w.f("generated", mdCode(molten.ProjectPipelineFile)))
	o := InferOptions(in.Facts, in.Pipeline)
	out.WriteString("## " + w.s("overview") + "\n\n")
	writeOverview(&out, in, w, o)
	var channels []string
	for _, c := range []string{ChannelRc, ChannelPublic} {
		if len(docSteps(in.Pipeline, c)) > 0 {
			channels = append(channels, c)
		}
	}
	writeHeading(&out, w.s("diagram"))
	if len(channels) == 0 {
		out.WriteString(w.s("noFlow"))
	} else {
		writeDiagram(&out, in, w, channels)
		out.WriteString(w.s("legend"))
	}
	writeBranches(&out, in, w)
	writeFlow(&out, in, w, ChannelRc)
	writeFlow(&out, in, w, ChannelPublic)
	prefix := tagPrefixOf(in)
	writeHeading(&out, w.s("tags"))
	out.WriteString(w.f("tags.public", mdCode(prefix+"X.Y.Z"), mdCode("tag")))
	out.WriteString(w.f("tags.rc", mdCode(prefix+rcPatternOf(in))))
	for _, channel := range channels {
		starts := tagStarts(in.Facts, channel, prefix)
		files := make([]string, len(starts))
		for i, wf := range starts {
			files[i] = wf.File
		}
		sort.Strings(files)
		if len(files) == 0 {
			out.WriteString(w.s("tags.none." + channelKey(channel)))
			continue
		}
		out.WriteString(w.f("tags.starts."+channelKey(channel), mdCodeList(files)))
	}
	writeWorkflows(&out, in, w)
	writeApprovals(&out, in, w)
	writeTargets(&out, in, w)
	writeSyncBack(&out, in, w)
	writeVersions(&out, in, w)
	writeHistory(&out, in, w)
	return out.String()
}
