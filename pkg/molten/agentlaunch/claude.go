// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// Claude Code at launch (DS-SHELL-047, DS-SHELL-048). `claude --settings <file>` applies above the user's, project and
// local settings and below managed settings; hook entries merge across levels and a handler defined in several files
// runs once; a single key such as statusLine is taken from the highest level that sets it
// (https://code.claude.com/docs/en/settings, /hooks). So the generated file holds the state hooks and the
// SessionStart hook of agent-states.md with their exact command strings (a pasted copy runs once), and a statusLine
// that runs the status line relay around the user's own status line command, read from their files: what Claude
// Code shows does not change. Nothing else is set.

const (
	ClaudeAgentId      = "claude"
	claudeExecutable   = "claude"
	claudeSettingsFlag = "--settings"
	claudeFilePrefix   = "claude"
	// The file that also holds the user's own --settings (which may carry secrets: env, apiKeyHelper) is kept
	// for a shorter time (files.go).
	claudeFlagFilePrefix = "claude-flag"
	// A settings file larger than this is not read: it is taken as unreadable.
	maxSettingsBytes = 4 * 1024 * 1024
)

// Options that make a run that starts no session of this pane: version and help, a detached or desktop session, or
// a run meant to be minimal or without customizations. -p runs are integrated: they are the pane's agent too.
var claudePassThroughFlags = map[string]bool{
	"-v": true, "--version": true, "-h": true, "--help": true,
	"--bg": true, "--background": true, "--desktop": true,
	"--bare": true, "--safe-mode": true,
}

// Claude Code's subcommands (claude --help, 2.1.292): none starts a session in this pane.
var claudeSubcommands = map[string]bool{
	"agents": true, "attach": true, "auth": true, "auto-mode": true, "config": true, "doctor": true,
	"gateway": true, "import": true, "install": true, "logs": true, "mcp": true, "migrate-installer": true,
	"plugin": true, "plugins": true, "purge": true, "respawn": true, "rm": true, "setup-token": true,
	"stop": true, "kill": true, "ultrareview": true, "update": true, "upgrade": true,
}

type claudeAdapter struct{}

func (claudeAdapter) Id() string         { return ClaudeAgentId }
func (claudeAdapter) Executable() string { return claudeExecutable }

// PassThrough: a management option anywhere before "--", or a subcommand as the first word that is not an option.
// An option's value is never mistaken for a subcommand that changes anything: at worst a session gets no
// integration.
func (claudeAdapter) PassThrough(args []string) bool {
	sawWord := false
	for _, arg := range args {
		if arg == "--" {
			return false
		}
		if claudePassThroughFlags[arg] {
			return true
		}
		if strings.HasPrefix(arg, "-") || sawWord {
			continue
		}
		sawWord = true
		if claudeSubcommands[arg] {
			return true
		}
	}
	return false
}

// claudeArgs is what the plan reads of the user's arguments.
type claudeArgs struct {
	// rest: the arguments without the user's --settings, which the generated file takes in; at: where the last one
	// was in rest, so the generated one takes its place (a variadic option before it, such as --allowedTools, must
	// still end where it ended).
	rest       []string
	settings   string
	hasSetting bool
	at         int
	// sources: --setting-sources, nil when absent; restricted: --restricted ignores user, project and local files.
	sources    []string
	restricted bool
}

func parseClaudeArgs(args []string) claudeArgs {
	var rtn claudeArgs
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			rtn.rest = append(rtn.rest, args[i:]...)
			break
		}
		if value, ok := optionValue(args, &i, claudeSettingsFlag); ok {
			rtn.settings, rtn.hasSetting, rtn.at = value, true, len(rtn.rest)
			continue
		}
		rtn.rest = append(rtn.rest, arg)
		if arg == "--restricted" {
			rtn.restricted = true
		}
		if value, ok := strings.CutPrefix(arg, "--setting-sources="); ok {
			rtn.sources = splitSources(value)
		} else if arg == "--setting-sources" && i+1 < len(args) {
			rtn.sources = splitSources(args[i+1])
		}
	}
	return rtn
}

