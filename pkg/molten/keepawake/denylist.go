// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package keepawake

import (
	"path"
	"path/filepath"
	"strings"
)

// The deny list of the coffee approvals (FR-SHELL-063, DS-SHELL-111): what still prompts while a coffee holds.
// Destructive deletions outside the session's folder and the temporary folders, force pushes and deletions of the
// main branches, and credential files. The rules read a Bash command as a shell would split it, roughly: a command
// they cannot read is checked word by word, so a doubt prompts. They never run anything but `git symbolic-ref`,
// through PermissionCheck.Branch.

const (
	reasonQuestion   = "a question only you can answer"
	reasonRemove     = "deletes outside the session's folder: "
	reasonForcePush  = "force push or deletion of a main branch: "
	reasonCredential = "reads or writes a credential file: "
	reasonKeychain   = "reads the keychain"
	// What a reason shows of the path or the branch.
	maxReasonDetail = 120
)

// The tools whose request is a question to the person: approving it would answer it with nothing.
var questionTools = map[string]bool{"AskUserQuestion": true, "ExitPlanMode": true}

// The tools whose input names a file to read or write.
var fileTools = map[string]bool{"Read": true, "Edit": true, "Write": true, "MultiEdit": true, "NotebookEdit": true, "Grep": true, "Glob": true}

var fileInputKeys = []string{"file_path", "path", "notebook_path"}

var mainBranches = map[string]bool{"main": true, "master": true, "develop": true, "trunk": true}

// Programs that run the next word as the command.
var commandWrappers = map[string]bool{"sudo": true, "env": true, "command": true, "nice": true, "nohup": true, "time": true, "exec": true, "doas": true}

// git's options that take the next word as their value.
var gitValueOptions = map[string]bool{"-C": true, "-c": true, "--git-dir": true, "--work-tree": true, "--namespace": true, "--exec-path": true}

// PermissionCheck is one request as the rules read it.
type PermissionCheck struct {
	Tool  string
	Input map[string]any
	// Cwd: the session's folder; Home: the user's; TempDirs: folders whose content is scratch.
	Cwd      string
	Home     string
	TempDirs []string
	// Branch: the branch checked out in a folder, "" when unknown; nil: always unknown.
	Branch func(dir string) string
}

// DenyReason says why a request stays with the person, "" when it may be approved.
func DenyReason(c PermissionCheck) string {
	if questionTools[c.Tool] {
		return reasonQuestion
	}
	// An MCP tool's path arguments are read the same way (a filesystem server's read_file).
	if fileTools[c.Tool] || strings.HasPrefix(c.Tool, "mcp__") {
		for _, key := range fileInputKeys {
			if p, ok := c.Input[key].(string); ok && p != "" && isCredentialPath(p, c.Home) {
				return reasonCredential + clipDetail(p)
			}
		}
		return ""
	}
	if c.Tool == codexPatchTool {
		patch, _ := c.Input["command"].(string)
		return patchDenyReason(patch, c)
	}
	if c.Tool != "Bash" {
		return ""
	}
	command, _ := c.Input["command"].(string)
	return commandDenyReason(command, c)
}

// Codex's file edits (FR-SHELL-064): the apply_patch tool, its patch in tool_input.command, each file it touches on
// a "*** Add File:", "*** Update File:", "*** Delete File:" or "*** Move to:" line.
const codexPatchTool = "apply_patch"

var patchFileMarkers = []string{"*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "}

const patchDeleteMarker = "*** Delete File: "

// patchDenyReason keeps a patch that touches a credential file, or deletes a file outside the session's folder and
// the temporary folders, for the person.
func patchDenyReason(patch string, c PermissionCheck) string {
	for _, line := range strings.Split(patch, "\n") {
		line = strings.TrimRight(line, "\r")
		for _, marker := range patchFileMarkers {
			if !strings.HasPrefix(line, marker) {
				continue
			}
			p := strings.TrimSpace(strings.TrimPrefix(line, marker))
			if p == "" {
				continue
			}
			if isCredentialPath(p, c.Home) {
				return reasonCredential + clipDetail(p)
			}
			if marker == patchDeleteMarker && deletesOutsideSession(p, c) {
				return reasonRemove + clipDetail(p)
			}
		}
	}
	return ""
}

