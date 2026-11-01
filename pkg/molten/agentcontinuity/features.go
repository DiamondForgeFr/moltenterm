// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentcontinuity

import (
	"fmt"
	"slices"
	"strings"
)

// The compatibility matrix (FR-AGC-001, DS-AGC-001): for every known agent, how each MoltenTerm feature works with
// it. The capabilities above say what the agent's CLI offers; the features say what MoltenTerm does with them. Both
// are declared by the agent's adapter, or by its PlannedAgent entry while it has none, and checked together when the
// registry is built: this is the one list the CLI, the route and the interface read (no second table elsewhere).
// Source of the cells: the audit of #1681 (develop 389f41535); a live run (FR-AGC-007) will date each cell with the
// agent version and model it was checked with.

// MatrixAsOf is when the matrix was last checked against the code and the agents' documentation (NFR-AGC-002).
const MatrixAsOf = "2026-11-01"

// How a feature works with an agent.
const (
	// LevelNative: through the agent's own hooks or files, wired by MoltenTerm.
	LevelNative = "native"
	// LevelAdapted: through launch options, a translated format or a workaround.
	LevelAdapted = "adapted"
	// LevelProcessOnly: MoltenTerm knows the agent only from its process or its terminal.
	LevelProcessOnly = "process-only"
	LevelNone        = "none"
)

// Why a feature is not native.
const (
	ReasonNoAdapter       = "noadapter"
	ReasonNoHooks         = "nohooks"
	ReasonNoMcp           = "nomcp"
	ReasonNoSkills        = "noskills"
	ReasonNotDetected     = "notdetected"
	ReasonAgentSpecific   = "agentspecific"
	ReasonModelUnverified = "modelunverified"
)

// The MoltenTerm features of the matrix (the rows of the #1681 audit).
const (
	FeatDetect        = "detect"
	FeatState         = "state"
	FeatHooksOffer    = "hooksoffer"
	FeatLauncher      = "launcher"
	FeatUsage         = "usage"
	FeatStatusLine    = "statusline"
	FeatApprovals     = "approvals"
	FeatTurnNotify    = "turnnotify"
	FeatBrowserMcp    = "browsermcp"
	FeatInstructions  = "instructions"
	FeatHandoff       = "handoff"
	FeatSignature     = "signature"
	FeatMaterials     = "materials"
	FeatFilePanel     = "filepanel"
	FeatGuides        = "guides"
	FeatModParts      = "modparts"
	FeatResume        = "resume"
	FeatBriefing      = "briefing"
	FeatEffort        = "effort"
	FeatCommands      = "commands"
	FeatCompanion     = "companion"
	FeatRunner        = "runner"
	FeatReviewSession = "reviewsession"
	FeatOnboarding    = "onboarding"
	FeatWorktreeName  = "worktreename"
	FeatTermCopy      = "termcopy"
	FeatBusyClose     = "busyclose"
)

var validLevels = []string{LevelNative, LevelAdapted, LevelProcessOnly, LevelNone}
var validReasons = []string{ReasonNoAdapter, ReasonNoHooks, ReasonNoMcp, ReasonNoSkills, ReasonNotDetected, ReasonAgentSpecific, ReasonModelUnverified}

// FeatureInfo is one MoltenTerm feature. Requires: the agent capabilities it cannot be native or adapted without.
type FeatureInfo struct {
	Id       string   `json:"id"`
	Name     string   `json:"name"`
	Requires []string `json:"requires,omitempty"`
}

