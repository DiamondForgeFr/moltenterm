// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agenthandoff

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The brief on disk (DS-CONT-029, NFR-CONT-006): <data>/molten/handoffs/<time>-<from>-to-<to>-<id>/brief.md, with the
// file snapshots in files/ next to it. Nothing is written in a project.

const (
	HandoffsDirName = "handoffs"
	BriefFileName   = "brief.md"
	SnapshotDirName = "files"

	// Briefs older than this are swept when a new one is written.
	BriefRetention = 30 * 24 * time.Hour

	maxGoalLen      = 4000
	maxContextLen   = 64 * 1024
	maxNoteLen      = 1000
	maxExcerptLen   = 16 * 1024
	maxFiles        = 50
	maxLinks        = 50
	maxQuotedLines  = 400
	maxQuotedBytes  = 32 * 1024
	maxSnapshotSize = 2 << 20
	maxSnapshotsAll = 20 << 20
	maxTitleLen     = 200
	maxUrlLen       = 2048
)

// Files a brief never quotes nor copies: they may hold secrets (UR-CONT-005), whatever the sender asked.
var secretFileNames = []string{".env", ".npmrc", ".netrc", ".pgpass", ".pypirc", ".git-credentials", ".htpasswd", "id_rsa",
	"id_ed25519", "id_ecdsa", "id_dsa", "credentials", "kubeconfig"}
var secretFileExts = []string{".pem", ".key", ".p12", ".pfx", ".keystore", ".jks", ".ppk", ".tfvars", ".tfvars.json",
	".tfstate", ".kubeconfig"}

// Folders whose every file may hold secrets (~/.ssh/config, ~/.kube/config…).
var secretDirNames = []string{".ssh", ".gnupg", ".aws", ".kube", ".password-store", "keychains"}

var errGoalRequired = errors.New("brief.goal is required: say what the receiver must do and the expected result")

// Party is one end of a handoff, as the brief and the typed prompt name it.
type Party struct {
	BlockId     string
	FirstName   string
	Agent       string
	AgentName   string
	Project     string
	ProjectDir  string
	Folder      string
	WorkspaceId string
	Workspace   string
	TabId       string
	Tab         string
	// App: MoltenTerm itself wrote the request, on the developer's click (#1143).
	App bool
}

// label: "Camille (Claude Code)", "a terminal" for a pane without an agent.
func (p Party) label() string {
	switch {
	case p.FirstName != "" && p.AgentName != "":
		return p.FirstName + " (" + p.AgentName + ")"
	case p.FirstName != "":
		return p.FirstName
	case p.AgentName != "":
		return p.AgentName
	}
	return "a terminal"
}

// callName: the first name, else the agent's name, else "a terminal".
func (p Party) callName() string {
	if p.FirstName != "" {
		return p.FirstName
	}
	if p.AgentName != "" {
		return p.AgentName
	}
	return "a terminal"
}

func cleanLine(text string) string {
	text = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' {
			return ' '
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, text)
	return strings.Join(strings.Fields(text), " ")
}

// cleanBlock keeps the text's lines and drops other control characters.
func cleanBlock(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, text)
	return strings.TrimSpace(text)
}

func cut(text string, max int) string {
	runes := []rune(text)
	if len(runes) <= max {
		return text
	}
	return string(runes[:max-1]) + "…"
}

