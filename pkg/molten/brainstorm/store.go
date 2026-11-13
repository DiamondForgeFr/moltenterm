// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
)

// The folders of DS-BOSS-010: one per idea under the brainstorms folder the developer owns (boss:brainstormsdir,
// ~/MoltenTerm/Brainstorms by default). Each file is written whole to a temporary file, synced, then renamed over the
// old one, so a crash leaves the previous turn's files, never half of one. Which brainstorm is open is MoltenTerm's own
// state, kept in its data folder: the developer's folder holds only their ideas.

const (
	InfoFile         = "brainstorm.json"
	GraphFile        = "graph.json"
	ConversationFile = "conversation.jsonl"
	currentFile      = "current.json"

	InfoSchema  = 1
	SourceBrokk = "brokk"
	// The states of brainstorm.json (DS-BOSS-010); must match frontend/moltenterm-shell/brainstorm/brainstorm-model.ts.
	// open is in progress; done: Brokk marked it finished on the developer's word (#2285); clear: his conclusion and its
	// brief are written, still in progress until it becomes a project; promoted: it became one (#2250).
	StateOpen     = "open"
	StateDone     = "done"
	StateClear    = "clear"
	StatePromoted = "promoted"

	// DefaultDirName is the brainstorms folder under the home folder when boss:brainstormsdir is unset.
	DefaultDirName = "MoltenTerm/Brainstorms"
	maxSlugLen     = 48
	maxSlugTries   = 1000
	fallbackSlug   = "idea"
)

var knownStates = map[string]bool{
	StateOpen:     true,
	StateDone:     true,
	StateClear:    true,
	StatePromoted: true,
}

// checkedState is a state of DS-BOSS-010; any other one read from a folder is in progress.
func checkedState(state string) string {
	if knownStates[state] {
		return state
	}
	return StateOpen
}

// Promotion is brainstorm.json's promotedto (#2250): the project folder it became, the workspace that folder was linked
// to (its id, "" until the window linked it), and when.
type Promotion struct {
	Dir       string `json:"dir"`
	Workspace string `json:"workspace,omitempty"`
	At        int64  `json:"at"`
}

// workspaceIdPattern: a workspace's id as wavesrv makes one.
var workspaceIdPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

// checkedPromotion is a promotedto read from the developer's folder as MoltenTerm writes one, nil otherwise: a hand may
// have changed it, and its folder is shown and revealed.
func checkedPromotion(p *Promotion) *Promotion {
	if p == nil || p.Dir == "" || !filepath.IsAbs(p.Dir) {
		return nil
	}
	rtn := Promotion{Dir: filepath.Clean(p.Dir), At: p.At}
	if workspaceIdPattern.MatchString(p.Workspace) {
		rtn.Workspace = p.Workspace
	}
	return &rtn
}

// Info is brainstorm.json.
type Info struct {
	Schema  int    `json:"schema"`
	Id      string `json:"id"`
	Slug    string `json:"slug"`
	Title   string `json:"title"`
	Created int64  `json:"created"`
	Updated int64  `json:"updated"`
	State   string `json:"state"`
	// Language: the BCP-47 tag of the talk (#2250), from what the developer wrote, else the interface's.
	Language   string     `json:"language,omitempty"`
	Source     string     `json:"source"`
	Siblings   []string   `json:"siblings"`
	PromotedTo *Promotion `json:"promotedto"`
	// Named: the developer gave the title (Rename, #2248); the centre's text no longer replaces it.
	Named bool `json:"named,omitempty"`
}

// Turn is one line of conversation.jsonl: what the developer said or what Brokk answered, without his blocks.
type Turn struct {
	Turn int    `json:"turn"`
	At   int64  `json:"at"`
	Role string `json:"role"`
	Text string `json:"text"`
}

const (
	RoleYou   = "you"
	RoleBrokk = "brokk"
)

// Saved is one brainstorm on disk.
type Saved struct {
	Dir   string
	Info  Info
	Graph Graph
	Turns []Turn
	// History is history.jsonl (#2247): the last operations, who made each and what puts it back.
	History []HistoryEntry
	// Brief is brief.json once Brokk concluded (#2250); nil before.
	Brief *ProjectBrief
}

// Store reads and writes the folders. root gives the brainstorms folder at each call, so a change of the setting
// applies to the next idea; stateDir is MoltenTerm's own. trash moves a forgotten folder to the system trash, and
// canTrash says whether the system has one.
type Store struct {
	root     func() string
	stateDir string
	trash    func(path string) (string, error)
	canTrash func() bool
}