// AllFeatures lists the features in the order molten agent list --features shows them.
var AllFeatures = []FeatureInfo{
	{Id: FeatDetect, Name: "Process detection"},
	{Id: FeatState, Name: "Precise state (working, waiting, done)", Requires: []string{CapHooks}},
	{Id: FeatHooksOffer, Name: "Set up hooks offer", Requires: []string{CapHooks}},
	{Id: FeatLauncher, Name: "Launcher integration, nothing of the user's edited"},
	{Id: FeatUsage, Name: "Plan usage gauges", Requires: []string{CapQuota}},
	{Id: FeatStatusLine, Name: "Status line relay", Requires: []string{CapHooks}},
	{Id: FeatApprovals, Name: "Coffee approvals (answer permissions)", Requires: []string{CapHooks}},
	{Id: FeatTurnNotify, Name: "End of turn notification", Requires: []string{CapHooks}},
	{Id: FeatBrowserMcp, Name: "molten-browser MCP (browser, list_agents, send_to_agent)", Requires: []string{CapMcp}},
	{Id: FeatInstructions, Name: "MoltenTerm instructions (first name, signature, materials)", Requires: []string{CapMcp}},
	{Id: FeatHandoff, Name: "Handoffs and first names"},
	{Id: FeatSignature, Name: "Commit and PR signature"},
	{Id: FeatMaterials, Name: "Materials (molten material add)"},
	{Id: FeatFilePanel, Name: "Driven file panel (molten files)"},
	{Id: FeatGuides, Name: "/morph, mods, /molten-pipeline, /molten-bug"},
	{Id: FeatModParts, Name: "Agent parts of a mod"},
	{Id: FeatResume, Name: "Linked session, resume, Continue with", Requires: []string{CapResume}},
	{Id: FeatBriefing, Name: "Briefing at launch", Requires: []string{CapBriefing}},
	{Id: FeatEffort, Name: "Effort and model", Requires: []string{CapModels}},
	{Id: FeatCommands, Name: "Agent commands and permission modes"},
	{Id: FeatCompanion, Name: "Companion (session, recap, sub-agents)", Requires: []string{CapTranscript}},
	{Id: FeatRunner, Name: "Agent that runs tasks (AI review, release notes, Mission Control)", Requires: []string{CapInitialPrompt}},
	{Id: FeatReviewSession, Name: "Review session (molten-review MCP, read-only)", Requires: []string{CapMcp}},
	{Id: FeatOnboarding, Name: "First-run card and install"},
	{Id: FeatWorktreeName, Name: "Agent name in a worktree"},
	{Id: FeatTermCopy, Name: "Copy from the terminal"},
	{Id: FeatBusyClose, Name: "Busy agent guard on close"},
}

// FeatureSupport is one cell. Reason: why it is not native (required for process-only and none); Note: how it works
// or what is missing (required for adapted); Adapter: the code that delivers it, relative to pkg/molten (FS/ is
// frontend/moltenterm-shell); Issue: the ticket that changes it.
type FeatureSupport struct {
	Level   string `json:"level"`
	Reason  string `json:"reason,omitempty"`
	Note    string `json:"note,omitempty"`
	Adapter string `json:"adapter,omitempty"`
	Issue   string `json:"issue,omitempty"`
}

// AgentFeatures is one agent's row. Adapter: the agent has an agentcontinuity adapter.
type AgentFeatures struct {
	Id       string                    `json:"id"`
	Name     string                    `json:"name"`
	Adapter  bool                      `json:"adapter"`
	Features map[string]FeatureSupport `json:"features"`
}

// FeatureMatrix is what molten agent list --features --json prints and the molten:agentfeatures route answers.
type FeatureMatrix struct {
	AsOf     string          `json:"asof"`
	Features []FeatureInfo   `json:"features"`
	Agents   []AgentFeatures `json:"agents"`
}

// FindFeature returns a feature of AllFeatures, or nil.
func FindFeature(id string) *FeatureInfo {
	for i := range AllFeatures {
		if AllFeatures[i].Id == id {
			return &AllFeatures[i]
		}
	}
	return nil
}

// Matrix is every known agent's row: the adapters in registration order, then the planned agents.
func (r *Registry) Matrix() FeatureMatrix {
	rtn := FeatureMatrix{AsOf: MatrixAsOf, Features: slices.Clone(AllFeatures)}
	for _, a := range r.Adapters() {
		rtn.Agents = append(rtn.Agents, AgentFeatures{Id: a.Id(), Name: a.Name(), Adapter: true, Features: a.Features()})
	}
	for _, p := range PlannedAgents {
		rtn.Agents = append(rtn.Agents, AgentFeatures{Id: p.Id, Name: p.Name, Features: copyFeatures(p.Features)})
	}
	return rtn
}

