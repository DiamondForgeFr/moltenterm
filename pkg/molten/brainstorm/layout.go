// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import (
	"hash/fnv"
	"math"
)

// Where a node is born (DS-BOSS-009, "Layout"): MoltenTerm's own placement, pure and seeded by the ids, so that the same
// graph always stands the same way and a reloaded folder looks as it did. The graph is a relief more than a ball: its
// plates are read face on, so the branches spread in the plane the camera faces (x to the right, y up) and take only a
// little depth (z), for the parallax and the light. The centre stands at the origin; its branches go round it at the
// golden angle, wider than tall like the window; a deeper node leaves its parent away from where the parent came from,
// its siblings fanning out on alternate sides of that line. A node born too close to another is pushed aside, more
// across than up and down, because a plate is wider than tall. The view eases between these places; it never decides
// them.

const (
	// The world's units are about the pixels of a close view.
	firstRing  = 300.0
	branchStep = 240.0
	// Wider than tall: the free space beside Brokk's group is a landscape.
	heightSquash = 0.75
	// The share of a step a node may take in depth.
	depthShare  = 0.4
	goldenAngle = 2.399963229728653
	fanStep     = 0.55
	maxFan      = 1.25
	// The gap a plate needs around it: wide across, narrow up and down, loose in depth.
	gapX       = 230.0
	gapY       = 95.0
	gapZ       = 420.0
	pushRounds = 16
)

type vec3 [3]float64

func (a vec3) add(b vec3) vec3      { return vec3{a[0] + b[0], a[1] + b[1], a[2] + b[2]} }
func (a vec3) sub(b vec3) vec3      { return vec3{a[0] - b[0], a[1] - b[1], a[2] - b[2]} }
func (a vec3) scale(s float64) vec3 { return vec3{a[0] * s, a[1] * s, a[2] * s} }

// seed is a stable number in [0, 1) for a string.
func seed(s string) float64 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(s))
	return float64(h.Sum32()%100000) / 100000
}

func round1(x float64) float64 {
	return math.Round(x*10) / 10
}

func childrenOf(g Graph, id string) int {
	count := 0
	for _, n := range g.Nodes {
		if n.From == id {
			count++
		}
	}
	return count
}

// fan is the angle of the k-th child from its parent's line: the first goes on almost straight, the next ones on
// alternate sides, each a little further.
func fan(k int) float64 {
	if k == 0 {
		return 0.12
	}
	a := fanStep * float64((k+1)/2)
	if a > maxFan {
		a = maxFan
	}
	if k%2 == 0 {
		return -a
	}
	return a
}

// birthPos is where a new child of parent stands, given the graph it joins.
func birthPos(g Graph, parent Node, id string) [3]float64 {
	k := childrenOf(g, parent.Id)
	origin := vec3(parent.Pos)
	depth := (seed(id) - 0.5) * 2 * depthShare
	var pos vec3
	if parent.From == "" {
		// Around the centre: the golden angle spreads the branches evenly whatever their number.
		theta := goldenAngle*float64(k) + seed(parent.Id)*2*math.Pi
		pos = origin.add(vec3{math.Cos(theta), math.Sin(theta) * heightSquash, depth}.scale(firstRing))
	} else {
		grand := vec3{}
		if gp, ok := g.node(parent.From); ok {
			grand = vec3(gp.Pos)
		}
		bx, by := origin[0]-grand[0], origin[1]-grand[1]
		length := math.Hypot(bx, by)
		if length < 1e-6 {
			bx, by, length = 1, 0, 1
		}
		bx, by = bx/length, by/length
		a := fan(k)
		dx := bx*math.Cos(a) - by*math.Sin(a)
		dy := bx*math.Sin(a) + by*math.Cos(a)
		pos = origin.add(vec3{dx, dy * heightSquash, depth}.scale(branchStep))
	}
	pos = pushAside(g, pos)
	return [3]float64{round1(pos[0]), round1(pos[1]), round1(pos[2])}
}

// gapOf measures how far apart two places are in plates: below 1 they would overlap.
func gapOf(d vec3) float64 {
	return math.Sqrt((d[0]/gapX)*(d[0]/gapX) + (d[1]/gapY)*(d[1]/gapY) + (d[2]/gapZ)*(d[2]/gapZ))
}

// pushAside moves a new node out of the others' way: a few rounds, each away from the nodes that are too close, until
// it stands a plate's gap from all of them.
func pushAside(g Graph, pos vec3) vec3 {
	for round := 0; round < pushRounds; round++ {
		moved := false
		for _, n := range g.Nodes {
			other := vec3(n.Pos)
			d := pos.sub(other)
			e := gapOf(d)
			if e >= 1 {
				continue
			}
			if e < 1e-6 {
				d = vec3{math.Cos(float64(round) * goldenAngle), math.Sin(float64(round)*goldenAngle) * 0.4, 0}.scale(gapX)
				e = gapOf(d)
			}
			pos = other.add(d.scale(1.02 / e))
			moved = true
		}
		if !moved {
			break
		}
	}
	return pos
}
