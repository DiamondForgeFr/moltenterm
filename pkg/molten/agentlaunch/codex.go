// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
)

// Codex at launch (FR-SHELL-038, DS-SHELL-050; codex --help and source, codex-cli 0.160.1). `-c key=value` overrides
// one configuration value for the run, above every config file; the value is parsed as TOML (a string that does not
// parse is taken literally, so every value here is valid TOML). Tables merge key by key, so
// mcp_servers.molten-browser is added next to the user's servers; a single value such as notify is replaced whole,
// so the generated notify runs `molten agent notify`, which reports the turn's end and links the session, then runs
// the user's own notify with the same JSON argument (Codex appends it to the argv). Codex hooks are not used: hooks
// passed for one run stay untrusted until the user trusts them, and MoltenTerm never bypasses that trust. Profiles
// and CODEX_HOME are not used either: the first needs a file in ~/.codex, the second hides the user's config.

const (
	CodexAgentId              = molten.AgentIdCodex
	codexExecutable           = "codex"
	codexConfigFlag           = "-c"
	codexConfigLong           = "--config"
	codexProfile              = "-p"
	codexProfileLng           = "--profile"
	codexNotifyItemName       = "Done state at each turn's end (notify)"
	codexNotifyAroundItemName = "Done state at each turn's end (notify, around your own notify)"
	codexSessionItemName      = "Session link (at the end of the first turn)"
	codexHooksItemName        = "Agent state hooks"
)

// The notify wrapper: <molten> agent notify --agent codex -- <the user's notify argv>; Codex appends the payload.
// --session-only: the user's notify already reports the state, the wrapper only links the session.
var codexNotifyWrapper = []string{"agent", "notify", "--agent", CodexAgentId, "--"}
var codexSessionOnlyWrapper = []string{"agent", "notify", "--agent", CodexAgentId, NotifySessionOnlyFlag, "--"}

// NotifySessionOnlyFlag is the option of `molten agent notify` that leaves the state to the user's own notify.
const NotifySessionOnlyFlag = "--session-only"

// Options that make a run that starts no session in this pane: version and help, and --remote, whose session runs in
// a remote app server.
var codexPassThroughFlags = map[string]bool{
	"-V": true, "--version": true, "-h": true, "--help": true, "--remote": true,
}

// Codex's subcommands that start no session in this pane (codex --help, 0.160.1). exec, review, resume and fork
// start one and are integrated; any other first word is the prompt.
var codexSubcommands = map[string]bool{
	"login": true, "logout": true, "mcp": true, "mcp-server": true, "app-server": true, "app": true,
	"completion": true, "features": true, "sandbox": true, "debug": true, "apply": true, "a": true, "cloud": true,
	"execpolicy": true, "responses-api-proxy": true, "stdio-to-uds": true, "help": true, "generate-ts": true,
}

// Codex's options whose value is the next argument, and -i, which takes several (codex --help, 0.160.1).
var codexValueOptions = map[string]bool{
	"-c": true, "--config": true, "--enable": true, "--disable": true, "--remote": true, "--remote-auth-token-env": true,
	"-m": true, "--model": true, "--local-provider": true, "-p": true, "--profile": true, "-s": true, "--sandbox": true,
	"-a": true, "--ask-for-approval": true, "-C": true, "--cd": true, "--add-dir": true,
}
var codexGreedyOptions = map[string]bool{"-i": true, "--image": true}

type codexAdapter struct{}

func (codexAdapter) Id() string         { return CodexAgentId }
func (codexAdapter) Executable() string { return codexExecutable }

// codexArgs is what the plan reads of the user's arguments, before "--".
type codexArgs struct {
	// overrides: the keys of every -c key=value.
	overrides map[string]string
	profile   string
	firstWord string
	passFlag  bool
}