// checkFeatures refuses a row that leaves a feature out, declares an unknown one, level or reason, misses the reason,
// note or adapter its level needs, or makes a feature work without a capability it requires. caps is nil for a
// planned agent, which has no adapter and so nothing native.
func checkFeatures(id string, features map[string]FeatureSupport, caps map[string]Capability) error {
	for _, info := range AllFeatures {
		f, ok := features[info.Id]
		if !ok {
			return fmt.Errorf("agent %s: feature %s not declared", id, info.Id)
		}
		if !slices.Contains(validLevels, f.Level) {
			return fmt.Errorf("agent %s: feature %s has level %q", id, info.Id, f.Level)
		}
		if f.Reason != "" && !slices.Contains(validReasons, f.Reason) {
			return fmt.Errorf("agent %s: feature %s has reason %q", id, info.Id, f.Reason)
		}
		if (f.Level == LevelProcessOnly || f.Level == LevelNone) && f.Reason == "" {
			return fmt.Errorf("agent %s: feature %s is %s without a reason", id, info.Id, f.Level)
		}
		if f.Level == LevelAdapted && strings.TrimSpace(f.Note) == "" {
			return fmt.Errorf("agent %s: feature %s is adapted without a note", id, info.Id)
		}
		if f.Level != LevelNone && strings.TrimSpace(f.Adapter) == "" {
			return fmt.Errorf("agent %s: feature %s is %s without its adapter code", id, info.Id, f.Level)
		}
		if caps == nil && f.Level == LevelNative {
			return fmt.Errorf("agent %s: feature %s is native but the agent has no adapter", id, info.Id)
		}
		if f.Level != LevelNative && f.Level != LevelAdapted {
			continue
		}
		for _, req := range info.Requires {
			if caps != nil && caps[req].Support == SupportUnavailable {
				return fmt.Errorf("agent %s: feature %s is %s but capability %s is unavailable", id, info.Id, f.Level, req)
			}
		}
	}
	if len(features) != len(AllFeatures) {
		return fmt.Errorf("agent %s: unknown features declared", id)
	}
	return nil
}

func copyFeatures(features map[string]FeatureSupport) map[string]FeatureSupport {
	rtn := make(map[string]FeatureSupport, len(features))
	for k, v := range features {
		rtn[k] = v
	}
	return rtn
}

// plannedFeatures is a planned agent's row: the cells given, every other feature none for want of an adapter.
func plannedFeatures(cells map[string]FeatureSupport) map[string]FeatureSupport {
	rtn := make(map[string]FeatureSupport, len(AllFeatures))
	for _, info := range AllFeatures {
		rtn[info.Id] = FeatureSupport{Level: LevelNone, Reason: ReasonNoAdapter}
	}
	for k, v := range cells {
		rtn[k] = v
	}
	return rtn
}

// Cells every agent known from its process shares, adapter or not.
var processDetected = FeatureSupport{Level: LevelProcessOnly, Reason: ReasonNoAdapter, Note: "process name and path hints of molten.AgentKinds", Adapter: "agentstate.go (AgentKinds), agentproc.go"}
var processState = FeatureSupport{Level: LevelProcessOnly, Reason: ReasonNoHooks, Note: "working and idle from the terminal's activity; molten agent state --agent <id> also accepts it", Adapter: "attention/procwatch.go"}
var processHandoff = FeatureSupport{Level: LevelProcessOnly, Reason: ReasonNoMcp, Note: "receives a brief typed into its terminal; sends only with molten agent send", Adapter: "agenthandoff/brief.go"}
var processWorktreeName = FeatureSupport{Level: LevelProcessOnly, Reason: ReasonNoAdapter, Note: "named from its process", Adapter: "agentstate.go, mission/upcoming_attribution.go"}
var shellBusyClose = FeatureSupport{Level: LevelProcessOnly, Reason: ReasonNoHooks, Note: "the shell integration's running command; works for any program", Adapter: "FS/busy-close-model.ts"}

