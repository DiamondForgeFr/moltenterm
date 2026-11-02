// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentcontinuity

import (
	"context"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentlaunch"
	"github.com/wavetermdev/waveterm/pkg/molten/agentparts"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
	"github.com/wavetermdev/waveterm/pkg/molten/usage"
)

// The adapter conformance suite (FR-AGC-006). Every native or adapted cell of the compatibility matrix names the
// tests that check it with fake agents, and every none cell is proved to have no code path. The coherence test fails
// when a cell has no test, when a named test does not exist, or when an agent of the matrix has no entry here: adding
// an agent, or making a cell work, means adding its conformance cases.

const repoRoot = "../../.."

// MatrixGoldenPath is the matrix as JSON for the frontend's conformance test, which cannot ask wavesrv; TestMatrixGolden
// keeps it in step (MOLTENTERM_UPDATE_GOLDEN=1 rewrites it).
const MatrixGoldenPath = "frontend/moltenterm-shell/agent-info/agent-features.json"

// FrontendConformanceTest checks the cells whose code lives in the frontend (FS/ adapters).
const FrontendConformanceTest = "frontend/moltenterm-shell/agent-info/agent-conformance.test.ts"

// A reference is "<package dir>:<Go test function>" or "<vitest file>:<test title>", from the repository root.
const (
	refContinuity = "pkg/molten/agentcontinuity:"
	refLaunch     = "pkg/molten/agentlaunch:"
	refHook       = "pkg/molten/agenthook:"
	refMolten     = "pkg/molten:"
	refFrontend   = FrontendConformanceTest + ":"
)

var (
	adapterConf    = refContinuity + "TestAdapterConformance"
	guideConf      = refContinuity + "TestGuideConformance"
	launchConf     = refLaunch + "TestLaunchConformance"
	hookConf       = refHook + "TestHookPayloadConformance"
	frontTermCopy  = refFrontend + "termcopy"
	frontCommands  = refFrontend + "commands"
	frontBusyClose = refFrontend + "busyclose"
	onboardingConf = "pkg/molten/onboarding:TestInstallCatalogCoversTheAgents"
)

