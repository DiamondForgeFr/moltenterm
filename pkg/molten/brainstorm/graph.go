// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Package brainstorm is wavesrv's side of Brokk's thought in 3D (FR-BOSS-010, DS-BOSS-009 to DS-BOSS-011, #2246): the
// graph his answers grow through a `brokk-graph` block, the brainstorm mode every view of every window shares, and the
// folders that keep each idea. The model only writes text: the window parses his block, this package validates it
// again, applies it, saves it and tells every view.
package brainstorm

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

// The limits of DS-BOSS-009; must match frontend/moltenterm-shell/brainstorm/brainstorm-graph-model.ts.
const (
	GraphSchema  = 1
	BlockVersion = 1
	MaxOps       = 40
	MaxNodes     = 400
	MaxLinks     = 800
	MaxText      = 160
)

// The kinds of a node.
const (
	KindTopic      = "topic"
	KindQuestion   = "question"
	KindAnswer     = "answer"
	KindIdea       = "idea"
	KindTheme      = "theme"
	KindDecision   = "decision"
	KindProposal   = "proposal"
	KindConclusion = "conclusion"
)

// The operations of a block. The first three are this story's; the others belong to the stories that follow (#2247 to
// #2250) and are skipped until then, so that a block written for a newer brief is not dropped whole.
const (
	OpCentre   = "centre"
	OpAdd      = "add"
	OpLink     = "link"
	OpEdit     = "edit"
	OpPropose  = "propose"
	OpConclude = "conclude"
	OpFork     = "fork"
	OpRemember = "remember"
)

const (
	TalkProject  = "project"
	TalkPersonal = "personal"
)

const StatusOpen = "open"

var idPattern = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)

// The kinds an `add` may give; the topic is the centre's and a proposal comes with `propose`.
var addKinds = map[string]bool{
	KindQuestion:   true,
	KindAnswer:     true,
	KindIdea:       true,
	KindTheme:      true,
	KindDecision:   true,
	KindConclusion: true,
}

var knownKinds = map[string]bool{
	KindTopic:      true,
	KindQuestion:   true,
	KindAnswer:     true,
	KindIdea:       true,
	KindTheme:      true,
	KindDecision:   true,
	KindProposal:   true,
	KindConclusion: true,
}

var laterOps = map[string]bool{
	OpEdit:     true,
	OpPropose:  true,
	OpConclude: true,
	OpFork:     true,
	OpRemember: true,
}

type Node struct {
	Id     string     `json:"id"`
	Kind   string     `json:"kind"`
	Text   string     `json:"text"`
	From   string     `json:"from,omitempty"`
	Status string     `json:"status"`
	Turn   int        `json:"turn"`
	At     int64      `json:"at"`
	Pos    [3]float64 `json:"pos"`
}

type Link struct {
	A    string `json:"a"`
	B    string `json:"b"`
	Why  string `json:"why,omitempty"`
	Turn int    `json:"turn"`
}

// Graph is graph.json (DS-BOSS-009): the centre's id, the nodes in the order they came, the cross-links.
type Graph struct {
	Schema int    `json:"schema"`
	Rev    int    `json:"rev"`
	Centre string `json:"centre"`
	Nodes  []Node `json:"nodes"`
	Links  []Link `json:"links"`
}

type Op struct {
	Op   string `json:"op"`
	Id   string `json:"id,omitempty"`
	Kind string `json:"kind,omitempty"`
	Text string `json:"text,omitempty"`
	From string `json:"from,omitempty"`
	A    string `json:"a,omitempty"`
	B    string `json:"b,omitempty"`
	Why  string `json:"why,omitempty"`
}

// Block is what one answer of his carries: {"v":1,"talk":"project","ops":[…]}.
type Block struct {
	V    int    `json:"v"`
	Talk string `json:"talk"`
	Ops  []Op   `json:"ops"`
}

func EmptyGraph() Graph {
	return Graph{Schema: GraphSchema, Nodes: []Node{}, Links: []Link{}}
}

func (g Graph) node(id string) (Node, bool) {
	for _, n := range g.Nodes {
		if n.Id == id {
			return n, true
		}
	}
	return Node{}, false
}

func (g Graph) hasLink(a string, b string) bool {
	for _, l := range g.Links {
		if (l.A == a && l.B == b) || (l.A == b && l.B == a) {
			return true
		}
	}
	return false
}

// CleanText makes a model's text one line of plain words: control characters would reach a terminal or a log as keys.
func CleanText(text string) string {
	var b strings.Builder
	for _, r := range text {
		if r < 0x20 || r == 0x7f {
			b.WriteRune(' ')
			continue
		}
		b.WriteRune(r)
	}
	return strings.Join(strings.Fields(b.String()), " ")
}