var claudeFeatures = map[string]FeatureSupport{
	FeatDetect:        {Level: LevelNative, Note: "process name, versioned binary path", Adapter: "agentstate.go (AgentKinds), agentproc.go"},
	FeatState:         {Level: LevelNative, Note: "SessionStart, UserPromptSubmit, PostToolUse, Notification, Stop and Subagent hooks", Adapter: "agentintegration.go, agenthook/hook.go"},
	FeatHooksOffer:    {Level: LevelNative, Note: "snippet for ~/.claude/settings.json", Adapter: "agenthooks.go, attention/agenthookoffer.go"},
	FeatLauncher:      {Level: LevelNative, Note: "--settings and --mcp-config for the run", Adapter: "agentlaunch/claude.go, agentlaunch/claudemcp.go"},
	FeatUsage:         {Level: LevelNative, Note: "status line rate_limits, then OAuth usage", Adapter: "usage/claudestatusline.go, usage/adapters.go"},
	FeatStatusLine:    {Level: LevelNative, Note: "statusLine wrapped by molten agent statusline -- <cmd>", Adapter: "agentstatusline.go, agentlaunch/claude.go"},
	FeatApprovals:     {Level: LevelNative, Note: "PermissionRequest hook to molten agent permission", Adapter: "agentintegration.go, keepawake/approve.go"},
	FeatTurnNotify:    {Level: LevelNative, Note: "Stop and Notification hooks", Adapter: "cmd/wsh/cmd/wshcmd-molten-agentnotify.go"},
	FeatBrowserMcp:    {Level: LevelAdapted, Note: "stdio server molten mcp browser added for the run with --mcp-config", Adapter: "mcpbrowser/agenttools.go, agentlaunch/claudemcp.go"},
	FeatInstructions:  {Level: LevelAdapted, Note: "carried by the MCP server's instructions; without the MCP the agent knows neither its first name nor to sign", Adapter: "mcpbrowser/agenttools.go (AgentInstructions)"},
	FeatHandoff:       {Level: LevelNative, Note: "send through the MCP or molten agent send; the brief is typed into the receiver's terminal", Adapter: "agenthandoff/brief.go, agentnames/agentnames.go"},
	FeatSignature:     {Level: LevelAdapted, Note: "molten agent whoami --trailer and sign-pr, which the agent must remember; model and effort from the companion", Adapter: "agentsign/agentsign.go"},
	FeatMaterials:     {Level: LevelAdapted, Note: "molten material add, known from the MCP instructions", Adapter: "materials/guard.go"},
	FeatFilePanel:     {Level: LevelAdapted, Note: "molten files, known from the guides and the MCP instructions", Adapter: "cmd/wsh/cmd/wshcmd-molten-files.go, filesearch"},
	FeatGuides:        {Level: LevelNative, Note: "Claude skills (/morph)", Adapter: "agents.go, agentguides.go"},
	FeatModParts:      {Level: LevelNative, Note: "CLAUDE_CODE_PLUGIN_DIRS, .claude-plugin", Adapter: "agentparts/agentparts.go"},
	FeatResume:        {Level: LevelNative, Note: "--resume <id>, --continue", Adapter: "agentcontinuity/claude.go, companion/resume.go"},
	FeatBriefing:      {Level: LevelNative, Note: "--append-system-prompt-file", Adapter: "agentcontinuity/claude.go"},
	FeatEffort:        {Level: LevelNative, Note: "types /effort; Claude's models", Adapter: "agentcontinuity/effort.go, termupdate/agenteffort.go"},
	FeatCommands:      {Level: LevelNative, Note: "command table and permission modes", Adapter: "FS/command-panel/agent-commands.ts, termupdate/agentinputwatch.go"},
	FeatCompanion:     {Level: LevelNative, Note: "transcripts in ~/.claude/projects", Adapter: "companion/adapter.go, companion/roots.go"},
	FeatRunner:        {Level: LevelNative, Note: "claude -p", Adapter: "agentchoice/agentchoice.go"},
	FeatReviewSession: {Level: LevelNative, Note: "--strict-mcp-config, --allowedTools mcp__molten-review, --disallowedTools", Adapter: "reviewsession/command.go, agentlaunch/review.go"},
	FeatOnboarding:    {Level: LevelNative, Note: "catalog entry from its guide profile", Adapter: "onboarding/agents.go"},
	FeatWorktreeName:  {Level: LevelNative, Note: "its own .claude/worktrees folder", Adapter: "agentstate.go (WorktreesDir), mission/upcoming_attribution.go"},
	FeatTermCopy:      {Level: LevelNative, Note: "margin glyphs, /copy", Adapter: "FS/term-copy/agent-copy-profiles.ts"},
	FeatBusyClose:     {Level: LevelNative, Note: "the agent's state", Adapter: "FS/busy-close-model.ts"},
}