// cleanBrief bounds and cleans what the sender gave; relative paths are taken from the sender's folder.
func cleanBrief(b Brief, senderFolder string) (Brief, error) {
	rtn := Brief{
		Goal:    cut(cleanBlock(b.Goal), maxGoalLen),
		Context: cut(cleanBlock(b.Context), maxContextLen),
		Reply:   b.Reply,
	}
	if rtn.Goal == "" {
		return Brief{}, errGoalRequired
	}
	if len(b.Files) > maxFiles {
		return Brief{}, fmt.Errorf("brief.files lists at most %d files", maxFiles)
	}
	if len(b.Links) > maxLinks {
		return Brief{}, fmt.Errorf("brief.links lists at most %d links", maxLinks)
	}
	for _, f := range b.Files {
		path := strings.TrimSpace(f.Path)
		if path == "" {
			return Brief{}, errors.New("each entry of brief.files needs a path")
		}
		if strings.HasPrefix(path, "~/") {
			if home, err := os.UserHomeDir(); err == nil {
				path = filepath.Join(home, path[2:])
			}
		}
		if !filepath.IsAbs(path) {
			if senderFolder == "" {
				return Brief{}, fmt.Errorf("%s: give the file's absolute path", path)
			}
			path = filepath.Join(senderFolder, path)
		}
		lines := strings.TrimSpace(f.Lines)
		if lines != "" {
			if _, _, ok := parseLines(lines); !ok {
				return Brief{}, fmt.Errorf("%s: lines must be a line number or a range such as 40-60", path)
			}
		}
		rtn.Files = append(rtn.Files, FileRef{
			Path:    filepath.Clean(path),
			Project: cut(cleanLine(f.Project), maxTitleLen),
			Lines:   lines,
			Excerpt: cut(cleanBlock(f.Excerpt), maxExcerptLen),
			Note:    cut(cleanBlock(f.Note), maxNoteLen),
		})
	}
	for _, l := range b.Links {
		link := LinkRef{
			Url:   cut(cleanLine(l.Url), maxUrlLen),
			Title: cut(cleanLine(l.Title), maxTitleLen),
			Kind:  strings.ToLower(cleanLine(l.Kind)),
			TabId: l.TabId,
			Note:  cut(cleanBlock(l.Note), maxNoteLen),
		}
		if link.TabId > 0 {
			link.Kind = LinkKindBrowser
		}
		switch link.Kind {
		case "", LinkKindTicket, LinkKindPr, LinkKindSrs, LinkKindUrl, LinkKindBrowser:
		default:
			return Brief{}, fmt.Errorf("link kind %q: use ticket, pr, srs, url or browser", link.Kind)
		}
		if link.Url == "" && link.TabId <= 0 {
			return Brief{}, errors.New("each entry of brief.links needs a url (or the tabId of one of your browser tabs)")
		}
		if link.Kind == LinkKindBrowser && link.TabId <= 0 && !isWebUrl(link.Url) {
			return Brief{}, fmt.Errorf("%s: a browser page must be an http or https address", link.Url)
		}
		rtn.Links = append(rtn.Links, link)
	}
	return rtn, nil
}

func isWebUrl(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// parseLines reads "42" or "40-60".
func parseLines(spec string) (int, int, bool) {
	first, last, isRange := strings.Cut(spec, "-")
	start, err := strconv.Atoi(strings.TrimSpace(first))
	if err != nil || start < 1 {
		return 0, 0, false
	}
	if !isRange {
		return start, start, true
	}
	end, err := strconv.Atoi(strings.TrimSpace(last))
	if err != nil || end < start {
		return 0, 0, false
	}
	return start, end, true
}

// within tells whether path is dir or inside it.
func within(path string, dir string) bool {
	if dir == "" {
		return false
	}
	rel, err := filepath.Rel(dir, path)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// mayHoldSecrets checks the path as given and, through a link, the file it points to.
func mayHoldSecrets(path string) bool {
	if pathMayHoldSecrets(path) {
		return true
	}
	real, err := filepath.EvalSymlinks(path)
	return err == nil && real != path && pathMayHoldSecrets(real)
}

func pathMayHoldSecrets(path string) bool {
	base := strings.ToLower(filepath.Base(path))
	for _, name := range secretFileNames {
		if base == name || strings.HasPrefix(base, name+".") {
			return true
		}
	}
	for _, ext := range secretFileExts {
		if strings.HasSuffix(base, ext) {
			return true
		}
	}
	for _, part := range strings.Split(strings.ToLower(filepath.ToSlash(filepath.Dir(path))), "/") {
		for _, dir := range secretDirNames {
			if part == dir {
				return true
			}
		}
	}
	slashed := strings.ToLower(filepath.ToSlash(path))
	return strings.Contains(slashed, "/.config/gh/") || strings.HasSuffix(slashed, "/.docker/config.json")
}

// fileFacts is what writing the brief found about one file.
type fileFacts struct {
	ref      FileRef
	missing  bool
	isDir    bool
	quoted   string
	quoteErr string
	snapshot string
	// skipped: why no snapshot was made of a file outside the receiver's project.
	skipped string
}

func quoteLines(path string, spec string) (string, string) {
	start, end, ok := parseLines(spec)
	if !ok {
		return "", "the line range could not be read"
	}
	if end-start+1 > maxQuotedLines {
		end = start + maxQuotedLines - 1
	}
	f, err := os.Open(path)
	if err != nil {
		return "", "MoltenTerm could not read the file"
	}
	defer f.Close()
	reader := bufio.NewReader(f)
	var sb strings.Builder
	for n := 1; n <= end; n++ {
		line, err := reader.ReadString('\n')
		if n >= start && line != "" {
			if sb.Len()+len(line) > maxQuotedBytes {
				break
			}
			sb.WriteString(line)
		}
		if err != nil {
			break
		}
	}
	if sb.Len() == 0 {
		return "", "the file has no such lines"
	}
	return strings.TrimRight(sb.String(), "\n"), ""
}

func copyFile(src string, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, io.LimitReader(in, maxSnapshotSize+1))
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	return err
}

// fence returns a code fence longer than any run of backticks in the text.
func fence(text string) string {
	longest, run := 0, 0
	for _, r := range text {
		if r == '`' {
			run++
			longest = max(longest, run)
			continue
		}
		run = 0
	}
	return strings.Repeat("`", max(3, longest+1))
}

func slug(name string) string {
	name = foldName(name)
	var sb strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			sb.WriteRune(r)
		case r == ' ' || r == '-' || r == '_':
			sb.WriteRune('-')
		}
	}
	rtn := strings.Trim(sb.String(), "-")
	if rtn == "" {
		return "terminal"
	}
	return cut(rtn, 24)
}