// conformanceCases: for every agent of the matrix, the tests of its native and adapted cells (process-only cells may
// name some too).
var conformanceCases = map[string]map[string][]string{
	molten.AgentIdClaude: {
		FeatDetect:        {adapterConf, refMolten + "TestMatchAgentCommand", refMolten + "TestFindAgentProcess"},
		FeatState:         {hookConf, launchConf},
		FeatHooksOffer:    {refMolten + "TestClaudeHooksDetection", refMolten + "TestHookOfferRules"},
		FeatLauncher:      {launchConf, refLaunch + "TestClaudePlanWritesNothingOfTheUsers"},
		FeatUsage:         {adapterConf, "pkg/molten/usage:TestClaudeStatusLineSource"},
		FeatStatusLine:    {launchConf, refHook + "TestStatusLineRelayHandsOffAlongsideTheCommand"},
		FeatApprovals:     {launchConf, refLaunch + "TestClaudePlanCoffeeApprovalHook", "pkg/molten/keepawake:TestDecidePermission"},
		FeatTurnNotify:    {hookConf, launchConf},
		FeatBrowserMcp:    {launchConf, refLaunch + "TestClaudePlanAddsBrowser"},
		FeatInstructions:  {launchConf, "pkg/molten/mcpbrowser:TestInitializeTellsTheAgentItsFirstName"},
		FeatHandoff:       {"pkg/molten/agenthandoff:TestBriefFilesLinksAndSnapshots", "pkg/molten/agentnames:TestTakeGivesDistinctNames"},
		FeatSignature:     {"pkg/molten/agentsign:TestTrailerRoundTrip"},
		FeatMaterials:     {"pkg/molten/materials:TestClaudePublicationFixture"},
		FeatFilePanel:     {"pkg/molten/mcpbrowser:TestAgentInstructionsMentionMoltenFiles", "cmd/wsh/cmd:TestMoltenFilesTextOutput"},
		FeatGuides:        {guideConf},
		FeatModParts:      {adapterConf, "pkg/molten/agentparts:TestPluginDirsValue"},
		FeatResume:        {adapterConf, refContinuity + "TestFreshAndResumeArgs", "pkg/molten/companion:TestFindResumeSession"},
		FeatBriefing:      {adapterConf},
		FeatEffort:        {refContinuity + "TestClaudeEffortLevels", "pkg/molten/termupdate:TestClaudeEffortTypesTheSlashCommand"},
		FeatCommands:      {frontCommands, "pkg/molten/termupdate:TestAgentInputTypesTheCommand"},
		FeatCompanion:     {adapterConf, "pkg/molten/companion:TestClaudeSession"},
		FeatRunner:        {"pkg/molten/agentchoice:TestPrintArgv"},
		FeatReviewSession: {refLaunch + "TestClaudeReviewSessionPlan", "pkg/molten/reviewsession:TestClaudeReviewArgs"},
		FeatOnboarding:    {onboardingConf},
		FeatWorktreeName:  {adapterConf, "pkg/molten/mission:TestBackgroundAttributionOrder"},
		FeatTermCopy:      {frontTermCopy},
		FeatBusyClose:     {frontBusyClose},
	},
	molten.AgentIdCodex: {
		FeatDetect:        {adapterConf, refMolten + "TestMatchAgentCommand"},
		FeatState:         {hookConf, launchConf, refLaunch + "TestCodexPlanStateHooks"},
		FeatHooksOffer:    {refMolten + "TestCodexHooksDetection", refMolten + "TestHookOfferRules"},
		FeatLauncher:      {launchConf, refLaunch + "TestCodexOptionsAgainstHelp"},
		FeatUsage:         {adapterConf, "pkg/molten/usage:TestRunCodexAppServerProtocol", "pkg/molten/usage:TestCodexTranscriptSnapshot"},
		FeatApprovals:     {launchConf, refLaunch + "TestCodexPlanPermissionHook", "pkg/molten/keepawake:TestDenyListCodexPatch"},
		FeatTurnNotify:    {launchConf, "cmd/wsh/cmd:TestRunMoltenAgentNotifyRunsTheUsersProgram"},
		FeatBrowserMcp:    {launchConf, refLaunch + "TestCodexPlanStock"},
		FeatInstructions:  {launchConf, "pkg/molten/mcpbrowser:TestInitializeTellsTheAgentItsFirstName"},
		FeatHandoff:       {"pkg/molten/agenthandoff:TestBriefReplyLinePerReceiver", "pkg/molten/agentnames:TestTakeGivesDistinctNames"},
		FeatSignature:     {"pkg/molten/agentsign:TestTrailerRoundTrip"},
		FeatMaterials:     {"pkg/molten/materials:TestCodexPatchFixture"},
		FeatFilePanel:     {"pkg/molten/mcpbrowser:TestAgentInstructionsMentionMoltenFiles", "cmd/wsh/cmd:TestMoltenFilesTextOutput"},
		FeatGuides:        {guideConf},
		FeatResume:        {adapterConf, refContinuity + "TestFreshAndResumeArgs", "pkg/molten/companion:TestCodexFindSession"},
		FeatBriefing:      {adapterConf},
		FeatEffort:        {refContinuity + "TestCodexEffortLevelsFollowTheShortcuts", "pkg/molten/termupdate:TestCodexEffortPressesTheKeysFromTheKnownLevel"},
		FeatCommands:      {frontCommands, "pkg/molten/termupdate:TestAgentInputCodexTable"},
		FeatCompanion:     {adapterConf, "pkg/molten/companion:TestCodexSession"},
		FeatRunner:        {"pkg/molten/agentchoice:TestPrintArgv"},
		FeatReviewSession: {refLaunch + "TestCodexReviewSessionPlan", "pkg/molten/reviewsession:TestCodexReviewArgs"},
		FeatOnboarding:    {onboardingConf},
		FeatWorktreeName:  {adapterConf},
		FeatTermCopy:      {frontTermCopy},
		FeatBusyClose:     {frontBusyClose},
	},
	molten.AgentIdGemini: {
		FeatDetect:     {refContinuity + "TestPlannedAgentConformance"},
		FeatState:      {"pkg/molten/attention:TestProcWatchFindsAgentInEveryShell"},
		FeatGuides:     {guideConf},
		FeatOnboarding: {onboardingConf},
		FeatTermCopy:   {frontTermCopy},
		FeatBusyClose:  {frontBusyClose},
	},
	molten.AgentIdKimi: {
		FeatDetect:     {refContinuity + "TestPlannedAgentConformance"},
		FeatGuides:     {guideConf},
		FeatOnboarding: {onboardingConf},
		FeatBusyClose:  {frontBusyClose},
	},
	molten.AgentIdQwen:        subscriptionCliCases,
	molten.AgentIdAntigravity: subscriptionCliCases,
	molten.AgentIdCopilot:     subscriptionCliCases,
	molten.AgentIdCursor:      subscriptionCliCases,
	molten.AgentIdGrok:        subscriptionCliCases,
	molten.AgentIdVibe:        subscriptionCliCases,
	molten.AgentIdOpenCode: {
		FeatDetect:    {refContinuity + "TestPlannedAgentConformance"},
		FeatTermCopy:  {frontTermCopy},
		FeatBusyClose: {frontBusyClose},
	},
}