var codexFeatures = map[string]FeatureSupport{
	FeatDetect:        {Level: LevelNative, Note: "process name and path hints", Adapter: "agentstate.go (AgentKinds), agentproc.go"},
	FeatState:         {Level: LevelAdapted, Note: "notify reports done; the state hooks given with -c hooks.* run once the developer trusted them in /hooks; waiting from the PermissionRequest hook and Codex's notifications", Adapter: "agentlaunch/codexhooks.go, agentintegration.go"},
	FeatHooksOffer:    {Level: LevelNative, Note: "snippet for config.toml", Adapter: "agenthooks.go, attention/agenthookoffer.go"},
	FeatLauncher:      {Level: LevelAdapted, Note: "-c notify, -c mcp_servers, -c hooks.* and -c tui.notifications for the run", Adapter: "agentlaunch/codex.go, agentlaunch/codexhooks.go"},
	FeatUsage:         {Level: LevelAdapted, Note: "token_count of the session log, then codex app-server", Adapter: "usage/codexappserver.go, usage/adapters.go"},
	FeatStatusLine:    {Level: LevelNone, Reason: ReasonAgentSpecific, Note: "the status line relay is Claude Code's; Codex's usage comes from its session log"},
	FeatApprovals:     {Level: LevelAdapted, Note: "PermissionRequest hook given with -c, running once trusted in /hooks", Adapter: "agentlaunch/codexpermission.go, keepawake/approve.go"},
	FeatTurnNotify:    {Level: LevelAdapted, Note: "notify payload", Adapter: "cmd/wsh/cmd/wshcmd-molten-agentnotify.go"},
	FeatBrowserMcp:    {Level: LevelAdapted, Note: "-c mcp_servers.molten-browser for the run", Adapter: "mcpbrowser/agenttools.go, agentlaunch/codex.go"},
	FeatInstructions:  {Level: LevelAdapted, Note: "carried by the MCP server's instructions", Adapter: "mcpbrowser/agenttools.go (AgentInstructions)"},
	FeatHandoff:       {Level: LevelAdapted, Note: "send through the MCP or a reply line (sandbox); the brief is typed into the receiver's terminal", Adapter: "agenthandoff/brief.go, agentnames/agentnames.go"},
	FeatSignature:     {Level: LevelAdapted, Note: "molten agent whoami --trailer and sign-pr, which the agent must remember", Adapter: "agentsign/agentsign.go"},
	FeatMaterials:     {Level: LevelAdapted, Note: "molten material add, known from the MCP instructions", Adapter: "materials/guard.go"},
	FeatFilePanel:     {Level: LevelAdapted, Note: "molten files, known from the guides and the MCP instructions", Adapter: "cmd/wsh/cmd/wshcmd-molten-files.go, filesearch"},
	FeatGuides:        {Level: LevelAdapted, Note: "skills in ~/.agents/skills, called $morph", Adapter: "agents.go, agentguides.go"},
	FeatModParts:      {Level: LevelNone, Reason: ReasonAgentSpecific, Note: "a mod's agent parts are Claude Code plugins"},
	FeatResume:        {Level: LevelNative, Note: "codex resume <id>, codex fork", Adapter: "agentcontinuity/codex.go, companion/resume.go"},
	FeatBriefing:      {Level: LevelNative, Note: "-c developer_instructions", Adapter: "agentcontinuity/codex.go"},
	FeatEffort:        {Level: LevelAdapted, Note: "keyboard shortcuts, levels from the models cache", Adapter: "agentcontinuity/effort.go, termupdate/agenteffort.go"},
	FeatCommands:      {Level: LevelAdapted, Note: "local command table, no permission modes", Adapter: "FS/command-panel/agent-commands.ts"},
	FeatCompanion:     {Level: LevelAdapted, Note: "$CODEX_HOME/sessions, whose rollout format is undocumented", Adapter: "companion/adapter.go, companion/roots.go"},
	FeatRunner:        {Level: LevelNative, Note: "codex exec -", Adapter: "agentchoice/agentchoice.go"},
	FeatReviewSession: {Level: LevelAdapted, Note: "--sandbox read-only", Adapter: "reviewsession/command.go, agentlaunch/review.go"},
	FeatOnboarding:    {Level: LevelNative, Note: "catalog entry from its guide profile", Adapter: "onboarding/agents.go"},
	FeatWorktreeName:  {Level: LevelProcessOnly, Reason: ReasonAgentSpecific, Note: "Codex has no worktree folder of its own; named from its process", Adapter: "agentstate.go, mission/upcoming_attribution.go"},
	FeatTermCopy:      {Level: LevelAdapted, Note: "margin glyphs of its profile", Adapter: "FS/term-copy/agent-copy-profiles.ts"},
	FeatBusyClose:     {Level: LevelNative, Note: "the agent's state", Adapter: "FS/busy-close-model.ts"},
}