func parseCodexArgs(args []string) codexArgs {
	rtn := codexArgs{overrides: map[string]string{}}
	sawWord := false
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			break
		}
		if !strings.HasPrefix(arg, "-") || arg == "-" {
			if !sawWord {
				rtn.firstWord, sawWord = arg, true
			}
			continue
		}
		name, value, hasValue := strings.Cut(arg, "=")
		if !strings.HasPrefix(arg, "--") {
			name, value, hasValue = arg, "", false
			if len(arg) > 2 && codexValueOptions[arg[:2]] {
				name, value, hasValue = arg[:2], strings.TrimPrefix(arg[2:], "="), true
			}
		}
		if codexPassThroughFlags[name] {
			rtn.passFlag = true
		}
		if codexGreedyOptions[name] {
			for !hasValue && i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				i++
			}
			continue
		}
		if !codexValueOptions[name] {
			continue
		}
		if !hasValue {
			if i+1 >= len(args) {
				break
			}
			i++
			value = args[i]
		}
		switch name {
		case codexConfigFlag, codexConfigLong:
			key, v, _ := strings.Cut(value, "=")
			rtn.overrides[normalizeTomlKey(key)] = strings.TrimSpace(v)
		case codexProfile, codexProfileLng:
			rtn.profile = value
		}
	}
	return rtn
}

// PassThrough: a version, help or --remote option before "--", or a management subcommand as the first word.
func (codexAdapter) PassThrough(args []string) bool {
	parsed := parseCodexArgs(args)
	return parsed.passFlag || codexSubcommands[parsed.firstWord]
}

// normalizeTomlKey writes a dotted key as plain segments: spaces around the dots and the quotes of a quoted segment
// go (mcp_servers . "molten-browser" is mcp_servers.molten-browser).
func normalizeTomlKey(key string) string {
	parts := strings.Split(key, ".")
	for i, p := range parts {
		p = strings.TrimSpace(p)
		if len(p) >= 2 && (p[0] == '"' || p[0] == '\'') && p[len(p)-1] == p[0] {
			p = p[1 : len(p)-1]
		}
		parts[i] = p
	}
	return strings.Join(parts, ".")
}

// overridesKey tells whether the user's -c overrides set a key or a key under it (notify, mcp_servers...).
func (a codexArgs) overridesKey(key string) bool {
	for k := range a.overrides {
		if k == key || strings.HasPrefix(k, key+".") {
			return true
		}
	}
	return false
}

// Plan builds the run's -c overrides: the MoltenTerm browser, then the notify wrapper. No file is written; the
// overrides go before the user's arguments, so the user's own -c values, read later, still win.
func (codexAdapter) Plan(ctx LaunchContext) (LaunchPlan, error) {
	var plan LaunchPlan
	args := parseCodexArgs(ctx.Args)
	config := readCodexConfig(ctx)
	if config.unreadable != "" {
		plan.StepAside = config.unreadable + " could not be read"
		return plan, nil
	}
	extra := planCodexBrowser(ctx, args, config, &plan)
	plan.ShownArgs = append(plan.ShownArgs, extra...)
	extra = append(extra, planCodexNotify(ctx, args, config, &plan)...)
	plan.Skipped = append(plan.Skipped, molten.IntegrationItem{Kind: molten.IntegrationStateHooks, Name: codexHooksItemName,
		Reason: "Codex runs hooks added for one run only once you trust them, and MoltenTerm never bypasses that trust"})
	if len(extra) == 0 {
		plan.ShownArgs = nil
		return plan, nil
	}
	user := ctx.Args
	plan.MakeArgs = func([]string) []string {
		rtn := make([]string, 0, len(extra)+len(user))
		rtn = append(rtn, extra...)
		return append(rtn, user...)
	}
	return plan, nil
}

func planCodexBrowser(ctx LaunchContext, args codexArgs, config codexConfig, plan *LaunchPlan) []string {
	skip := func(reason string) []string {
		plan.Skipped = append(plan.Skipped, molten.IntegrationItem{Kind: molten.IntegrationBrowser, Name: claudeBrowserItemName, Reason: reason})
		return nil
	}
	if ctx.MoltenPath == "" {
		return skip("MoltenTerm's browser server (molten mcp browser) is not installed")
	}
	key := codexMcpServersKey + "." + mcpbrowser.ServerName
	if args.overridesKey(key) {
		return skip("already yours, in your -c " + key)
	}
	if _, whole := args.overrides[codexMcpServersKey]; whole {
		return skip("you passed -c " + codexMcpServersKey + ": only your own servers run")
	}
	if where := config.browserWhere(); where != "" {
		return skip("already yours, in " + where)
	}
	plan.Added = append(plan.Added, molten.IntegrationItem{Kind: molten.IntegrationBrowser, Name: claudeBrowserItemName})
	return []string{
		codexConfigFlag, key + ".command=" + tomlString(ctx.MoltenPath),
		codexConfigFlag, key + ".args=" + tomlArray([]string{"mcp", "browser"}),
	}
}