func checkText(text string, what string) (string, error) {
	clean := CleanText(text)
	if clean == "" {
		return "", fmt.Errorf("%s: empty text", what)
	}
	if utf8.RuneCountInString(clean) > MaxText {
		return "", fmt.Errorf("%s: text over %d characters", what, MaxText)
	}
	return clean, nil
}

func checkId(id string, what string) error {
	if !idPattern.MatchString(id) {
		return fmt.Errorf("%s: invalid id", what)
	}
	return nil
}

// opLabel names an operation in an error: its place, and its name only when it is one this package knows. The model
// writes the name, and an error is logged.
func opLabel(i int, op string) string {
	switch op {
	case OpCentre, OpAdd, OpLink, OpEdit, OpPropose, OpConclude, OpFork, OpRemember:
		return fmt.Sprintf("operation %d (%s)", i+1, op)
	}
	return fmt.Sprintf("operation %d (unknown op)", i+1)
}

// ValidateBlock checks the block's shape alone (DS-BOSS-009). Its errors never quote the model's text: they are logged.
func ValidateBlock(b Block) error {
	if b.V != BlockVersion {
		return fmt.Errorf("version %d", b.V)
	}
	if b.Talk != TalkProject && b.Talk != TalkPersonal {
		return fmt.Errorf("unknown talk")
	}
	if len(b.Ops) > MaxOps {
		return fmt.Errorf("%d operations, over %d", len(b.Ops), MaxOps)
	}
	for i, op := range b.Ops {
		what := opLabel(i, op.Op)
		switch op.Op {
		case OpCentre:
			if err := checkId(op.Id, what); err != nil {
				return err
			}
			if _, err := checkText(op.Text, what); err != nil {
				return err
			}
		case OpAdd:
			if err := checkId(op.Id, what); err != nil {
				return err
			}
			if err := checkId(op.From, what+" from"); err != nil {
				return err
			}
			if !addKinds[op.Kind] {
				return fmt.Errorf("%s: unknown kind", what)
			}
			if _, err := checkText(op.Text, what); err != nil {
				return err
			}
		case OpLink:
			if err := checkId(op.A, what); err != nil {
				return err
			}
			if err := checkId(op.B, what); err != nil {
				return err
			}
			if op.A == op.B {
				return fmt.Errorf("%s: a node linked to itself", what)
			}
			if utf8.RuneCountInString(CleanText(op.Why)) > MaxText {
				return fmt.Errorf("%s: reason over %d characters", what, MaxText)
			}
		default:
			if !laterOps[op.Op] {
				return fmt.Errorf("%s: unknown operation", what)
			}
		}
	}
	return nil
}

// ValidateGraph checks a graph.json read back from the developer's folder against the rules a block obeys
// (DS-BOSS-009): the folder is theirs, another program or a hand may have changed it, and every view draws what it
// holds. A parent comes before its children, as Apply adds them. It returns the graph with its texts made plain; its
// errors never quote the file's text.
func ValidateGraph(g Graph) (Graph, error) {
	if g.Schema != GraphSchema {
		return Graph{}, fmt.Errorf("schema %d", g.Schema)
	}
	if len(g.Nodes) > MaxNodes {
		return Graph{}, fmt.Errorf("%d nodes, over %d", len(g.Nodes), MaxNodes)
	}
	if len(g.Links) > MaxLinks {
		return Graph{}, fmt.Errorf("%d links, over %d", len(g.Links), MaxLinks)
	}
	if g.Rev < 0 {
		return Graph{}, fmt.Errorf("a negative revision")
	}
	out := Graph{Schema: GraphSchema, Rev: g.Rev, Centre: g.Centre, Nodes: make([]Node, 0, len(g.Nodes)), Links: make([]Link, 0, len(g.Links))}
	seen := make(map[string]bool, len(g.Nodes))
	for i, n := range g.Nodes {
		what := fmt.Sprintf("node %d", i+1)
		if err := checkId(n.Id, what); err != nil {
			return Graph{}, err
		}
		if seen[n.Id] {
			return Graph{}, fmt.Errorf("%s: id already in the graph", what)
		}
		if !knownKinds[n.Kind] {
			return Graph{}, fmt.Errorf("%s: unknown kind", what)
		}
		if (n.Kind == KindTopic) != (n.Id == g.Centre) {
			return Graph{}, fmt.Errorf("%s: the topic is the centre's kind alone", what)
		}
		if n.Id == g.Centre && n.From != "" {
			return Graph{}, fmt.Errorf("%s: the centre has a parent", what)
		}
		if n.Id != g.Centre && !seen[n.From] {
			return Graph{}, fmt.Errorf("%s: unknown parent", what)
		}
		if !idPattern.MatchString(n.Status) {
			return Graph{}, fmt.Errorf("%s: invalid status", what)
		}
		text, err := checkText(n.Text, what)
		if err != nil {
			return Graph{}, err
		}
		n.Text = text
		seen[n.Id] = true
		out.Nodes = append(out.Nodes, n)
	}
	if (g.Centre != "" || len(g.Nodes) > 0) && !seen[g.Centre] {
		return Graph{}, fmt.Errorf("the centre is not a node")
	}
	for i, l := range g.Links {
		what := fmt.Sprintf("link %d", i+1)
		if !seen[l.A] || !seen[l.B] {
			return Graph{}, fmt.Errorf("%s: unknown node", what)
		}
		if l.A == l.B {
			return Graph{}, fmt.Errorf("%s: a node linked to itself", what)
		}
		l.Why = CleanText(l.Why)
		if utf8.RuneCountInString(l.Why) > MaxText {
			return Graph{}, fmt.Errorf("%s: reason over %d characters", what, MaxText)
		}
		out.Links = append(out.Links, l)
	}
	return out, nil
}