func MakeStore(root func() string, stateDir string) *Store {
	return &Store{root: root, stateDir: stateDir}
}

// UseTrash sets how a forgotten folder goes to the trash, and whether the system has one (nil: it has).
func (s *Store) UseTrash(trash func(path string) (string, error), canTrash func() bool) {
	s.trash = trash
	s.canTrash = canTrash
}

// slugReplacements spell the accented letters of the languages MoltenTerm speaks the way a folder name can.
var slugReplacements = map[rune]string{
	'à': "a", 'á': "a", 'â': "a", 'ä': "a", 'ã': "a", 'å': "a",
	'ç': "c",
	'è': "e", 'é': "e", 'ê': "e", 'ë': "e",
	'ì': "i", 'í': "i", 'î': "i", 'ï': "i",
	'ñ': "n",
	'ò': "o", 'ó': "o", 'ô': "o", 'ö': "o", 'õ': "o", 'ø': "o",
	'ù': "u", 'ú': "u", 'û': "u", 'ü': "u",
	'ý': "y", 'ÿ': "y",
	'œ': "oe", 'æ': "ae", 'ß': "ss",
}

// Slug makes a folder name out of a title: lower case letters, digits and hyphens, at most 48 characters, never
// empty. Nothing of the model's text other than these characters reaches a path.
func Slug(title string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(title) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			dash = false
		case slugReplacements[r] != "":
			b.WriteString(slugReplacements[r])
			dash = false
		case unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsSpace(r) || unicode.IsPunct(r) || unicode.IsSymbol(r):
			if !dash && b.Len() > 0 {
				b.WriteRune('-')
				dash = true
			}
		}
	}
	slug := strings.Trim(b.String(), "-")
	if len(slug) > maxSlugLen {
		slug = strings.TrimRight(slug[:maxSlugLen], "-")
	}
	if slug == "" {
		return fallbackSlug
	}
	return slug
}

func newId() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return fmt.Sprintf("%x", os.Getpid())
	}
	return hex.EncodeToString(raw[:])
}

// Create makes the folder of a new idea: the slug of its title, or the first free "<slug>-<n>". The folder is created
// exclusively, so two ideas never share one and an existing folder is never written into.
func (s *Store) Create(title string, now int64) (Saved, error) {
	root := s.root()
	if root == "" {
		return Saved{}, errors.New("no brainstorms folder")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return Saved{}, err
	}
	base := Slug(title)
	for n := 1; n <= maxSlugTries; n++ {
		slug := base
		if n > 1 {
			slug = fmt.Sprintf("%s-%d", base, n)
		}
		dir := filepath.Join(root, slug)
		err := os.Mkdir(dir, 0o700)
		if errors.Is(err, os.ErrExist) {
			continue
		}
		if err != nil {
			return Saved{}, err
		}
		info := Info{
			Schema:   InfoSchema,
			Id:       newId(),
			Slug:     slug,
			Title:    CleanText(title),
			Created:  now,
			Updated:  now,
			State:    StateOpen,
			Source:   SourceBrokk,
			Siblings: []string{},
		}
		return Saved{Dir: dir, Info: info, Graph: EmptyGraph(), Turns: []Turn{}, History: []HistoryEntry{}}, nil
	}
	return Saved{}, fmt.Errorf("no free folder name for %q", base)
}

// writeAtomic replaces path with data: a crash leaves the old file or the new one, whole.
func writeAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	keep := false
	defer func() {
		if !keep {
			_ = os.Remove(tmpName)
		}
	}()
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	keep = true
	return nil
}

func conversationBytes(turns []Turn) ([]byte, error) {
	var buf bytes.Buffer
	for _, turn := range turns {
		line, err := json.Marshal(turn)
		if err != nil {
			return nil, err
		}
		buf.Write(line)
		buf.WriteByte('\n')
	}
	return buf.Bytes(), nil
}