// deletesOutsideSession tells whether deleting p leaves the session's own folder and the temporary folders.
func deletesOutsideSession(p string, c PermissionCheck) bool {
	sessionDir := ""
	if c.Cwd != "" && filepath.IsAbs(c.Cwd) {
		sessionDir = filepath.Clean(c.Cwd)
	}
	if sessionDir == "/" || (c.Home != "" && sessionDir == filepath.Clean(c.Home)) {
		sessionDir = ""
	}
	if strings.HasPrefix(p, "~") {
		return true
	}
	if !filepath.IsAbs(p) {
		if sessionDir == "" {
			return true
		}
		p = filepath.Join(sessionDir, p)
	}
	p = filepath.Clean(p)
	if inTempDir(p, c.TempDirs) {
		return false
	}
	return sessionDir == "" || !within(p, sessionDir) || p == sessionDir
}

func clipDetail(s string) string {
	if len(s) > maxReasonDetail {
		return s[:maxReasonDetail] + "…"
	}
	return s
}

// shellWord is one word of a command; dynamic: it holds an expansion ($, a backtick) the rules cannot resolve.
type shellWord struct {
	text    string
	dynamic bool
}

// splitCommands splits a command line into simple commands (on ; & | newlines and parentheses), each a list of words,
// quotes removed. ok is false when a quote is left open: the caller then checks the words one by one.
func splitCommands(line string) ([][]shellWord, bool) {
	var cmds [][]shellWord
	var cur []shellWord
	var word strings.Builder
	inWord, dynamic := false, false
	endWord := func() {
		if inWord {
			cur = append(cur, shellWord{text: word.String(), dynamic: dynamic})
		}
		word.Reset()
		inWord, dynamic = false, false
	}
	endCmd := func() {
		endWord()
		if len(cur) > 0 {
			cmds = append(cmds, cur)
		}
		cur = nil
	}
	runes := []rune(line)
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		switch {
		case r == '\\' && i+1 < len(runes):
			i++
			word.WriteRune(runes[i])
			inWord = true
		case r == '\'':
			end := indexRune(runes, i+1, '\'')
			if end < 0 {
				return cmds, false
			}
			word.WriteString(string(runes[i+1 : end]))
			inWord, i = true, end
		case r == '"':
			end := i + 1
			for ; end < len(runes) && runes[end] != '"'; end++ {
				if runes[end] == '\\' {
					end++
				} else if runes[end] == '$' || runes[end] == '`' {
					dynamic = true
				}
			}
			if end >= len(runes) {
				return cmds, false
			}
			word.WriteString(string(runes[i+1 : end]))
			inWord, i = true, end
		case r == '$' || r == '`':
			dynamic = true
			word.WriteRune(r)
			inWord = true
		case r == ';' || r == '&' || r == '|' || r == '\n' || r == '(' || r == ')':
			endCmd()
		case r == ' ' || r == '\t' || r == '\r':
			endWord()
		default:
			word.WriteRune(r)
			inWord = true
		}
	}
	endCmd()
	return cmds, true
}

func indexRune(runes []rune, from int, r rune) int {
	for i := from; i < len(runes); i++ {
		if runes[i] == r {
			return i
		}
	}
	return -1
}

func commandDenyReason(line string, c PermissionCheck) string {
	cmds, ok := splitCommands(line)
	if !ok {
		// Unreadable: every word is checked, and any rm or git push in it is taken at its worst.
		var words []shellWord
		for _, f := range strings.Fields(line) {
			words = append(words, shellWord{text: strings.Trim(f, `'"`), dynamic: strings.ContainsAny(f, "$`")})
		}
		cmds = [][]shellWord{words}
		for i := 1; i < len(words); i++ {
			switch path.Base(words[i].text) {
			case "rm", "git", "security":
				cmds = append(cmds, words[i:])
			}
		}
	}
	cwd, cwdKnown := c.Cwd, true
	for _, words := range cmds {
		for _, w := range words {
			if isCredentialPath(strings.TrimLeft(w.text, "<>&0123456789"), c.Home) {
				return reasonCredential + clipDetail(w.text)
			}
		}
		words = stripWrappers(words)
		if len(words) == 0 {
			continue
		}
		name := path.Base(words[0].text)
		switch name {
		case "cd":
			cwd, cwdKnown = changeDir(cwd, cwdKnown, words[1:], c.Home)
		case "security":
			return reasonKeychain
		case "rm":
			if target := removeTarget(words[1:], cwd, cwdKnown, c); target != "" {
				return reasonRemove + clipDetail(target)
			}
		case "git":
			if branch := forcePushTarget(words[1:], cwd, cwdKnown, c); branch != "" {
				return reasonForcePush + clipDetail(branch)
			}
		}
	}
	return ""
}