// CentreOf is the id the block's `centre` names, "" when it has none.
func CentreOf(b Block) string {
	for _, op := range b.Ops {
		if op.Op == OpCentre {
			return op.Id
		}
	}
	return ""
}

// StartsNewIdea: the block puts a central idea other than the graph's, so it begins a brainstorm of its own and the
// graph it would have grown stays as it was saved.
func StartsNewIdea(g Graph, b Block) bool {
	centre := CentreOf(b)
	return centre != "" && g.Centre != "" && centre != g.Centre
}

// Applied is what a block did: the graph after it, the nodes it added in their order, and the operations of later
// stories it skipped.
type Applied struct {
	Graph   Graph
	Added   []string
	Skipped int
}

// Apply grows g with the block, all or nothing: a block that names an unknown parent, adds an id twice, links an unknown
// node, grows past the limits or puts a second centre is dropped whole and g is left as it was. turn and at stamp
// what it adds.
func Apply(g Graph, b Block, turn int, at int64) (Applied, error) {
	if err := ValidateBlock(b); err != nil {
		return Applied{}, err
	}
	next := Graph{
		Schema: GraphSchema,
		Rev:    g.Rev,
		Centre: g.Centre,
		Nodes:  append([]Node{}, g.Nodes...),
		Links:  append([]Link{}, g.Links...),
	}
	rtn := Applied{}
	index := make(map[string]int, len(next.Nodes))
	for i, n := range next.Nodes {
		index[n.Id] = i
	}
	for i, op := range b.Ops {
		what := opLabel(i, op.Op)
		switch op.Op {
		case OpCentre:
			text, _ := checkText(op.Text, what)
			if next.Centre == "" {
				if _, taken := index[op.Id]; taken {
					return Applied{}, fmt.Errorf("%s: id already in the graph", what)
				}
				next.Centre = op.Id
				index[op.Id] = len(next.Nodes)
				next.Nodes = append(next.Nodes, Node{Id: op.Id, Kind: KindTopic, Text: text, Status: StatusOpen, Turn: turn, At: at})
				rtn.Added = append(rtn.Added, op.Id)
				continue
			}
			if op.Id != next.Centre {
				return Applied{}, fmt.Errorf("%s: a second centre", what)
			}
			next.Nodes[index[op.Id]].Text = text
		case OpAdd:
			text, _ := checkText(op.Text, what)
			if next.Centre == "" {
				return Applied{}, fmt.Errorf("%s: no centre yet", what)
			}
			if _, taken := index[op.Id]; taken {
				return Applied{}, fmt.Errorf("%s: id already in the graph", what)
			}
			parentAt, ok := index[op.From]
			if !ok {
				return Applied{}, fmt.Errorf("%s: unknown parent", what)
			}
			if len(next.Nodes) >= MaxNodes {
				return Applied{}, fmt.Errorf("%s: over %d nodes", what, MaxNodes)
			}
			node := Node{Id: op.Id, Kind: op.Kind, Text: text, From: op.From, Status: StatusOpen, Turn: turn, At: at}
			node.Pos = birthPos(next, next.Nodes[parentAt], op.Id)
			index[op.Id] = len(next.Nodes)
			next.Nodes = append(next.Nodes, node)
			rtn.Added = append(rtn.Added, op.Id)
		case OpLink:
			if _, ok := index[op.A]; !ok {
				return Applied{}, fmt.Errorf("%s: unknown node", what)
			}
			if _, ok := index[op.B]; !ok {
				return Applied{}, fmt.Errorf("%s: unknown node", what)
			}
			if next.hasLink(op.A, op.B) {
				continue
			}
			if len(next.Links) >= MaxLinks {
				return Applied{}, fmt.Errorf("%s: over %d links", what, MaxLinks)
			}
			next.Links = append(next.Links, Link{A: op.A, B: op.B, Why: CleanText(op.Why), Turn: turn})
		default:
			rtn.Skipped++
		}
	}
	next.Rev++
	rtn.Graph = next
	return rtn, nil
}
