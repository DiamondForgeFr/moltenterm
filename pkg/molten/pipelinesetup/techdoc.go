// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"fmt"
	"net/url"
	"path"
	"path/filepath"
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
	// The fallback when no documentation backend is declared or reachable: outside any docs site (a site building all of
	// docs/ would publish it), unless the pipeline's techdoc key says otherwise (#1226).
	TechDocPath = ".molten/release-pipeline.md"
	// The default path before #1226: a generated document found there is moved to the configured path.
	LegacyTechDocPath = "docs/engineering/release-pipeline.md"

	TechDocChangeSetup  = "setup"
	TechDocChangeUpdate = "update"

	// The history is carried from one version of the document to the next between these markers.
	techDocHistoryStart = "<!-- molten:history -->"
	techDocHistoryEnd   = "<!-- /molten:history -->"
	techDocHistoryHead  = "| Date | Change | By | Pull request | MoltenTerm template |"
	techDocHistoryRule  = "| --- | --- | --- | --- | --- |"

	maxTechDocBytes   = 512 << 10
	maxTechDocHistory = 200
	maxDiagramLabel   = 48
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

// TechDocPathOf: where the repository document goes: the pipeline's techdoc key (validated), else TechDocPath.
func TechDocPathOf(p *molten.Pipeline) string {
	if p == nil || strings.TrimSpace(p.TechDoc) == "" {
		return TechDocPath
	}
	return path.Clean(filepath.ToSlash(strings.TrimSpace(p.TechDoc)))
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
	return diagramLabelMax(text, maxDiagramLabel)
}

func diagramLabelMax(text string, max int) string {
	text = strings.Join(strings.Fields(text), " ")
	if r := []rune(text); len(r) > max {
		text = strings.TrimSpace(string(r[:max-1])) + "…"
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

// docPhases: the phase shown for each step. A step without one takes the phase of the step it runs beside (the notes
// rewrite sits between the changelogs and the cut: cut); a list that declares none is read as the release goes: the
// first step prepares, the others cut up to the tag, and what follows the tag comes back to the trunk.
func docPhases(steps []molten.PipelineStep) []string {
	phases := molten.ReleaseStepPhase(steps)
	tagged := false
	for i, s := range steps {
		if phases[i] == "" {
			switch {
			case s.Notes:
				phases[i] = nextPhase(steps, phases, i)
			case tagged:
				phases[i] = "back"
			default:
				phases[i] = "cut"
			}
		}
		tagged = tagged || s.Id == "tag"
	}
	return phases
}

func nextPhase(steps []molten.PipelineStep, phases []string, from int) string {
	for i := from + 1; i < len(steps); i++ {
		if phases[i] != "" && !steps[i].Notes {
			return phases[i]
		}
	}
	for i := from - 1; i >= 0; i-- {
		if phases[i] != "" {
			return phases[i]
		}
	}
	return "cut"
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
		chain := []string{fmt.Sprintf("%s([\"%s\"])", diagramId(channel, "trunk"), diagramLabel(trunk))}
		tagNode := ""
		for i, s := range steps {
			id := diagramId(channel, strconv.Itoa(i+1))
			label := diagramLabel(s.Title)
			if label == "" {
				label = diagramLabel(s.Id)
			}
			switch {
			case s.Manual != "":
				chain = append(chain, fmt.Sprintf("%s[/\"%s\"/]", id, w.f("diagram.hand", label)))
			case s.Id == "tag":
				chain = append(chain, fmt.Sprintf("%s{{\"%s\"}}", id, label))
				tagNode = id
			default:
				chain = append(chain, fmt.Sprintf("%s[\"%s\"]", id, label))
			}
		}
		out.WriteString("    " + strings.Join(chain, " --> ") + "\n  end\n")
		if tagNode == "" {
			continue
		}
		for _, wf := range tagStarts(in.Facts, channel, prefix) {
			label := wf.File
			if len(wf.Environments) > 0 {
				label += w.s("diagram.approval") + strings.Join(wf.Environments, ", ")
			}
			fmt.Fprintf(out, "  %s -. %s .-> %s[\"%s\"]", tagNode, w.s("diagram.starts"), diagramId(channel, "wf", wf.File), diagramLabelMax(label, 4*maxDiagramLabel))
			var ships []string
			for _, ship := range wf.Ships {
				ships = append(ships, fmt.Sprintf("%s[(\"%s\")]", diagramId(channel, "to", ship), diagramLabel(w.targetName(ship))))
			}
			if len(ships) > 0 {
				out.WriteString(" --> " + strings.Join(ships, " & "))
			}
			out.WriteString("\n")
		}
	}
	out.WriteString("```\n")
}

func writeFlow(out *strings.Builder, in TechDocInput, w docWords, channel string) {
	steps := docSteps(in.Pipeline, channel)
	writeHeading(out, w.s("flow."+channelKey(channel)))
	if len(steps) == 0 {
		out.WriteString(w.s("flow.none"))
		return
	}
	out.WriteString(w.s("flow.head"))
	phases := docPhases(steps)
	for i, s := range steps {
		confirm := mdCell(s.Confirm)
		if confirm == "" {
			confirm = "—"
		}
		fmt.Fprintf(out, "| %d | %s | %s | %s | %s |\n", i+1, phases[i], mdCell(s.Title), w.stepWho(s), confirm)
	}
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
	out.WriteString(w.f("ov.details", mdCode(molten.ProjectPipelineFile)))
}

func writeHeading(out *strings.Builder, text string) {
	out.WriteString("\n## " + text + "\n\n")
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
		text := c.PrUrl
		if n := numberOfUrl(c.PrUrl); n > 0 {
			text = "#" + strconv.Itoa(n)
		}
		return "[" + mdCell(text) + "](" + c.PrUrl + ")"
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
	writeFlow(&out, in, w, ChannelRc)
	writeFlow(&out, in, w, ChannelPublic)
	writeHistory(&out, in, w)
	return out.String()
}
