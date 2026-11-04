// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/agentdocs"
)

// FR-MORPH-018 (TC-MORPH-024): the /morph guide follows the v7 flow, the same nine steps for every agent.

var morphV7Steps = []string{
	"Look first.",
	"Ask one to three questions, only about what is missing.",
	"Reformulate the request and give a plan scaled to it.",
	"Ask for trust when the user agrees to the plan.",
	"Open the design view when the installed version has it.",
	"Build live, with sample data first.",
	"Adjust through the conversation.",
	"Validate: name, icon, category.",
	"Your mods, and the report.",
}

var morphStepRegex = regexp.MustCompile(`(?m)^(\d)\. \*\*(.+?)\*\*`)

func squashSpaces(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

func morphGuideSource(t *testing.T) string {
	t.Helper()
	data, err := agentdocs.Files.ReadFile(agentdocs.GuideFile)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// sharedGuideLines are the lines of a guide that no agent block holds: every agent must render them.
func sharedGuideLines(body string) []string {
	var rtn []string
	keep := true
	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if agentBlockStartRegex.MatchString(trimmed) {
			keep = false
			continue
		}
		if trimmed == agentBlockOnlyEnd || trimmed == agentBlockNotEnd {
			keep = true
			continue
		}
		if keep && trimmed != "" && !strings.Contains(line, "{{") && !strings.Contains(line, `\`) {
			rtn = append(rtn, trimmed)
		}
	}
	return rtn
}

func TestMorphGuideHasTheV7StepsInOrderForEveryAgent(t *testing.T) {
	for _, p := range AgentProfiles {
		content, err := p.Render("1")
		if err != nil {
			t.Fatal(err)
		}
		var titles []string
		for i, match := range morphStepRegex.FindAllStringSubmatch(content, -1) {
			if match[1] != string(rune('1'+i)) {
				t.Errorf("%s: step %d is numbered %s", p.Id, i+1, match[1])
			}
			titles = append(titles, match[2])
		}
		if strings.Join(titles, "|") != strings.Join(morphV7Steps, "|") {
			t.Errorf("%s: the steps are %q, want %q", p.Id, titles, morphV7Steps)
		}
	}
}

func TestMorphGuideSharedTextReachesEveryAgent(t *testing.T) {
	shared := sharedGuideLines(morphGuideSource(t))
	if len(shared) < 60 {
		t.Fatalf("only %d shared lines: the parser lost the guide", len(shared))
	}
	for _, p := range AgentProfiles {
		content, err := p.Render("1")
		if err != nil {
			t.Fatal(err)
		}
		for _, line := range shared {
			if !strings.Contains(content, line) {
				t.Errorf("%s: the shared line is missing: %q", p.Id, line)
			}
		}
	}
}

func TestMorphGuideAsksFewQuestionsAndPlansToTheRequest(t *testing.T) {
	for _, p := range AgentProfiles {
		content, err := p.Render("1")
		if err != nil {
			t.Fatal(err)
		}
		flat := squashSpaces(content)
		for _, want := range []string{
			"At most three, in one message",
			"only about what is missing",
			`("fais-le", "just do it", "go ahead", or the same in any language) skips this step`,
			"It skips the questions only: the user still agrees to the plan",
			"a plan whose detail matches how precise the request was: a short request gets a short plan",
			"**What goes where**, by the split rule above",
			"**What the mod will access**, one per line: the files it reads or writes",
			"the MoltenTerm settings it reads or changes",
			"the sources and services it reaches",
			"Until they do, you create nothing and enable nothing.",
			"Speak to the user in the language of the conversation",
		} {
			if !strings.Contains(flat, want) {
				t.Errorf("%s: the guide lacks %q", p.Id, want)
			}
		}
	}
}

// DS-MORPH-014 and DS-MORPH-015 are written once, in the shared text, and every agent renders them.
func TestMorphGuideSplitAndTrustRulesAreWrittenOnce(t *testing.T) {
	rules := []string{
		"When in doubt, a piece goes in the MoltenTerm part.",
		"Never run `molten mod enable` before that agreement.",
		"Never widen the accesses silently.",
		"- **The MoltenTerm part** (`mod.json` and `main.js`): the data, the interface, and anything that serves every agent.",
		"- **The agent part**: only what lives inside one agent session",
	}
	source := squashSpaces(morphGuideSource(t))
	shared := squashSpaces(strings.Join(sharedGuideLines(morphGuideSource(t)), " "))
	for _, rule := range rules {
		if n := strings.Count(source, rule); n != 1 {
			t.Errorf("the source holds %q %d times, want once", rule, n)
		}
		if n := strings.Count(shared, rule); n != 1 {
			t.Errorf("the text outside the agent blocks holds %q %d times, want once", rule, n)
		}
		for _, p := range AgentProfiles {
			content, err := p.Render("1")
			if err != nil {
				t.Fatal(err)
			}
			if n := strings.Count(squashSpaces(content), rule); n != 1 {
				t.Errorf("%s: the rendering holds %q %d times, want once", p.Id, rule, n)
			}
		}
	}
}

func TestMorphGuideTrustComesAtPlanAgreementBeforeEnabling(t *testing.T) {
	for _, p := range AgentProfiles {
		content, err := p.Render("1")
		if err != nil {
			t.Fatal(err)
		}
		plan := strings.Index(content, "3. **Reformulate the request")
		trust := strings.Index(content, "4. **Ask for trust when the user agrees to the plan.**")
		build := strings.Index(content, "6. **Build live")
		enable := strings.Index(content, "enable it: `molten mod enable <id>`")
		if plan < 0 || trust < plan || build < trust || enable < trust || enable > build {
			t.Errorf("%s: the order is plan %d, trust %d, enable %d, build %d", p.Id, plan, trust, enable, build)
		}
		flat := squashSpaces(content)
		for _, want := range []string{
			"the user approves what they have just read, once, before any code you write runs",
			"declare in `mod.json` the capabilities the plan listed, and no more",
			"If the user declines, stop and say so: nothing ran.",
			"the plan's list is the contract",
			"update the plan and ask again before you write it",
		} {
			if !strings.Contains(flat, want) {
				t.Errorf("%s: the trust step lacks %q", p.Id, want)
			}
		}
	}
}

func TestMorphGuideOpensTheDesignViewOrFallsBackToTheTerminal(t *testing.T) {
	for _, p := range AgentProfiles {
		content, err := p.Render("1")
		if err != nil {
			t.Fatal(err)
		}
		flat := squashSpaces(content)
		for _, want := range []string{
			"If it lists `morph design`, run `molten morph design <id> --name \"<the mod's name>\"`",
			"MoltenTerm opens a guiding panel to the right of this terminal, in its tab",
			"Do it right after step 1, so steps 2 to 4 show in the panel",
			"If `molten help` does not list `morph design`, or the command says the view did not open",
			"skip this step and run the steps here, in this terminal, with the same words and the same order",
			"in MoltenTerm's dedicated design view when the installed version has it",
			"`molten morph design step|ask|answer|plan|draft`",
		} {
			if !strings.Contains(flat, want) {
				t.Errorf("%s: the guide lacks %q", p.Id, want)
			}
		}
	}
}

func TestMorphGuideEndsWithValidationAndGivingUp(t *testing.T) {
	for _, p := range AgentProfiles {
		content, err := p.Render("1")
		if err != nil {
			t.Fatal(err)
		}
		flat := squashSpaces(content)
		for _, want := range []string{
			"a **name** for the mod, **three icons** to pick from",
			"a **category**",
			"If the user gives up instead, run `molten undo`",
			"Library > Tools > Your mods",
		} {
			if !strings.Contains(flat, want) {
				t.Errorf("%s: the guide lacks %q", p.Id, want)
			}
		}
	}
}

// AC-5 and AC-6: the agent part loads in a new session of a new terminal; the plugin-authoring skill's folder and
// hot reloading stay out, so the two texts do not contradict each other.
func TestMorphGuideSettlesPluginAuthoring(t *testing.T) {
	for _, p := range AgentProfiles {
		content, err := p.Render("1")
		if err != nil {
			t.Fatal(err)
		}
		flat := squashSpaces(content)
		claudeOnly := []string{
			"loads in a new Claude Code session started in a new MoltenTerm terminal",
			"A terminal that was open before the part existed never loads it.",
			"write in the mod's `agents/claude-code/` folder and nowhere else",
			"under its `dev-mods` folder",
			`"Turn on the mods Claude writes in this session?"`,
			`tell them to choose "Not now"`,
			"Do not use `claude --plugin-dir`, and never set `CLAUDE_CODE_PLUGIN_DIRS`",
			"which is not the skill's hot reloading and needs nothing from you",
			"where it disagrees with this guide, this guide wins",
			"follow the split rule instead: it is interface, so it goes in the MoltenTerm part",
		}
		for _, want := range claudeOnly {
			if has := strings.Contains(flat, want); has != (p.Id == "claude-code") {
				t.Errorf("%s: %q present = %v", p.Id, want, has)
			}
		}
		if p.Id == "claude-code" && strings.Contains(flat, "next Claude Code session started") {
			t.Error("claude-code: the part loads in a new session of a new terminal, not the next session")
		}
	}
}

func TestMorphOutOfReachPointsToTheV7Stories(t *testing.T) {
	for _, p := range AgentProfiles {
		content, err := p.Render("1")
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(content, "Not planned yet") {
			t.Errorf("%s: the panel line must point to a story, not say it is not planned", p.Id)
		}
		for _, want := range []string{"#1890", "#1892", "#1897", "#1898", "| A layout, a panel of its own |"} {
			if !strings.Contains(content, want) {
				t.Errorf("%s: Out of reach for now lacks %q", p.Id, want)
			}
		}
	}
	format, err := agentdocs.Files.ReadFile("mod-format.md")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"#1890", "#1892", "#1897", "#1898", "A mod built through `/morph` asks for this trust at one moment"} {
		if !strings.Contains(string(format), want) {
			t.Errorf("mod-format.md lacks %q", want)
		}
	}
	if strings.Contains(string(format), "Layouts and free-form panels come later") {
		t.Error("mod-format.md must point to the v7 stories, not say layouts come later")
	}
	parts, err := agentdocs.Files.ReadFile("claude-code-parts.md")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"## Writing the part with the plugin-authoring skill", "dev-mods", "Not now", "new MoltenTerm terminal"} {
		if !strings.Contains(string(parts), want) {
			t.Errorf("claude-code-parts.md lacks %q", want)
		}
	}
}

func TestMorphGuideWrittenByMoltenDocsHasTheSameFlow(t *testing.T) {
	dir := t.TempDir()
	if err := WriteDocs(dir); err != nil {
		t.Fatal(err)
	}
	written, err := os.ReadFile(filepath.Join(dir, "morph.md"))
	if err != nil {
		t.Fatal(err)
	}
	var titles []string
	for _, match := range morphStepRegex.FindAllStringSubmatch(string(written), -1) {
		titles = append(titles, match[2])
	}
	if strings.Join(titles, "|") != strings.Join(morphV7Steps, "|") {
		t.Errorf("molten docs prints the steps %q, want %q", titles, morphV7Steps)
	}
	if strings.Contains(string(written), "dev-mods") {
		t.Error("molten docs writes the generic guide: it holds no Claude Code block")
	}
}
