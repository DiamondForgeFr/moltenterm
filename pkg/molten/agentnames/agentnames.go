// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Package agentnames gives every agent session running in a pane a first name, unique among the active agents of the
// whole app (FR-CONT-014, DS-CONT-028), so the developer can tell three Claude Code sessions of one tab apart. An owner
// is whatever holds the name (wavesrv uses the pane's block id); the agent creator (#552) can later give chosen names
// to its own owners through the same allocator.
package agentnames

import (
	"fmt"
	"math/rand/v2"
	"strings"
	"sync"
)

// Names mixes female and male first names. None of them is an agent's own name (Claude, Gemini...): "Claude" in a
// header must keep meaning Claude Code.
var Names = []string{
	"Adèle", "Agathe", "Alice", "Amélie", "Anaïs", "Anna", "Aurore", "Bérénice", "Camille", "Capucine",
	"Céleste", "Chloé", "Clara", "Clémence", "Constance", "Diane", "Éloïse", "Elsa", "Emma", "Estelle",
	"Fanny", "Flore", "Gabrielle", "Hélène", "Inès", "Irène", "Jeanne", "Joséphine", "Judith", "Juliette",
	"Léa", "Léonie", "Lina", "Louise", "Lucie", "Margaux", "Marion", "Mathilde", "Nina", "Noémie",
	"Olivia", "Pauline", "Rose", "Salomé", "Sarah", "Sophie", "Suzanne", "Valentine", "Victoire", "Zoé",
	"Adrien", "Alexis", "Antoine", "Arthur", "Augustin", "Baptiste", "Basile", "Benoît", "Bruno", "Clément",
	"Damien", "Édouard", "Émile", "Étienne", "Félix", "Gaspard", "Hugo", "Jérôme", "Jules", "Julien",
	"Léon", "Louis", "Lucas", "Marc", "Martin", "Mathis", "Maxime", "Nathan", "Noé", "Olivier",
	"Oscar", "Paul", "Pierre", "Raphaël", "Rémi", "Romain", "Samuel", "Simon", "Théo", "Thomas",
	"Tristan", "Valentin", "Victor", "Vincent", "Yann",
}

type Allocator struct {
	lock  sync.Mutex
	names []string
	// active: the owner of each name in use, by its key (nameKey).
	active map[string]string
	// held: the name each owner holds now.
	held map[string]string
	// remembered: the last name each owner held, offered to it again while it is free (a session resumed in the same
	// pane keeps its name).
	remembered map[string]string
	// intn draws in [0, n); replaced in tests.
	intn func(n int) int
}

func MakeAllocator(names []string) *Allocator {
	return &Allocator{
		names:      names,
		active:     map[string]string{},
		held:       map[string]string{},
		remembered: map[string]string{},
		intn:       rand.IntN,
	}
}

func nameKey(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}

// Take gives the owner a name: the one it holds, else the one it last held when no one else holds it, else a free name
// drawn at random, else (every name in use) a name with the lowest free numbered suffix ("Alice 2"). fresh: the name
// is not the one the owner last held (the caller may want to remember it elsewhere).
func (a *Allocator) Take(owner string) (name string, fresh bool) {
	a.lock.Lock()
	defer a.lock.Unlock()
	if cur, ok := a.held[owner]; ok {
		return cur, false
	}
	last := a.remembered[owner]
	if last != "" && a.active[nameKey(last)] == "" {
		a.holdLocked(owner, last)
		return last, false
	}
	name = a.drawLocked()
	a.holdLocked(owner, name)
	return name, true
}

func (a *Allocator) holdLocked(owner string, name string) {
	a.active[nameKey(name)] = owner
	a.held[owner] = name
	a.remembered[owner] = name
}

func (a *Allocator) drawLocked() string {
	free := make([]string, 0, len(a.names))
	for _, n := range a.names {
		if a.active[nameKey(n)] == "" {
			free = append(free, n)
		}
	}
	if len(free) > 0 {
		return free[a.intn(len(free))]
	}
	if len(a.names) == 0 {
		return a.suffixedLocked("Agent")
	}
	return a.suffixedLocked(a.names[a.intn(len(a.names))])
}

func (a *Allocator) suffixedLocked(base string) string {
	for i := 2; ; i++ {
		name := fmt.Sprintf("%s %d", base, i)
		if a.active[nameKey(name)] == "" {
			return name
		}
	}
}

// Release frees the owner's name (its session ended); the owner still gets it back first while it stays free.
func (a *Allocator) Release(owner string) {
	a.lock.Lock()
	defer a.lock.Unlock()
	name, ok := a.held[owner]
	if !ok {
		return
	}
	delete(a.held, owner)
	if a.active[nameKey(name)] == owner {
		delete(a.active, nameKey(name))
	}
}

// Forget frees the owner's name and drops its memory (its pane closed).
func (a *Allocator) Forget(owner string) {
	a.Release(owner)
	a.lock.Lock()
	defer a.lock.Unlock()
	delete(a.remembered, owner)
}

// Prefer remembers a name the owner held before (read back after a restart), unless it already holds one.
func (a *Allocator) Prefer(owner string, name string) {
	name = strings.TrimSpace(name)
	if owner == "" || name == "" {
		return
	}
	a.lock.Lock()
	defer a.lock.Unlock()
	if _, ok := a.held[owner]; ok {
		return
	}
	a.remembered[owner] = name
}

// Owner tells who holds a name now (case-insensitive).
func (a *Allocator) Owner(name string) (string, bool) {
	a.lock.Lock()
	defer a.lock.Unlock()
	owner, ok := a.active[nameKey(name)]
	return owner, ok
}

// Held is the owner's name now, "" when it holds none.
func (a *Allocator) Held(owner string) string {
	a.lock.Lock()
	defer a.lock.Unlock()
	return a.held[owner]
}