// optionValue reads `--name value` or `--name=value` at args[*i], moving *i past the value.
func optionValue(args []string, i *int, name string) (string, bool) {
	arg := args[*i]
	if value, ok := strings.CutPrefix(arg, name+"="); ok {
		return value, true
	}
	if arg != name || *i+1 >= len(args) {
		return "", false
	}
	*i++
	return args[*i], true
}

func splitSources(value string) []string {
	rtn := []string{}
	for _, s := range strings.Split(value, ",") {
		if s = strings.TrimSpace(s); s != "" {
			rtn = append(rtn, s)
		}
	}
	return rtn
}

// settingsSource is one settings document Claude Code applies, highest level first.
type settingsSource struct {
	display string
	keys    map[string]json.RawMessage
	// unreadable: the file exists but could not be read or parsed; raw: its text, searched for MoltenTerm's commands.
	unreadable bool
	raw        string
}

func readSettingsSource(env molten.AgentEnv, path string) (settingsSource, bool) {
	src := settingsSource{display: molten.DisplayHomePath(env, path)}
	data, err := readBounded(path)
	if errors.Is(err, fs.ErrNotExist) {
		return src, false
	}
	if err != nil {
		src.unreadable = true
		return src, true
	}
	if err := json.Unmarshal(data, &src.keys); err != nil || src.keys == nil {
		src.unreadable, src.raw, src.keys = true, string(data), nil
	}
	return src, true
}

// readBounded reads a regular file of at most maxSettingsBytes: a FIFO or a device would block the launch.
func readBounded(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%s is not a regular file", path)
	}
	if info.Size() > maxSettingsBytes {
		return nil, fmt.Errorf("%s is too large", path)
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, maxSettingsBytes))
}