// subscriptionCliCases: the planned agents of #1680 (and Qwen Code), detected from their process, given the guides and a
// first-run card.
var subscriptionCliCases = map[string][]string{
	FeatDetect:     {refContinuity + "TestPlannedAgentConformance"},
	FeatGuides:     {guideConf},
	FeatOnboarding: {onboardingConf},
	FeatBusyClose:  {frontBusyClose},
}

// cellWorks: MoltenTerm offers the feature with the agent (native or adapted).
func cellWorks(f FeatureSupport) bool {
	return f.Level == LevelNative || f.Level == LevelAdapted
}

// testIndex finds the Go test functions of a package and the text of a vitest file, read once.
type testIndex struct {
	lock  sync.Mutex
	funcs map[string]map[string]bool
	files map[string]string
}

func (x *testIndex) goTests(t *testing.T, dir string) map[string]bool {
	x.lock.Lock()
	defer x.lock.Unlock()
	if names, ok := x.funcs[dir]; ok {
		return names
	}
	names := map[string]bool{}
	paths, _ := filepath.Glob(filepath.Join(repoRoot, dir, "*_test.go"))
	fset := token.NewFileSet()
	for _, path := range paths {
		f, err := parser.ParseFile(fset, path, nil, parser.SkipObjectResolution)
		if err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}
		for _, decl := range f.Decls {
			if fn, ok := decl.(*ast.FuncDecl); ok && fn.Recv == nil && strings.HasPrefix(fn.Name.Name, "Test") {
				names[fn.Name.Name] = true
			}
		}
	}
	x.funcs[dir] = names
	return names
}

func (x *testIndex) fileText(path string) (string, bool) {
	x.lock.Lock()
	defer x.lock.Unlock()
	if text, ok := x.files[path]; ok {
		return text, true
	}
	data, err := os.ReadFile(filepath.Join(repoRoot, path))
	if err != nil {
		return "", false
	}
	x.files[path] = string(data)
	return string(data), true
}

// resolveRef tells why a reference names no test, "" when it does.
func (x *testIndex) resolveRef(t *testing.T, ref string) string {
	where, name, ok := strings.Cut(ref, ":")
	if !ok || where == "" || name == "" {
		return "not <place>:<test>"
	}
	if strings.HasSuffix(where, ".test.ts") || strings.HasSuffix(where, ".test.tsx") {
		text, ok := x.fileText(where)
		if !ok {
			return "no such vitest file"
		}
		if !strings.Contains(text, `"`+name+`"`) {
			return "no test titled " + name
		}
		return ""
	}
	if !x.goTests(t, where)[name] {
		return "no Go test " + name
	}
	return ""
}

