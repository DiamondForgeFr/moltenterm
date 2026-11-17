// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Package agentchain is the responsibility chain of the agents (FR-REV-035): which agents a lead handed work to. The
// Integration panel follows the agents of a view and the sub-agents they delegated to, at any depth (FR-REV-034). A
// link is recorded where MoltenTerm sees a delegation (a hand-off to another agent by first name), never guessed from
// names, and kept in a small file of MoltenTerm's data folder so it survives a restart and the closing of the
// sub-agent's pane: its pull requests are signed with its first name long after.
package agentchain

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
)

const (
	// FileName is the chain's file, in MoltenTerm's data folder under molten/.
	FileName = "agentchain.json"

	// ViaHandoff: the lead handed work to the sub-agent by its first name (FR-CONT-015).
	ViaHandoff = "handoff"

	fileVersion = 1
	// A first name is freed when its session ends and drawn again later: a link older than this has probably outlived
	// the agent that made it.
	maxEdgeAge = 30 * 24 * time.Hour
	maxEdges   = 500
	maxNameLen = 64
)

// Edge is one delegation: Lead handed work to Sub. The blocks are the terminals that held the names then; a name that
// a later session of another terminal holds does not inherit the link.
type Edge struct {
	Lead      string `json:"lead"`
	Sub       string `json:"sub"`
	LeadBlock string `json:"leadblock,omitempty"`
	SubBlock  string `json:"subblock,omitempty"`
	Via       string `json:"via"`
	// At: when the delegation happened, in Unix milliseconds.
	At int64 `json:"at"`
}

type fileData struct {
	Version int    `json:"v"`
	Edges   []Edge `json:"edges"`
}

type Registry struct {
	path string
	now  func() time.Time

	lock  sync.Mutex
	edges []Edge
}

// Fold compares first names without case, accents or spacing: "jerome" finds Jérôme.
func Fold(name string) string {
	name = strings.ToLower(strings.TrimSpace(name))
	return strings.Map(func(r rune) rune {
		switch r {
		case 'à', 'â', 'ä', 'á', 'ã':
			return 'a'
		case 'é', 'è', 'ê', 'ë':
			return 'e'
		case 'î', 'ï', 'í':
			return 'i'
		case 'ô', 'ö', 'ó', 'õ':
			return 'o'
		case 'ù', 'û', 'ü', 'ú':
			return 'u'
		case 'ç':
			return 'c'
		}
		return r
	}, strings.Join(strings.Fields(name), " "))
}

func cleanName(name string) string {
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, name)
	runes := []rune(strings.Join(strings.Fields(name), " "))
	if len(runes) > maxNameLen {
		runes = runes[:maxNameLen]
	}
	return string(runes)
}

// Open reads the chain from path ("" keeps it in memory only). A file that cannot be read is an empty chain: the
// links come back with the next delegations, and the file is rewritten whole.
func Open(path string) *Registry {
	r := &Registry{path: path, now: time.Now}
	r.edges = r.read()
	return r
}

func (r *Registry) read() []Edge {
	if r.path == "" {
		return nil
	}
	data, err := os.ReadFile(r.path)
	if err != nil {
		return nil
	}
	var file fileData
	if json.Unmarshal(data, &file) != nil || file.Version != fileVersion {
		return nil
	}
	var rtn []Edge
	for _, e := range file.Edges {
		e.Lead, e.Sub = cleanName(e.Lead), cleanName(e.Sub)
		if e.Lead == "" || e.Sub == "" || Fold(e.Lead) == Fold(e.Sub) {
			continue
		}
		rtn = append(rtn, e)
	}
	return rtn
}

func (r *Registry) write() error {
	if r.path == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(r.path), 0700); err != nil {
		return err
	}
	data, err := json.Marshal(fileData{Version: fileVersion, Edges: r.edges})
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(r.path), FileName+".*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), r.path)
}