func randomId() string {
	var buf [4]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return fmt.Sprintf("%08x", time.Now().UnixNano()&0xffffffff)
	}
	return hex.EncodeToString(buf[:])
}

// sweepBriefs removes the briefs older than the retention; a failure leaves them for the next write.
func sweepBriefs(root string, now time.Time) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil || now.Sub(info.ModTime()) < BriefRetention {
			continue
		}
		os.RemoveAll(filepath.Join(root, entry.Name()))
	}
}

// writeBrief writes the brief and its snapshots in the data folder and returns the brief's path. Files outside the
// receiver's project are copied next to it: the receiver may have no permission to read outside its project, while
// it must read the brief's folder anyway.
func writeBrief(dataDir string, from Party, to Party, b Brief, now time.Time) (string, error) {
	if dataDir == "" {
		return "", errors.New("MoltenTerm's data folder is unknown")
	}
	root := filepath.Join(dataDir, "molten", HandoffsDirName)
	if err := os.MkdirAll(root, 0700); err != nil {
		return "", err
	}
	sweepBriefs(root, now)
	dir := filepath.Join(root, fmt.Sprintf("%s-%s-to-%s-%s", now.Format("20060102-150405"), slug(from.callName()), slug(to.callName()), randomId()))
	if err := os.Mkdir(dir, 0700); err != nil {
		return "", err
	}
	facts := gatherFiles(dir, to, b.Files)
	path := filepath.Join(dir, BriefFileName)
	text := renderBrief(from, to, b, facts, now)
	if from.App {
		text = renderAppBrief(to, b, now, OutcomePathOf(path))
	}
	if err := os.WriteFile(path, []byte(text), 0600); err != nil {
		return "", err
	}
	return path, nil
}