// readUserSettingsFlag reads the user's own --settings: a JSON object, inline or in a file.
func readUserSettingsFlag(value string, cwd string) (map[string]json.RawMessage, error) {
	data := []byte(value)
	if !strings.HasPrefix(strings.TrimSpace(value), "{") {
		path := value
		if !filepath.IsAbs(path) {
			path = filepath.Join(cwd, path)
		}
		read, err := readBounded(path)
		if err != nil {
			return nil, fmt.Errorf("your --settings %s could not be read: %w", value, err)
		}
		data = read
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(data, &keys); err != nil || keys == nil {
		return nil, fmt.Errorf("your --settings is not a JSON object")
	}
	return keys, nil
}

// claudeSources lists the settings of this run, highest level first: managed, the user's --settings, then the local,
// project and user files that --setting-sources and --restricted let Claude Code read.
func claudeSources(ctx LaunchContext, args claudeArgs, flag map[string]json.RawMessage) (settingsSource, []settingsSource) {
	managedPath := ctx.ManagedSettings
	if managedPath == "" {
		managedPath = molten.ClaudeManagedSettingsPath()
	}
	managed, _ := readSettingsSource(ctx.Env, managedPath)
	var rtn []settingsSource
	if flag != nil {
		rtn = append(rtn, settingsSource{display: "your --settings", keys: flag})
	}
	if args.restricted {
		return managed, rtn
	}
	for _, f := range molten.ClaudeUserProjectLocalFiles(ctx.Env, ctx.Cwd) {
		if args.sources != nil && !slices.Contains(args.sources, f.Level) {
			continue
		}
		if src, ok := readSettingsSource(ctx.Env, f.Path); ok {
			rtn = append(rtn, src)
		}
	}
	return managed, rtn
}

type claudeHookCommands struct {
	Hooks map[string][]struct {
		Hooks []struct {
			Command string `json:"command"`
		} `json:"hooks"`
	} `json:"hooks"`
}

// hasHook tells whether a settings document already runs a matching command for an event. An unreadable file is
// searched as text, for any event: a doubt leaves MoltenTerm's copy out rather than running a hook twice.
func (s settingsSource) hasHook(event string, match func(string) bool) bool {
	if s.unreadable {
		return match(s.raw)
	}
	raw, ok := s.keys["hooks"]
	if !ok {
		return false
	}
	var parsed claudeHookCommands
	if json.Unmarshal([]byte(`{"hooks":`+string(raw)+`}`), &parsed) != nil {
		return match(string(raw))
	}
	for _, matcher := range parsed.Hooks[event] {
		for _, hook := range matcher.Hooks {
			if match(hook.Command) {
				return true
			}
		}
	}
	return false
}

func (s settingsSource) boolKey(key string) (bool, bool) {
	raw, ok := s.keys[key]
	if !ok {
		return false, false
	}
	var value bool
	if json.Unmarshal(raw, &value) != nil {
		return false, false
	}
	return value, true
}

// effectiveBool is a boolean key as Claude Code applies it: from the highest level that sets it.
func effectiveBool(managed settingsSource, sources []settingsSource, key string) (bool, string) {
	for _, s := range append([]settingsSource{managed}, sources...) {
		if value, ok := s.boolKey(key); ok {
			return value, s.display
		}
	}
	return false, ""
}

func hookWhere(sources []settingsSource, event string, match func(string) bool) string {
	for _, s := range sources {
		if s.hasHook(event, match) {
			return s.display
		}
	}
	return ""
}

type plannedHook struct {
	event   string
	command string
}

// planClaudeHooks adds the state hooks and the session link, except the events the user's files already wire to
// MoltenTerm.
func planClaudeHooks(managed settingsSource, sources []settingsSource, plan *LaunchPlan) []plannedHook {
	if only, _ := managed.boolKey("allowManagedHooksOnly"); only {
		reason := "your organization's managed settings allow only their own hooks"
		plan.Skipped = append(plan.Skipped,
			molten.IntegrationItem{Kind: molten.IntegrationStateHooks, Name: "Agent state hooks", Reason: reason},
			molten.IntegrationItem{Kind: molten.IntegrationSession, Name: "Session link", Reason: reason})
		return nil
	}
	all := append([]settingsSource{managed}, sources...)
	var hooks []plannedHook
	var added, skipped []string
	skippedIn := ""
	for _, h := range molten.ClaudeStateHooks() {
		if where := hookWhere(all, h.Event, molten.IsAgentStateHookCommand); where != "" {
			skipped, skippedIn = append(skipped, h.Event), where
			continue
		}
		hooks = append(hooks, plannedHook{event: h.Event, command: h.Command})
		added = append(added, h.Event)
	}
	if len(added) > 0 {
		plan.Added = append(plan.Added, molten.IntegrationItem{Kind: molten.IntegrationStateHooks, Name: "Agent state hooks (" + strings.Join(added, ", ") + ")"})
	}
	if len(skipped) > 0 {
		plan.Skipped = append(plan.Skipped, molten.IntegrationItem{Kind: molten.IntegrationStateHooks, Name: "Agent state hooks (" + strings.Join(skipped, ", ") + ")", Reason: "already yours, in " + skippedIn})
	}
	if where := hookWhere(all, molten.ClaudeSessionHookEvent, molten.IsAgentSessionHookCommand); where != "" {
		plan.Skipped = append(plan.Skipped, molten.IntegrationItem{Kind: molten.IntegrationSession, Name: "Session link", Reason: "already yours, in " + where})
		return hooks
	}
	plan.Added = append(plan.Added, molten.IntegrationItem{Kind: molten.IntegrationSession, Name: "Session link"})
	return append(hooks, plannedHook{event: molten.ClaudeSessionHookEvent, command: molten.ClaudeSessionHookCommand})
}

// planClaudeStatusLine returns the statusLine to set, or nil to leave the user's in effect. It is read from the
// highest level that sets one, the user's --settings included; the user's other fields (padding...) are kept.
func planClaudeStatusLine(managed settingsSource, sources []settingsSource, plan *LaunchPlan) map[string]any {
	const name = "Status line relay"
	skip := func(reason string) map[string]any {
		plan.Skipped = append(plan.Skipped, molten.IntegrationItem{Kind: molten.IntegrationStatusLine, Name: name, Reason: reason})
		return nil
	}
	if _, ok := managed.keys["statusLine"]; ok || (managed.unreadable && strings.Contains(managed.raw, "statusLine")) {
		return skip("your organization's managed settings set the status line")
	}
	var line map[string]any
	for _, s := range sources {
		if s.unreadable {
			return skip(s.display + " could not be read, so your status line could not be kept")
		}
		raw, ok := s.keys["statusLine"]
		if !ok {
			continue
		}
		if json.Unmarshal(raw, &line) != nil || line == nil {
			return skip("the status line in " + s.display + " could not be read")
		}
		break
	}
	if line == nil {
		plan.Added = append(plan.Added, molten.IntegrationItem{Kind: molten.IntegrationStatusLine, Name: name + " (you have no status line: nothing is shown)"})
		return map[string]any{"type": "command", "command": molten.StatusLineRelayCommand("")}
	}
	command, _ := line["command"].(string)
	if line["type"] != "command" || strings.TrimSpace(command) == "" {
		return skip("your status line is not a command")
	}
	if molten.IsStatusLineRelayCommand(command) {
		return skip("your status line already runs it")
	}
	rtn := map[string]any{}
	for k, v := range line {
		rtn[k] = v
	}
	rtn["command"] = molten.StatusLineRelayCommand(command)
	plan.Added = append(plan.Added, molten.IntegrationItem{Kind: molten.IntegrationStatusLine, Name: name + " around your status line"})
	return rtn
}

// Plan builds the run's settings. The user's own --settings is folded into the generated file (theirs win, hooks
// concatenated, their status line wrapped), since Claude Code takes one --settings.
func (claudeAdapter) Plan(ctx LaunchContext) (LaunchPlan, error) {
	var plan LaunchPlan
	args := parseClaudeArgs(ctx.Args)
	var flag map[string]json.RawMessage
	if args.hasSetting {
		var err error
		if flag, err = readUserSettingsFlag(args.settings, ctx.Cwd); err != nil {
			return plan, err
		}
	}
	managed, sources := claudeSources(ctx, args, flag)
	if off, where := effectiveBool(managed, sources, "disableAllHooks"); off {
		plan.StepAside = "disableAllHooks is on in " + where + ": Claude Code runs no hooks and no status line"
		return plan, nil
	}
	hooks := planClaudeHooks(managed, sources, &plan)
	statusLine := planClaudeStatusLine(managed, sources, &plan)
	if len(hooks) == 0 && statusLine == nil {
		return plan, nil
	}
	data, err := claudeSettingsJSON(flag, hooks, statusLine)
	if err != nil {
		return plan, err
	}
	prefix := claudeFilePrefix
	if flag != nil {
		prefix = claudeFlagFilePrefix
	}
	plan.Files = []PlannedFile{{Prefix: prefix, Data: data}}
	rest, at := args.rest, args.at
	plan.MakeArgs = func(paths []string) []string {
		rtn := make([]string, 0, len(rest)+2)
		rtn = append(rtn, rest[:at]...)
		rtn = append(rtn, claudeSettingsFlag, paths[0])
		return append(rtn, rest[at:]...)
	}
	return plan, nil
}

// claudeSettingsJSON writes the generated settings: the user's --settings keys, then the hooks appended to theirs
// per event and the status line.
func claudeSettingsJSON(flag map[string]json.RawMessage, hooks []plannedHook, statusLine map[string]any) ([]byte, error) {
	doc := map[string]any{}
	for k, v := range flag {
		doc[k] = v
	}
	if len(hooks) > 0 {
		events := map[string][]any{}
		if raw, ok := flag["hooks"]; ok {
			var theirs map[string][]json.RawMessage
			if err := json.Unmarshal(raw, &theirs); err != nil {
				return nil, fmt.Errorf("the hooks of your --settings could not be read")
			}
			for event, matchers := range theirs {
				for _, m := range matchers {
					events[event] = append(events[event], m)
				}
			}
		}
		for _, h := range hooks {
			events[h.event] = append(events[h.event], map[string]any{
				"hooks": []any{map[string]any{"type": "command", "command": h.command}},
			})
		}
		doc["hooks"] = events
	}
	if statusLine != nil {
		doc["statusLine"] = statusLine
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(doc); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