// adapterPaths lists the files of a cell's Adapter field, relative to the repository root: FS/ is
// frontend/moltenterm-shell, cmd/ the repository's, anything else pkg/molten's.
func adapterPaths(adapter string) []string {
	var rtn []string
	for _, part := range strings.Split(adapter, ",") {
		part = strings.TrimSpace(part)
		if i := strings.Index(part, " ("); i >= 0 {
			part = part[:i]
		}
		switch {
		case part == "":
			continue
		case strings.HasPrefix(part, "FS/"):
			rtn = append(rtn, filepath.Join("frontend", "moltenterm-shell", strings.TrimPrefix(part, "FS/")))
		case strings.HasPrefix(part, "cmd/"):
			rtn = append(rtn, part)
		default:
			rtn = append(rtn, filepath.Join("pkg", "molten", part))
		}
	}
	return rtn
}

// FR-AGC-006 AC-1: every native or adapted cell maps to conformance tests that exist, a cell whose code is in the
// frontend to the frontend's suite, every none cell to its no-code-path proof, and the code a cell names exists.
func TestConformanceCoherence(t *testing.T) {
	x := &testIndex{funcs: map[string]map[string]bool{}, files: map[string]string{}}
	m := Default().Matrix()
	rows := map[string]bool{}
	for _, a := range m.Agents {
		rows[a.Id] = true
		cases, ok := conformanceCases[a.Id]
		if !ok {
			t.Errorf("agent %s is in the matrix without conformance cases", a.Id)
			continue
		}
		for _, info := range AllFeatures {
			cell := a.Features[info.Id]
			refs := cases[info.Id]
			if cellWorks(cell) && len(refs) == 0 {
				t.Errorf("%s/%s is %s without a conformance test", a.Id, info.Id, cell.Level)
			}
			if cell.Level == LevelNone && len(refs) != 0 {
				t.Errorf("%s/%s is none but names tests %v: a none cell is proved by TestNoneCellsHaveNoCodePath", a.Id, info.Id, refs)
			}
			if cell.Level == LevelNone {
				if _, ok := noneProofs[info.Id]; !ok && cell.Reason != ReasonNoAdapter {
					t.Errorf("%s/%s is none (%s) without a no-code-path proof", a.Id, info.Id, cell.Reason)
				}
			}
			for _, ref := range refs {
				if why := x.resolveRef(t, ref); why != "" {
					t.Errorf("%s/%s: %s: %s", a.Id, info.Id, ref, why)
				}
			}
			if cellWorks(cell) && strings.Contains(cell.Adapter, "FS/") &&
				!slices.ContainsFunc(refs, func(r string) bool { return strings.HasPrefix(r, refFrontend) }) {
				t.Errorf("%s/%s is delivered by frontend code (%s) and needs a case in %s", a.Id, info.Id, cell.Adapter, FrontendConformanceTest)
			}
			for _, path := range adapterPaths(cell.Adapter) {
				if _, err := os.Stat(filepath.Join(repoRoot, path)); err != nil {
					t.Errorf("%s/%s names adapter code %s that does not exist", a.Id, info.Id, path)
				}
			}
		}
		for feature := range cases {
			if FindFeature(feature) == nil {
				t.Errorf("conformance cases of %s name unknown feature %s", a.Id, feature)
			}
		}
	}
	for id := range conformanceCases {
		if !rows[id] {
			t.Errorf("conformance cases for %s, which the matrix does not know", id)
		}
	}
}

type adapterCase struct {
	model, prompt string
	fresh         []string
	resume        []string
	last          []string
	briefingFlag  string
	briefingKey   string
	exit          string
	// help: the captured --help of the version the options were read on, "" when none is kept.
	help        string
	helpOptions []string
	helpWords   []string
	guide       string
	modParts    bool
	worktrees   string
	// process: an executable path the process detection must recognise.
	process string
}