func planCodexNotify(ctx LaunchContext, args codexArgs, config codexConfig, plan *LaunchPlan) []string {
	skip := func(reason string) []string {
		plan.Skipped = append(plan.Skipped,
			molten.IntegrationItem{Kind: molten.IntegrationNotify, Name: codexNotifyItemName, Reason: reason},
			molten.IntegrationItem{Kind: molten.IntegrationSession, Name: codexSessionItemName, Reason: reason})
		return nil
	}
	if ctx.MoltenPath == "" {
		return skip("MoltenTerm's molten command is not installed")
	}
	if args.overridesKey(codexNotifyKey) {
		return skip("you passed your own -c notify: it runs as you set it")
	}
	// The --profile option wins over a -c profile, which wins over the files.
	profile := args.profile
	if override, ok := args.overrides[codexProfileKey]; ok && profile == "" {
		profile = strings.Trim(override, `"'`)
	}
	if profile == "" {
		profile = config.profile()
	}
	if where := config.profileNotify(profile); where != "" {
		return skip("your profile " + profile + " in " + where + " sets notify: it runs as you set it")
	}
	if where := config.managedSetsNotify(); where != "" {
		return skip("your organization's " + where + " sets notify")
	}
	if where := config.projectSetsNotify(); where != "" {
		return skip(where + " may set notify for this project: it runs as you set it")
	}
	if where := config.projectRootMarkers(); where != "" {
		return skip(where + " sets project_root_markers: the project files Codex reads could not be told")
	}
	user, where, ok := config.userNotify()
	if !ok {
		return skip("the notify of " + where + " is not a list of strings")
	}
	wrapper := codexNotifyWrapper
	switch {
	case molten.IsAgentStateHookCommand(strings.Join(user, " ")):
		// The setup agent-states.md offers (#221) already reports done: the wrapper then only links the session.
		wrapper = codexSessionOnlyWrapper
		plan.Skipped = append(plan.Skipped, molten.IntegrationItem{Kind: molten.IntegrationNotify, Name: codexNotifyItemName,
			Reason: "already yours, in " + where + ": it runs as you set it, and the session is linked around it"})
	case len(user) > 0:
		plan.Added = append(plan.Added, molten.IntegrationItem{Kind: molten.IntegrationNotify, Name: codexNotifyAroundItemName})
	default:
		plan.Added = append(plan.Added, molten.IntegrationItem{Kind: molten.IntegrationNotify, Name: codexNotifyItemName})
	}
	plan.Added = append(plan.Added, molten.IntegrationItem{Kind: molten.IntegrationSession, Name: codexSessionItemName})
	argv := append([]string{ctx.MoltenPath}, wrapper...)
	key := codexNotifyKey + "="
	plan.ShownArgs = append(plan.ShownArgs, codexConfigFlag, key+tomlArray(argv)[:len(tomlArray(argv))-1]+codexShownUserNotify(user)+"]")
	return []string{codexConfigFlag, key + tomlArray(append(argv, user...))}
}

// codexShownUserNotify stands for the user's notify in the report: its program only, since its arguments may hold a
// token (a webhook URL).
func codexShownUserNotify(user []string) string {
	if len(user) == 0 {
		return ""
	}
	shown := `,` + tomlString(user[0])
	if len(user) > 1 {
		shown += fmt.Sprintf(`,"<%d more of your arguments>"`, len(user)-1)
	}
	return shown
}

// tomlString writes a TOML basic string: quotes, backslashes and control characters (DEL included) escaped. Invalid
// UTF-8, which no TOML file can hold, is replaced.
func tomlString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range strings.ToValidUTF8(s, string(utf8.RuneError)) {
		switch {
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r < 0x20 || r == 0x7f:
			fmt.Fprintf(&b, `\u%04X`, r)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

func tomlArray(items []string) string {
	quoted := make([]string, len(items))
	for i, s := range items {
		quoted[i] = tomlString(s)
	}
	return "[" + strings.Join(quoted, ",") + "]"
}