// stripWrappers drops leading assignments (FOO=bar) and the programs that run the next word (sudo, env…), with their
// options.
func stripWrappers(words []shellWord) []shellWord {
	for len(words) > 0 {
		w := words[0].text
		if eq := strings.IndexByte(w, '='); eq > 0 && !strings.ContainsAny(w[:eq], "/-") {
			words = words[1:]
			continue
		}
		if !commandWrappers[path.Base(w)] {
			return words
		}
		words = words[1:]
		for len(words) > 0 && strings.HasPrefix(words[0].text, "-") {
			words = words[1:]
		}
	}
	return words
}

func changeDir(cwd string, known bool, args []shellWord, home string) (string, bool) {
	if len(args) == 0 {
		return home, home != ""
	}
	arg := args[0]
	if arg.dynamic || arg.text == "-" {
		return "", false
	}
	dir := expandHome(arg.text, home)
	if filepath.IsAbs(dir) {
		return filepath.Clean(dir), true
	}
	if !known || cwd == "" {
		return "", false
	}
	return filepath.Join(cwd, dir), true
}

func expandHome(p string, home string) string {
	if home == "" {
		return p
	}
	if p == "~" {
		return home
	}
	if strings.HasPrefix(p, "~/") {
		return filepath.Join(home, p[2:])
	}
	return p
}

// within tells whether p is dir or inside it.
func within(p string, dir string) bool {
	if dir == "" {
		return false
	}
	rel, err := filepath.Rel(dir, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, "../")
}

// removeTarget returns the first operand of a recursive or forced rm that lies outside the session's folder and the
// temporary folders, "" when there is none.
func removeTarget(args []shellWord, cwd string, cwdKnown bool, c PermissionCheck) string {
	forced := false
	var operands []shellWord
	options := true
	for _, a := range args {
		if options && a.text == "--" {
			options = false
			continue
		}
		if options && strings.HasPrefix(a.text, "--") {
			forced = forced || a.text == "--recursive" || a.text == "--force"
			continue
		}
		if options && strings.HasPrefix(a.text, "-") && len(a.text) > 1 {
			forced = forced || strings.ContainsAny(a.text[1:], "rRf")
			continue
		}
		operands = append(operands, a)
	}
	if !forced {
		return ""
	}
	// Operands resolve against the current folder (after a cd); they must stay in the session's own folder.
	curDir := ""
	if cwdKnown && cwd != "" && filepath.IsAbs(cwd) {
		curDir = filepath.Clean(cwd)
	}
	sessionDir := ""
	if c.Cwd != "" && filepath.IsAbs(c.Cwd) {
		sessionDir = filepath.Clean(c.Cwd)
	}
	// A session started in the home folder or at the root has no folder of its own to clean.
	if sessionDir == "/" || (c.Home != "" && sessionDir == filepath.Clean(c.Home)) {
		sessionDir = ""
	}
	for _, op := range operands {
		if op.dynamic || strings.HasPrefix(op.text, "~") {
			return op.text
		}
		p := op.text
		if !filepath.IsAbs(p) {
			if curDir == "" {
				return op.text
			}
			p = filepath.Join(curDir, p)
		}
		p = filepath.Clean(p)
		if inTempDir(p, c.TempDirs) {
			continue
		}
		if sessionDir != "" && within(p, sessionDir) && p != sessionDir {
			continue
		}
		return op.text
	}
	return ""
}

func inTempDir(p string, temps []string) bool {
	for _, t := range temps {
		if t != "" && within(p, filepath.Clean(t)) && p != filepath.Clean(t) {
			return true
		}
	}
	return false
}