// adapterConformance holds one case per adapter of the registry.
var adapterConformance = map[string]adapterCase{
	molten.AgentIdClaude: {
		model: "opus", prompt: "fix the tests",
		fresh:        []string{"--model", "opus", "--", "fix the tests"},
		resume:       []string{"--resume", "0a1b2c3d-4e5f"},
		last:         []string{"--continue"},
		briefingFlag: "--append-system-prompt-file",
		exit:         "/exit",
		guide:        "claude-code",
		modParts:     true,
		worktrees:    filepath.Join(".claude", "worktrees"),
		process:      "/Users/x/.local/share/claude/versions/2.1.292",
	},
	molten.AgentIdCodex: {
		model: "gpt-5.4", prompt: "fix the tests",
		fresh:        []string{"-m", "gpt-5.4", "--", "fix the tests"},
		resume:       []string{"resume", "0a1b2c3d-4e5f"},
		last:         []string{"resume", "--last"},
		briefingFlag: "-c", briefingKey: "developer_instructions",
		exit:        "/exit",
		help:        filepath.Join("..", "agentlaunch", "testdata", "codex-0.163.0-help.txt"),
		helpOptions: []string{"-m, --model", "-c, --config"},
		helpWords:   []string{"resume"},
		guide:       "codex",
		process:     "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js",
	},
}

// FR-AGC-006: what each adapter declares, checked against fake agents: process detection finds a fake executable on a
// fake PATH and reads its version, the launch arguments and prompts have the declared form, the parts it composes
// (launcher, transcripts, usage, guides, mod parts, worktrees) are the ones the matrix names.
func TestAdapterConformance(t *testing.T) {
	skipOnWindows(t)
	r := Default()
	for _, a := range r.Adapters() {
		if _, ok := adapterConformance[a.Id()]; !ok {
			t.Errorf("adapter %s has no conformance case", a.Id())
		}
	}
	bin := filepath.Join(t.TempDir(), "bin")
	for id, tc := range adapterConformance {
		t.Run(id, func(t *testing.T) {
			a := r.Find(id)
			if a == nil {
				t.Fatalf("no adapter")
			}
			features := a.Features()
			exe := a.Executable()

			writeFakeAgent(t, bin, exe, `echo "`+exe+` 9.8.7"`)
			d := MakeDetector(RunVersionProbe, AnsweringProbeTimeout)
			if got := d.Detect(context.Background(), exe, DetectEnv{PathList: bin}); !got.Installed || got.Version != "9.8.7" || got.Path != filepath.Join(bin, exe) {
				t.Errorf("detection of the fake %s: %+v", exe, got)
			}
			if got := molten.MatchAgentCommand("FOO=1 " + filepath.Join(bin, exe) + " --help"); got != id {
				t.Errorf("command line detection: %q", got)
			}
			if got := molten.MatchAgentProcess(tc.process, nil); got != id {
				t.Errorf("process detection of %s: %q", tc.process, got)
			}

			fresh, err := a.FreshArgs(tc.model, tc.prompt)
			if err != nil || !reflect.DeepEqual(fresh, tc.fresh) {
				t.Errorf("FreshArgs = %q, %v; want %q", fresh, err, tc.fresh)
			}
			resume, err := a.ResumeArgs("0a1b2c3d-4e5f")
			if err != nil || !reflect.DeepEqual(resume, tc.resume) {
				t.Errorf("ResumeArgs = %q, %v; want %q", resume, err, tc.resume)
			}
			if got := a.LastSessionArgs(); !reflect.DeepEqual(got, tc.last) {
				t.Errorf("LastSessionArgs = %q, want %q", got, tc.last)
			}
			if a.ResumesSession(fresh) || !a.ResumesSession(resume) || !a.ResumesSession(tc.last) {
				t.Errorf("ResumesSession: fresh %v resume %v last %v", a.ResumesSession(fresh), a.ResumesSession(resume), a.ResumesSession(tc.last))
			}
			if _, err := a.ResumeArgs("--help"); err == nil {
				t.Errorf("a session id that reads as an option must be refused")
			}
			b := a.Briefing()
			if b.Flag != tc.briefingFlag || b.Key != tc.briefingKey {
				t.Errorf("briefing %+v, want %s %s", b, tc.briefingFlag, tc.briefingKey)
			}
			if a.Exit().Command != tc.exit {
				t.Errorf("exit %+v", a.Exit())
			}
			if tc.help != "" {
				data, err := os.ReadFile(tc.help)
				if err != nil {
					t.Fatal(err)
				}
				for _, opt := range tc.helpOptions {
					if !strings.Contains(string(data), "  "+opt) {
						t.Errorf("%s is no longer in %s", opt, tc.help)
					}
				}
				for _, word := range tc.helpWords {
					if !strings.Contains(string(data), "\n  "+word+" ") {
						t.Errorf("subcommand %s is no longer in %s", word, tc.help)
					}
				}
			}

			wantPart := func(feature string, has bool, what string) {
				if cellWorks(features[feature]) != has {
					t.Errorf("%s is %s in the matrix but %s present: %v", feature, features[feature].Level, what, has)
				}
			}
			wantPart(FeatLauncher, a.Launch() != nil && a.Launch().Id() == id && a.Launch().Executable() == exe, "the launcher")
			wantPart(FeatCompanion, a.Transcripts() != nil, "the transcript reader")
			wantPart(FeatUsage, a.Usage() != nil, "the usage adapter")
			wantPart(FeatModParts, tc.modParts && slices.Contains(agentparts.SupportedAgents, a.GuideProfile()), "mod parts support")
			if a.GuideProfile() != tc.guide {
				t.Errorf("guide profile %q, want %q", a.GuideProfile(), tc.guide)
			}
			kind := molten.FindAgentKind(id)
			if kind == nil || kind.WorktreesDir != tc.worktrees || (features[FeatWorktreeName].Level == LevelNative) != (tc.worktrees != "") {
				t.Errorf("worktrees folder %+v, cell %s", kind, features[FeatWorktreeName].Level)
			}
		})
	}
}