func gatherFiles(dir string, to Party, files []FileRef) []fileFacts {
	rtn := make([]fileFacts, 0, len(files))
	total := int64(0)
	for i, f := range files {
		facts := fileFacts{ref: f}
		info, err := os.Stat(f.Path)
		if err != nil {
			facts.missing = true
			rtn = append(rtn, facts)
			continue
		}
		facts.isDir = info.IsDir()
		secret := mayHoldSecrets(f.Path)
		// The secrets rule comes before the quote: a quote pastes the content into the brief, wherever the file is.
		switch {
		case facts.isDir || f.Lines == "":
		case secret:
			facts.quoteErr = "it may hold secrets"
		default:
			facts.quoted, facts.quoteErr = quoteLines(f.Path, f.Lines)
		}
		readable := within(f.Path, to.ProjectDir) || within(f.Path, to.Folder)
		switch {
		case readable:
		case facts.isDir:
			facts.skipped = "a folder is not copied"
		case secret:
			facts.skipped = "not copied: it may hold secrets"
		case info.Size() > maxSnapshotSize:
			facts.skipped = fmt.Sprintf("not copied: larger than %d MB", maxSnapshotSize>>20)
		case total+info.Size() > maxSnapshotsAll:
			facts.skipped = fmt.Sprintf("not copied: the snapshots of one brief stay under %d MB", maxSnapshotsAll>>20)
		default:
			snapDir := filepath.Join(dir, SnapshotDirName)
			name := fmt.Sprintf("%02d-%s", i+1, filepath.Base(f.Path))
			err := os.MkdirAll(snapDir, 0700)
			if err == nil {
				err = copyFile(f.Path, filepath.Join(snapDir, name))
			}
			if err != nil {
				facts.skipped = "MoltenTerm could not copy it"
				break
			}
			total += info.Size()
			facts.snapshot = filepath.Join(snapDir, name)
		}
		rtn = append(rtn, facts)
	}
	return rtn
}

func partyLine(p Party) string {
	var sb strings.Builder
	sb.WriteString(p.label())
	if p.Project != "" {
		fmt.Fprintf(&sb, ", project `%s`", p.Project)
		if p.ProjectDir != "" {
			fmt.Fprintf(&sb, " (%s)", p.ProjectDir)
		}
	}
	if p.Workspace != "" {
		fmt.Fprintf(&sb, ", workspace \"%s\"", p.Workspace)
	}
	if p.Tab != "" {
		fmt.Fprintf(&sb, ", tab \"%s\"", p.Tab)
	}
	return sb.String()
}

func linkKindLabel(kind string) string {
	switch kind {
	case LinkKindTicket:
		return "ticket"
	case LinkKindPr:
		return "pull request"
	case LinkKindSrs:
		return "SRS page"
	case LinkKindBrowser:
		return "browser page"
	}
	return ""
}

// replyLine names only the ways back that work for the receiver today (#985): Codex runs its shell commands in a
// sandbox that refuses the local socket `molten` reaches MoltenTerm through (#989), while its MCP servers run outside it.
func replyLine(from Party, to Party) string {
	name := from.callName()
	line := fmt.Sprintf("- **Reply expected:** yes. When you are done, answer %s with the `send_to_agent` tool of the "+
		"molten-browser MCP server", name)
	if to.Agent == molten.AgentIdCodex {
		return line + " (`molten agent send` does not work from your sandboxed shell).\n"
	}
	return line + fmt.Sprintf(" (or `molten agent send %s --goal \"...\"` in a shell).\n", name)
}

