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
	// KindReference is MoltenTerm's own (#2248): the node that names the other folder of a fork. No block adds one.
	KindReference = "reference"
)

// The operations of a block. centre, add and link grow the graph. fork, resume and forget (#2248) never change it: the
// window turns each into a question to the developer, and MoltenTerm acts only on the answer. The others belong to the
// stories that follow (#2247, #2249, #2250) and are skipped until then, so that a block written for a newer brief is not
// dropped whole.
const (
	OpCentre   = "centre"
	OpAdd      = "add"
	OpLink     = "link"
	OpEdit     = "edit"
	OpPropose  = "propose"
	OpConclude = "conclude"
	OpFork     = "fork"
	OpResume   = "resume"
	OpForget   = "forget"
	OpRemember = "remember"
	// OpFinish (#2285): the developer says the brainstorm is done. It never changes the graph: the open brainstorm is
	// saved as finished.
	OpFinish = "finish"
	// The graph is living (#2247): Brokk corrects what the talk made obsolete, and the developer edits it by hand.
	OpRemove = "remove"
	OpUnlink = "unlink"
	OpRetype = "retype"
	OpMerge  = "merge"
)

const (
	TalkProject  = "project"
	TalkPersonal = "personal"
)

const StatusOpen = "open"

var idPattern = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)

// refPattern: the id of another brainstorm a reference node names (Info.Id).
var refPattern = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)

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
	KindReference:  true,
}

var laterOps = map[string]bool{
	OpPropose:  true,
	OpConclude: true,
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
	// Ref: the id of the brainstorm a reference node names (#2248).
	Ref string `json:"ref,omitempty"`
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
	// fork, resume and forget (#2248): the brainstorm's title, and why the talk is another project.
	Title  string `json:"title,omitempty"`
	Reason string `json:"reason,omitempty"`
	// merge (#2247): the nodes folded into Into.
	Ids  []string `json:"ids,omitempty"`
	Into string   `json:"into,omitempty"`
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
	case OpCentre, OpAdd, OpLink, OpEdit, OpPropose, OpConclude, OpFork, OpResume, OpForget, OpRemember, OpFinish:
		return fmt.Sprintf("operation %d (%s)", i+1, op)
	case OpRemove, OpUnlink, OpRetype, OpMerge:
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
		case OpFork, OpResume, OpForget:
			if _, err := checkText(op.Title, what); err != nil {
				return err
			}
			if utf8.RuneCountInString(CleanText(op.Reason)) > MaxText {
				return fmt.Errorf("%s: reason over %d characters", what, MaxText)
			}
		case OpFinish:
		case OpEdit, OpRemove, OpUnlink, OpRetype, OpMerge:
			if err := checkLivingOp(op, what); err != nil {
				return err
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
		if n.Ref != "" && !refPattern.MatchString(n.Ref) {
			return Graph{}, fmt.Errorf("%s: invalid reference", what)
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

// Finishes: the block holds a `finish` (#2285).
func Finishes(b Block) bool {
	for _, op := range b.Ops {
		if op.Op == OpFinish {
			return true
		}
	}
	return false
}

// StartsNewIdea: the block puts a central idea other than the graph's, so it begins a brainstorm of its own and the
// graph it would have grown stays as it was saved.
func StartsNewIdea(g Graph, b Block) bool {
	centre := CentreOf(b)
	return centre != "" && g.Centre != "" && centre != g.Centre
}

// Applied is what a block did: the graph after it, the nodes it added in their order, and the operations of later
// stories it skipped. Changes are the operations that changed the graph, each with what puts it back (#2247): the
// history keeps them.
type Applied struct {
	Graph   Graph
	Added   []string
	Skipped int
	Changes []Change
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
				rtn.Changes = append(rtn.Changes, Change{Op: cleanOp(op), Undo: Patch{Added: []string{op.Id}}})
				continue
			}
			if op.Id != next.Centre {
				return Applied{}, fmt.Errorf("%s: a second centre", what)
			}
			if next.Nodes[index[op.Id]].Text != text {
				was := PatchNode{Index: index[op.Id], Node: next.Nodes[index[op.Id]]}
				rtn.Changes = append(rtn.Changes, Change{Op: cleanOp(op), Undo: Patch{Nodes: []PatchNode{was}}})
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
			rtn.Changes = append(rtn.Changes, Change{Op: cleanOp(op), Undo: Patch{Added: []string{op.Id}}})
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
			added := Link{A: op.A, B: op.B, Why: CleanText(op.Why), Turn: turn}
			next.Links = append(next.Links, added)
			rtn.Changes = append(rtn.Changes, Change{Op: cleanOp(op), Undo: Patch{LinksAdded: []Link{added}}})
		case OpEdit, OpRemove, OpUnlink, OpRetype, OpMerge:
			change, changed, err := applyLiving(&next, op, what)
			if err != nil {
				return Applied{}, err
			}
			if changed {
				rtn.Changes = append(rtn.Changes, change)
				index = indexOf(next)
			}
		default:
			rtn.Skipped++
		}
	}
	next.Rev++
	rtn.Graph = next
	return rtn, nil
}

// IdOf makes a node id out of a title, the way a slug is made, cut to the id's 32 characters.
func IdOf(title string) string {
	id := Slug(title)
	if len(id) > 32 {
		id = strings.TrimRight(id[:32], "-")
	}
	if id == "" {
		return fallbackSlug
	}
	return id
}

// freeId is base, or base with a number, that no node of g has; the number keeps it within the id's 32 characters.
func freeId(g Graph, base string) string {
	if _, taken := g.node(base); !taken {
		return base
	}
	for n := 2; ; n++ {
		suffix := fmt.Sprintf("-%d", n)
		stem := base
		if len(stem)+len(suffix) > 32 {
			stem = strings.TrimRight(stem[:32-len(suffix)], "-")
		}
		if _, taken := g.node(stem + suffix); !taken {
			return stem + suffix
		}
	}
}

// CentredGraph is a new graph with title at its centre (a fork's folder, #2248).
func CentredGraph(title string, at int64) (Graph, error) {
	text, err := checkText(cutText(CleanText(title), MaxText), "centre")
	if err != nil {
		return Graph{}, err
	}
	id := IdOf(text)
	return Graph{
		Schema: GraphSchema,
		Rev:    1,
		Centre: id,
		Nodes:  []Node{{Id: id, Kind: KindTopic, Text: text, Status: StatusOpen, At: at}},
		Links:  []Link{},
	}, nil
}

// WithReference adds to g, under its centre, the node that names another brainstorm (a fork's two folders, #2248). A
// graph without a centre or already full stays as it is: the folders' siblings keep the link.
func WithReference(g Graph, title string, ref string, at int64) Graph {
	centre, ok := g.node(g.Centre)
	text := cutText(CleanText(title), MaxText)
	if !ok || text == "" || !refPattern.MatchString(ref) || len(g.Nodes) >= MaxNodes {
		return g
	}
	for _, n := range g.Nodes {
		if n.Kind == KindReference && n.Ref == ref {
			return g
		}
	}
	next := Graph{Schema: GraphSchema, Rev: g.Rev + 1, Centre: g.Centre, Nodes: append([]Node{}, g.Nodes...), Links: append([]Link{}, g.Links...)}
	id := freeId(next, IdOf("ref-"+text))
	node := Node{Id: id, Kind: KindReference, Text: text, From: centre.Id, Status: StatusOpen, At: at, Ref: ref}
	node.Pos = birthPos(next, centre, id)
	next.Nodes = append(next.Nodes, node)
	return next
}