var geminiFeatures = plannedFeatures(map[string]FeatureSupport{
	FeatDetect:       processDetected,
	FeatState:        processState,
	FeatHandoff:      processHandoff,
	FeatGuides:       {Level: LevelAdapted, Note: "TOML commands", Adapter: "agents.go, agentguides.go"},
	FeatOnboarding:   {Level: LevelAdapted, Note: "catalog entry from its guide profile; Antigravity replaces it for individual accounts", Adapter: "onboarding/agents.go", Issue: "#1680"},
	FeatWorktreeName: processWorktreeName,
	FeatTermCopy:     {Level: LevelAdapted, Note: "margin glyphs of its profile", Adapter: "FS/term-copy/agent-copy-profiles.ts"},
	FeatBusyClose:    shellBusyClose,
})

var kimiFeatures = plannedFeatures(map[string]FeatureSupport{
	FeatDetect:       processDetected,
	FeatState:        processState,
	FeatHandoff:      processHandoff,
	FeatGuides:       {Level: LevelAdapted, Note: "Kimi skill (/skill:morph)", Adapter: "agents.go, agentguides.go"},
	FeatOnboarding:   {Level: LevelAdapted, Note: "catalog entry from its guide profile", Adapter: "onboarding/agents.go"},
	FeatWorktreeName: processWorktreeName,
	FeatBusyClose:    shellBusyClose,
})

var qwenFeatures = plannedFeatures(map[string]FeatureSupport{
	FeatDetect:       processDetected,
	FeatState:        processState,
	FeatHandoff:      processHandoff,
	FeatGuides:       {Level: LevelAdapted, Note: "Qwen skill", Adapter: "agents.go, agentguides.go"},
	FeatOnboarding:   {Level: LevelAdapted, Note: "catalog entry from its guide profile", Adapter: "onboarding/agents.go"},
	FeatWorktreeName: processWorktreeName,
	FeatBusyClose:    shellBusyClose,
})

// The subscription CLIs of #1680 share one row: recognised by their process, a skill in their user folder.
var subscriptionCliFeatures = plannedFeatures(map[string]FeatureSupport{
	FeatDetect:       processDetected,
	FeatState:        processState,
	FeatHandoff:      processHandoff,
	FeatGuides:       {Level: LevelAdapted, Note: "skill in its user skills folder, called /morph", Adapter: "agents.go, agentguides.go"},
	FeatOnboarding:   {Level: LevelAdapted, Note: "catalog entry from its guide profile, with a sign-in step", Adapter: "onboarding/agents.go"},
	FeatWorktreeName: processWorktreeName,
	FeatBusyClose:    shellBusyClose,
})

var openCodeFeatures = plannedFeatures(map[string]FeatureSupport{
	FeatDetect:       processDetected,
	FeatState:        processState,
	FeatHandoff:      processHandoff,
	FeatGuides:       {Level: LevelNone, Reason: ReasonNoSkills, Note: "no molten guides profile"},
	FeatWorktreeName: processWorktreeName,
	FeatTermCopy:     {Level: LevelAdapted, Note: "margin glyphs of its profile", Adapter: "FS/term-copy/agent-copy-profiles.ts"},
	FeatBusyClose:    shellBusyClose,
})