// FR-AGC-006: an agent without an adapter is detected from its process when the matrix says so, never otherwise, and
// no flow can start it.
func TestPlannedAgentConformance(t *testing.T) {
	r := Default()
	for _, p := range PlannedAgents {
		t.Run(p.Id, func(t *testing.T) {
			if _, err := r.Lookup(p.Id); err == nil {
				t.Errorf("a planned agent was found in the registry")
			}
			detected := molten.MatchAgentCommand(p.Executable+" fix the tests") == p.Id
			byProcess := false
			if kind := molten.FindAgentKind(p.Id); kind != nil {
				for _, hint := range kind.ProcessHints {
					byProcess = byProcess || molten.MatchAgentProcess("/usr/lib/node_modules/"+strings.TrimPrefix(hint, "/")+"/x.js", nil) == p.Id
				}
			}
			works := p.Features[FeatDetect].Level != LevelNone
			if detected != works || byProcess != works {
				t.Errorf("detect is %s, but the command line is detected %v and the process %v", p.Features[FeatDetect].Level, detected, byProcess)
			}
		})
	}
}

// noneProofs show for a none cell that no code path delivers the feature to the agent. A cell none for want of an
// adapter is also proved by noAdapterProof.
var noneProofs = map[string]func(t *testing.T, id string, exe string){
	FeatDetect: func(t *testing.T, id string, exe string) {
		if molten.FindAgentKind(id) != nil || molten.MatchAgentCommand(exe+" fix the tests") != "" ||
			molten.MatchAgentProcess("/usr/local/bin/"+exe, nil) != "" {
			t.Errorf("%s is detected", id)
		}
	},
	FeatGuides: func(t *testing.T, id string, exe string) {
		if molten.GuideProfileOfAgent(id) != "" || slices.ContainsFunc(molten.AgentProfiles, func(p molten.AgentProfile) bool { return p.Executable == exe }) {
			t.Errorf("%s has a guides profile", id)
		}
	},
	FeatModParts: func(t *testing.T, id string, exe string) {
		if a := Find(id); a != nil && slices.Contains(agentparts.SupportedAgents, a.GuideProfile()) {
			t.Errorf("%s takes mod parts", id)
		}
	},
	FeatStatusLine: func(t *testing.T, id string, exe string) {
		la := agentlaunch.FindAdapter(id)
		if la == nil {
			return
		}
		home := t.TempDir()
		project := filepath.Join(home, "app")
		if err := os.MkdirAll(filepath.Join(project, ".git"), 0755); err != nil {
			t.Fatal(err)
		}
		ctx := agentlaunch.LaunchContext{
			Args:              []string{"fix the tests"},
			Env:               molten.AgentEnv{Home: home, DataDir: filepath.Join(home, "data"), Getenv: func(string) string { return "" }},
			Cwd:               project,
			BlockId:           "block-1",
			ManagedSettings:   filepath.Join(home, "managed.json"),
			CodexSystemConfig: filepath.Join(home, "etc", "config.toml"),
			MoltenPath:        "/data/bin/molten",
		}
		plan, err := la.Plan(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var text []string
		for _, f := range plan.Files {
			text = append(text, string(f.Data))
		}
		if plan.MakeArgs != nil {
			text = append(text, plan.MakeArgs(make([]string, len(plan.Files)))...)
		}
		for _, s := range text {
			if molten.IsStatusLineRelayCommand(s) || strings.Contains(s, "agent statusline") {
				t.Errorf("%s's run gets a status line relay", id)
			}
		}
	},
}

func noAdapterProof(t *testing.T, id string) {
	if Find(id) != nil || agentlaunch.FindAdapter(id) != nil || usage.For(id) != nil || companion.AdapterFor(id) != nil ||
		molten.AgentStateHooks(id) != nil {
		t.Errorf("%s has adapter code: a cell none for want of an adapter is wrong", id)
	}
}

// FR-AGC-006: a none cell really has no code path.
func TestNoneCellsHaveNoCodePath(t *testing.T) {
	exes := map[string]string{}
	for _, a := range Default().Adapters() {
		exes[a.Id()] = a.Executable()
	}
	for _, p := range PlannedAgents {
		exes[p.Id] = p.Executable
	}
	for _, a := range Default().Matrix().Agents {
		for _, info := range AllFeatures {
			cell := a.Features[info.Id]
			if cell.Level != LevelNone {
				continue
			}
			t.Run(a.Id+"/"+info.Id, func(t *testing.T) {
				if cell.Reason == ReasonNoAdapter {
					noAdapterProof(t, a.Id)
				}
				if proof, ok := noneProofs[info.Id]; ok {
					proof(t, a.Id, exes[a.Id])
				}
			})
		}
	}
}

type guideCase struct {
	profile string
	// path of the morph guide, relative to the fake HOME; root: the folder every guide goes in.
	path, root string
	// head: how the rendered guide starts (its format).
	head       string
	invocation string
}

var guideConformance = map[string]guideCase{
	molten.AgentIdClaude:      {"claude-code", ".claude/skills/morph/SKILL.md", ".claude/skills", "---\nname: morph\n", "/morph <request>"},
	molten.AgentIdCodex:       {"codex", ".agents/skills/morph/SKILL.md", ".agents/skills", "---\nname: morph\n", "$morph <request>"},
	molten.AgentIdGemini:      {"gemini-cli", ".gemini/commands/morph.toml", ".gemini/commands", "# ", "/morph <request>"},
	molten.AgentIdKimi:        {"kimi", ".kimi-code/skills/morph/SKILL.md", ".kimi-code/skills", "---\nname: morph\n", "/skill:morph <request>"},
	molten.AgentIdQwen:        {"qwen-code", ".qwen/commands/morph.md", ".qwen/commands", "---\ndescription: ", "/morph <request>"},
	molten.AgentIdAntigravity: {molten.AgentIdAntigravity, ".gemini/config/skills/morph/SKILL.md", ".gemini/config/skills", "---\nname: morph\n", "/morph <request>"},
	molten.AgentIdCopilot:     {molten.AgentIdCopilot, ".copilot/skills/morph/SKILL.md", ".copilot/skills", "---\nname: morph\n", "/morph <request>"},
	molten.AgentIdCursor:      {molten.AgentIdCursor, ".cursor/skills/morph/SKILL.md", ".cursor/skills", "---\nname: morph\n", "/morph <request>"},
	molten.AgentIdGrok:        {molten.AgentIdGrok, ".grok/skills/morph/SKILL.md", ".grok/skills", "---\nname: morph\n", "/morph <request>"},
	molten.AgentIdVibe:        {molten.AgentIdVibe, ".vibe/skills/morph/SKILL.md", ".vibe/skills", "---\nname: morph\n", "/morph <request>"},
}

// FR-AGC-006: the guides render in the agent's format and land in its place under a fake HOME, nowhere else.
func TestGuideConformance(t *testing.T) {
	for _, a := range Default().Matrix().Agents {
		if _, ok := guideConformance[a.Id]; cellWorks(a.Features[FeatGuides]) != ok {
			t.Errorf("%s: guides is %s, guide case %v", a.Id, a.Features[FeatGuides].Level, ok)
		}
	}
	for id, tc := range guideConformance {
		t.Run(id, func(t *testing.T) {
			profile, err := molten.FindAgent(tc.profile)
			if err != nil {
				t.Fatal(err)
			}
			if molten.FindAgentKind(id) != nil && molten.GuideProfileOfAgent(id) != tc.profile {
				t.Errorf("guide profile of %s: %q", id, molten.GuideProfileOfAgent(id))
			}
			home, dataDir := t.TempDir(), t.TempDir()
			env := molten.AgentEnv{Home: home, DataDir: dataDir, Getenv: func(string) string { return "" }}
			before := fingerprint(t, home)
			path, err := profile.Install(env, "0.0.0-test")
			if err != nil {
				t.Fatal(err)
			}
			if path != filepath.Join(home, tc.path) {
				t.Fatalf("morph installed at %s, want ~/%s", path, tc.path)
			}
			data, err := os.ReadFile(path)
			if err != nil || !strings.HasPrefix(string(data), tc.head) {
				t.Fatalf("morph does not start with %q: %.80q %v", tc.head, data, err)
			}
			if st := profile.Status(env); !st.Installed || st.Invocation != tc.invocation {
				t.Errorf("status %+v, want invocation %q", st, tc.invocation)
			}
			root := filepath.Join(home, tc.root) + string(filepath.Separator)
			for p, h := range fingerprint(t, home) {
				if before[p] != h && !strings.HasPrefix(p, root) {
					t.Errorf("%s written outside the guides folder ~/%s", p, tc.root)
				}
			}
		})
	}
}

func fingerprint(t *testing.T, root string) map[string]string {
	t.Helper()
	rtn := map[string]string{}
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		rtn[path] = string(data)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return rtn
}

// The frontend's conformance test reads the matrix from MatrixGoldenPath: it must be the matrix of this code.
func TestMatrixGolden(t *testing.T) {
	want, err := json.MarshalIndent(Default().Matrix(), "", "    ")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(repoRoot, MatrixGoldenPath)
	if os.Getenv("MOLTENTERM_UPDATE_GOLDEN") == "1" {
		if err := os.WriteFile(path, append(want, '\n'), 0644); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v: run MOLTENTERM_UPDATE_GOLDEN=1 go test -run TestMatrixGolden ./pkg/molten/agentcontinuity/", err)
	}
	var got, exp any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("%s: %v", MatrixGoldenPath, err)
	}
	json.Unmarshal(want, &exp)
	if !reflect.DeepEqual(got, exp) {
		t.Fatalf("%s is stale: run MOLTENTERM_UPDATE_GOLDEN=1 go test -run TestMatrixGolden ./pkg/molten/agentcontinuity/", MatrixGoldenPath)
	}
}