// Save writes the three files of a brainstorm. The graph and the conversation go first, the info last: its
// `updated` says the folder is whole up to that turn.
func (s *Store) Save(saved Saved) error {
	graph, err := json.MarshalIndent(saved.Graph, "", "  ")
	if err != nil {
		return err
	}
	conversation, err := conversationBytes(saved.Turns)
	if err != nil {
		return err
	}
	info, err := json.MarshalIndent(saved.Info, "", "  ")
	if err != nil {
		return err
	}
	if err := writeAtomic(filepath.Join(saved.Dir, GraphFile), append(graph, '\n')); err != nil {
		return err
	}
	if err := writeAtomic(filepath.Join(saved.Dir, ConversationFile), conversation); err != nil {
		return err
	}
	if len(saved.History) > 0 {
		history, err := historyBytes(saved.History)
		if err != nil {
			return err
		}
		if err := writeAtomic(filepath.Join(saved.Dir, HistoryFile), history); err != nil {
			return err
		}
	}
	return writeAtomic(filepath.Join(saved.Dir, InfoFile), append(info, '\n'))
}

func cutText(text string, max int) string {
	if runes := []rune(text); len(runes) > max {
		return string(runes[:max])
	}
	return text
}

// Load reads a brainstorm's folder back. A graph that does not read, or breaks the rules a block obeys, is an error:
// the folder is the developer's, and nothing is guessed in its place.
func (s *Store) Load(dir string) (Saved, error) {
	var saved Saved
	saved.Dir = dir
	data, err := os.ReadFile(filepath.Join(dir, InfoFile))
	if err != nil {
		return Saved{}, err
	}
	if err := json.Unmarshal(data, &saved.Info); err != nil {
		return Saved{}, fmt.Errorf("%s: %w", InfoFile, err)
	}
	saved.Info.Title = cutText(CleanText(saved.Info.Title), MaxText)
	// The folder's own name: made again with Slug, a long title's "-2" would be cut and two folders share a slug.
	saved.Info.Slug = filepath.Base(dir)
	// The developer's folder may have been changed by hand: an id or a state that is not of the patterns MoltenTerm
	// writes never reaches his resume brief or a reference.
	saved.Info.Id = checkedId(saved.Info.Id)
	saved.Info.State = checkedState(saved.Info.State)
	saved.Info.Language = CleanLanguage(saved.Info.Language)
	saved.Info.PromotedTo = checkedPromotion(saved.Info.PromotedTo)
	if saved.Info.Siblings == nil {
		saved.Info.Siblings = []string{}
	}
	if brief, ok := ReadBrief(dir); ok {
		saved.Brief = &brief
	}
	data, err = os.ReadFile(filepath.Join(dir, GraphFile))
	if err != nil {
		return Saved{}, err
	}
	var graph Graph
	if err := json.Unmarshal(data, &graph); err != nil {
		return Saved{}, fmt.Errorf("%s: %w", GraphFile, err)
	}
	if saved.Graph, err = ValidateGraph(graph); err != nil {
		return Saved{}, fmt.Errorf("%s: %w", GraphFile, err)
	}
	// The graph never depends on its history: one that does not read leaves only the Undo of what came before.
	if saved.History, err = loadHistory(dir); err != nil {
		saved.History = []HistoryEntry{}
	}
	saved.Turns = []Turn{}
	file, err := os.Open(filepath.Join(dir, ConversationFile))
	if errors.Is(err, os.ErrNotExist) {
		return saved, nil
	}
	if err != nil {
		return Saved{}, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		var turn Turn
		if json.Unmarshal(scanner.Bytes(), &turn) == nil {
			saved.Turns = append(saved.Turns, turn)
		}
	}
	return saved, scanner.Err()
}

type current struct {
	Dir string `json:"dir"`
}

// Remember keeps which brainstorm is open, for the next start of MoltenTerm.
func (s *Store) Remember(dir string) error {
	if err := os.MkdirAll(s.stateDir, 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(current{Dir: dir})
	if err != nil {
		return err
	}
	return writeAtomic(filepath.Join(s.stateDir, currentFile), data)
}

// Current loads the brainstorm open last. ok is false when none was or its folder is gone; err says why a folder still
// there does not load, and the developer's next start opens a new brainstorm instead.
func (s *Store) Current() (saved Saved, ok bool, err error) {
	data, err := os.ReadFile(filepath.Join(s.stateDir, currentFile))
	if err != nil {
		return Saved{}, false, nil
	}
	var cur current
	if json.Unmarshal(data, &cur) != nil || cur.Dir == "" {
		return Saved{}, false, nil
	}
	saved, err = s.Load(cur.Dir)
	if errors.Is(err, os.ErrNotExist) {
		return Saved{}, false, nil
	}
	if err != nil {
		return Saved{}, false, err
	}
	return saved, true, nil
}