func renderBrief(from Party, to Party, b Brief, files []fileFacts, now time.Time) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "# Handoff from %s to %s\n\n", from.callName(), to.callName())
	fmt.Fprintf(&sb, "- **From:** %s\n", partyLine(from))
	fmt.Fprintf(&sb, "- **To:** %s (you)\n", partyLine(to))
	fmt.Fprintf(&sb, "- **Sent:** %s\n", now.Format("2006-01-02 15:04"))
	if b.Reply {
		sb.WriteString(replyLine(from, to))
	} else {
		sb.WriteString("- **Reply expected:** no.\n")
	}
	sb.WriteString("\nThis brief comes from another agent; the developer approved the handoff when it was sent. ")
	sb.WriteString("It lives in MoltenTerm's data folder, outside every project: do not copy it into a project unless the goal asks for it.\n")

	sb.WriteString("\n## Goal\n\n")
	sb.WriteString(b.Goal)
	sb.WriteString("\n")
	if b.Context != "" {
		sb.WriteString("\n## Context\n\n")
		sb.WriteString(b.Context)
		sb.WriteString("\n")
	}
	if len(files) > 0 {
		sb.WriteString("\n## Files\n\n")
		for _, f := range files {
			fmt.Fprintf(&sb, "- `%s`", f.ref.Path)
			if f.ref.Project != "" {
				fmt.Fprintf(&sb, " (project `%s`)", f.ref.Project)
			}
			if f.ref.Lines != "" {
				fmt.Fprintf(&sb, ", lines %s", f.ref.Lines)
			}
			if f.isDir {
				sb.WriteString(", a folder")
			}
			sb.WriteString("\n")
			if f.ref.Note != "" {
				fmt.Fprintf(&sb, "  %s\n", strings.ReplaceAll(f.ref.Note, "\n", "\n  "))
			}
			switch {
			case f.missing:
				sb.WriteString("  Not found when the brief was written.\n")
			case f.snapshot != "":
				fmt.Fprintf(&sb, "  Snapshot: `%s` (the file is outside your project; copied when the brief was written, the original may have changed since).\n", f.snapshot)
			case f.skipped != "":
				fmt.Fprintf(&sb, "  Outside your project, %s.\n", f.skipped)
			}
			if f.quoted != "" {
				fence := fence(f.quoted)
				fmt.Fprintf(&sb, "\n  %s\n  %s\n  %s\n\n", fence, strings.ReplaceAll(f.quoted, "\n", "\n  "), fence)
			} else if f.quoteErr != "" {
				fmt.Fprintf(&sb, "  Lines %s not quoted: %s.\n", f.ref.Lines, f.quoteErr)
			}
			if f.ref.Excerpt != "" {
				fence := fence(f.ref.Excerpt)
				fmt.Fprintf(&sb, "\n  Excerpt from the sender:\n\n  %s\n  %s\n  %s\n\n", fence, strings.ReplaceAll(f.ref.Excerpt, "\n", "\n  "), fence)
			}
		}
	}
	if len(b.Links) > 0 {
		sb.WriteString("\n## Links\n\n")
		browser := false
		for _, l := range b.Links {
			title := l.Title
			if title == "" {
				title = l.Url
			}
			if isWebUrl(l.Url) {
				fmt.Fprintf(&sb, "- [%s](%s)", strings.ReplaceAll(title, "]", "\\]"), l.Url)
			} else {
				fmt.Fprintf(&sb, "- %s", title)
				if l.Title != "" && l.Url != "" {
					fmt.Fprintf(&sb, ": %s", l.Url)
				}
			}
			if label := linkKindLabel(l.Kind); label != "" {
				fmt.Fprintf(&sb, " (%s)", label)
			}
			sb.WriteString("\n")
			if l.Note != "" {
				fmt.Fprintf(&sb, "  %s\n", strings.ReplaceAll(l.Note, "\n", "\n  "))
			}
			browser = browser || l.Kind == LinkKindBrowser
		}
		if browser {
			sb.WriteString("\nOpen a browser page in your own MoltenTerm browser panel, next to your terminal: call `tabs_create`, then " +
				"`navigate` to its address (molten-browser MCP tools). The sender's tab is not shared with you, and the first " +
				"action on a site asks the developer as usual.\n")
		}
	}
	return sb.String()
}

// promptLine is the short prompt typed into the receiver's terminal: the sender header, the goal and the brief's path.
func promptLine(from Party, b Brief, briefPath string) string {
	header := "[From " + from.callName()
	if from.AgentName != "" && from.FirstName != "" {
		header += " · " + from.AgentName
	}
	if from.Project != "" {
		header += " · " + from.Project
	}
	header += "]"
	tail := " Read the brief first: " + briefPath
	if b.Reply {
		tail += " (reply expected: send_to_agent to " + from.callName() + ")"
	}
	room := max(maxPromptBytes-len(header)-len(tail)-1, 40)
	return header + " " + cutBytes(cleanLine(b.Goal), room) + tail
}

// Below termupdate's 600-byte cap on a typed line.
const maxPromptBytes = 590

// cutBytes cuts text to at most max bytes, on a character boundary, marking the cut with an ellipsis.
func cutBytes(text string, max int) string {
	if len(text) <= max {
		return text
	}
	limit := max - len("…")
	end := 0
	for i := range text {
		if i > limit {
			break
		}
		end = i
	}
	return text[:end] + "…"
}