// Edges gives the links, the oldest first.
func (r *Registry) Edges() []Edge {
	r.lock.Lock()
	defer r.lock.Unlock()
	r.pruneLocked()
	return append([]Edge{}, r.edges...)
}

func (r *Registry) pruneLocked() {
	cutoff := r.now().Add(-maxEdgeAge).UnixMilli()
	kept := r.edges[:0:0]
	for _, e := range r.edges {
		if e.At >= cutoff {
			kept = append(kept, e)
		}
	}
	r.edges = kept
}

// Record notes that lead handed work to sub. changed: the chain differs from before (a new link, or a link of a name a
// new session holds). A link that would close a loop (sub already leads lead, at any depth) is refused, as is one
// between an agent and itself.
func (r *Registry) Record(lead string, sub string, leadBlock string, subBlock string, via string) (bool, error) {
	lead, sub = cleanName(lead), cleanName(sub)
	if lead == "" || sub == "" {
		return false, errors.New("a link names both agents")
	}
	if Fold(lead) == Fold(sub) {
		return false, errors.New("an agent cannot lead itself")
	}
	r.lock.Lock()
	defer r.lock.Unlock()
	r.pruneLocked()
	r.dropStaleLocked(lead, leadBlock)
	r.dropStaleLocked(sub, subBlock)
	if containsFold(Subs(r.edges, sub), lead) {
		return false, errors.New("that link would make an agent lead its own lead")
	}
	now := r.now().UnixMilli()
	changed := true
	for i := range r.edges {
		e := &r.edges[i]
		if Fold(e.Lead) == Fold(lead) && Fold(e.Sub) == Fold(sub) {
			e.At, e.Via, e.Lead, e.Sub = now, via, lead, sub
			e.LeadBlock, e.SubBlock = leadBlock, subBlock
			changed = false
			break
		}
	}
	if changed {
		r.edges = append(r.edges, Edge{Lead: lead, Sub: sub, LeadBlock: leadBlock, SubBlock: subBlock, Via: via, At: now})
		if len(r.edges) > maxEdges {
			r.edges = append([]Edge(nil), r.edges[len(r.edges)-maxEdges:]...)
		}
	}
	return changed, r.write()
}

// dropStaleLocked forgets the links of a name that another terminal holds now: they were its previous holder's.
func (r *Registry) dropStaleLocked(name string, block string) {
	if block == "" {
		return
	}
	kept := r.edges[:0:0]
	for _, e := range r.edges {
		if Fold(e.Lead) == Fold(name) && e.LeadBlock != "" && e.LeadBlock != block {
			continue
		}
		if Fold(e.Sub) == Fold(name) && e.SubBlock != "" && e.SubBlock != block {
			continue
		}
		kept = append(kept, e)
	}
	r.edges = kept
}

func containsFold(names []string, name string) bool {
	for _, n := range names {
		if Fold(n) == Fold(name) {
			return true
		}
	}
	return false
}

// Subs gives the sub-agents of the leads at any depth, each once, in the order they are first reached; the leads
// themselves are not in it.
func Subs(edges []Edge, leads ...string) []string {
	seen := map[string]bool{}
	for _, l := range leads {
		seen[Fold(l)] = true
	}
	var rtn []string
	queue := append([]string(nil), leads...)
	for len(queue) > 0 {
		cur := Fold(queue[0])
		queue = queue[1:]
		for _, e := range edges {
			if Fold(e.Lead) != cur || seen[Fold(e.Sub)] {
				continue
			}
			seen[Fold(e.Sub)] = true
			rtn = append(rtn, e.Sub)
			queue = append(queue, e.Sub)
		}
	}
	return rtn
}

// LeadOf gives the lead that handed work to sub last, "" when none did.
func LeadOf(edges []Edge, sub string) string {
	var rtn string
	var at int64 = -1
	for _, e := range edges {
		if Fold(e.Sub) == Fold(sub) && e.At > at {
			rtn, at = e.Lead, e.At
		}
	}
	return rtn
}