// forcePushTarget returns the main branch a forced or deleting git push would change, "" when it changes none.
func forcePushTarget(args []shellWord, cwd string, cwdKnown bool, c PermissionCheck) string {
	dir, dirKnown := cwd, cwdKnown
	i := 0
	for ; i < len(args); i++ {
		a := args[i].text
		if a == "-C" && i+1 < len(args) {
			dir, dirKnown = changeDir(dir, dirKnown, args[i+1:i+2], c.Home)
			i++
			continue
		}
		if gitValueOptions[a] {
			i++
			continue
		}
		if !strings.HasPrefix(a, "-") {
			break
		}
	}
	if i >= len(args) || args[i].text != "push" {
		return ""
	}
	forced, all := false, false
	var positional []shellWord
	for _, a := range args[i+1:] {
		t := a.text
		switch {
		case t == "--force" || t == "--delete" || t == "--mirror" || t == "--force-if-includes" || strings.HasPrefix(t, "--force-with-lease"):
			forced = true
			all = all || t == "--mirror"
		case t == "--all" || t == "--branches":
			all = true
		case strings.HasPrefix(t, "--"):
		case strings.HasPrefix(t, "-") && len(t) > 1:
			forced = forced || strings.ContainsAny(t[1:], "fd")
		default:
			positional = append(positional, a)
		}
	}
	var refspecs []shellWord
	if len(positional) > 1 {
		refspecs = positional[1:]
	}
	for _, r := range refspecs {
		if strings.HasPrefix(r.text, "+") || strings.HasPrefix(r.text, ":") {
			forced = true
		}
	}
	if !forced {
		return ""
	}
	if all {
		return "every branch"
	}
	current := func() string {
		if !dirKnown || c.Branch == nil {
			return ""
		}
		return c.Branch(dir)
	}
	if len(refspecs) == 0 {
		branch := current()
		if branch == "" {
			return "the current branch (unknown)"
		}
		if mainBranches[branch] {
			return branch
		}
		return ""
	}
	for _, r := range refspecs {
		if r.dynamic {
			return r.text
		}
		dst := strings.TrimPrefix(r.text, "+")
		if colon := strings.LastIndexByte(dst, ':'); colon >= 0 {
			dst = dst[colon+1:]
		}
		dst = strings.TrimPrefix(dst, "refs/heads/")
		if dst == "HEAD" || dst == "@" {
			dst = current()
			if dst == "" {
				return "HEAD (unknown branch)"
			}
		}
		if mainBranches[dst] {
			return dst
		}
	}
	return ""
}

var credentialNames = map[string]bool{
	".netrc": true, ".git-credentials": true, ".npmrc": true, ".pypirc": true,
	"id_rsa": true, "id_ed25519": true, "id_ecdsa": true, "id_dsa": true,
}

var credentialExts = []string{".pem", ".p12", ".pfx", ".key"}

var credentialSuffixes = []string{"/.aws/credentials", "/.docker/config.json", "/.kube/config", "/.config/gh/hosts.yml"}

var credentialDirs = []string{"/.ssh", "/.gnupg", "/.password-store", "/library/keychains"}

var envExampleSuffixes = []string{".example", ".sample", ".template", ".dist"}

// isCredentialPath tells whether a path names a credential file or folder (DS-SHELL-111).
func isCredentialPath(p string, home string) bool {
	if p == "" || strings.ContainsAny(p, " \t\n") {
		return false
	}
	p = strings.ToLower("/" + strings.TrimPrefix(expandHome(p, home), "/"))
	p = strings.TrimSuffix(p, "/")
	base := path.Base(p)
	if credentialNames[base] {
		return true
	}
	for _, ext := range credentialExts {
		if len(base) > len(ext) && strings.HasSuffix(base, ext) {
			return true
		}
	}
	for _, s := range credentialSuffixes {
		if strings.HasSuffix(p, s) {
			return true
		}
	}
	for _, d := range credentialDirs {
		if strings.HasSuffix(p, d) || strings.Contains(p, d+"/") {
			return true
		}
	}
	if base == ".env" || strings.HasPrefix(base, ".env.") {
		for _, s := range envExampleSuffixes {
			if strings.HasSuffix(base, s) {
				return false
			}
		}
		return true
	}
	return false
}
