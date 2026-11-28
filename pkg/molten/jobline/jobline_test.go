// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package jobline

import (
	"reflect"
	"testing"
)

// #2583: a service is told by its command line, from one explicit list. Everything else is bounded work.
func TestIsService(t *testing.T) {
	t.Parallel()
	services := []string{
		// MoltenTerm's own stdio servers.
		"molten mcp browser",
		"molten mcp review",
		"/opt/app/bin/molten mcp browser",
		"nohup molten mcp browser > /tmp/mcp.log 2>&1 &",
		// A program whose first argument is a daemon or a server, the Molten browser daemon among them.
		"node ~/x/molten-browser.mjs daemon",
		"node /Users/dev/skills/molten-browser/scripts/molten-browser.mjs daemon --port 9333",
		"node --no-warnings cli.mjs --port 9333 daemon",
		"nohup node cli.mjs daemon &",
		"./molten-browser.mjs daemon",
		"molten-browser daemon",
		"php artisan serve",
		"php artisan serve --port=8001",
		"hugo server -D",
		"mkdocs serve",
		"python3 -m http.server 8000",
		"python3 app.py serve",
		// The Taskfile's long-running tasks.
		"task dev",
		"task start",
		"task -v electron:dev",
		"task preview",
		// A package manager's long-running scripts.
		"cd app && npm run dev",
		"npm run dev -- --port 3000",
		"npm --silent run start",
		"npm start",
		"npm run-script serve",
		"pnpm dev",
		"pnpm run preview",
		"yarn start",
		"yarn dev",
		"bun run watch",
		"bun dev",
		"npm run dev:renderer",
		"npm run build:watch",
		`bash -c "npm run dev"`,
		"FOO=1 nohup npm start",
		"caffeinate -i npm run dev",
		"timeout 600 npm run dev",
		// vite, next, and the programs started through a runner.
		"npx vite",
		"npx vite --port 4000",
		"vite",
		"vite dev",
		"vite preview",
		"pnpm exec vite",
		"yarn vite",
		"bunx vite serve",
		"next dev",
		"npx next start",
		// A file followed for good.
		"tail -f build.log",
		"tail -F /var/log/app.log",
		"tail -fn 50 app.log",
		"tail --follow=name app.log",
		"tail -n 20 -f app.log | grep ERROR",
	}
	for _, line := range services {
		if !IsService(line) {
			t.Errorf("%q is a service", line)
		}
	}

	bounded := []string{
		"",
		"vite build",
		"npx vite build",
		"yarn vite build",
		"gh pr checks 12 --watch",
		"molten ci run",
		"molten ci status --job frontend",
		"sleep 600",
		"go test ./...",
		"go build ./...",
		"npm test",
		"npm run test:pre-push",
		"npm run build",
		"npm install",
		"npm install server",
		"pnpm add serve",
		"npx vitest run",
		"task build:frontend",
		"task check:ts",
		"task dev:cleardata",
		"node scripts/moltenterm-affected.mjs --run",
		"node build.mjs",
		"python3 -m pytest",
		"next build",
		"tail -n 100 build.log",
		"tail build.log",
		"until gh pr checks 2140 --required; do sleep 30; done",
		"git push origin HEAD",
		// A folder or a text named like a server is not a server.
		"cd server && npm test",
		"ls daemon",
		"cat server",
		"grep daemon /var/log/app.log",
		`echo "serve"`,
		"vitest server",
		"rm -rf daemon",
	}
	for _, line := range bounded {
		if IsService(line) {
			t.Errorf("%q is bounded work", line)
		}
	}
}

func TestIsServiceReadsEverySegmentOfALine(t *testing.T) {
	t.Parallel()
	if !IsService("npm install && npm run dev") {
		t.Errorf("a service after other commands is a service")
	}
	if !IsService(`(cd app; npm start) &`) {
		t.Errorf("a service in a group is a service")
	}
	if IsService("npm run build && npm test && molten ci run") {
		t.Errorf("a line of bounded commands is bounded")
	}
}

func TestIsServiceStopsOnNestedRunners(t *testing.T) {
	t.Parallel()
	if IsService("npx npx npx npx npx npx npx npx npx vite") {
		t.Errorf("runners are looked through to a bounded depth")
	}
}

func TestSegments(t *testing.T) {
	t.Parallel()
	got := Segments(`FOO=1 nohup timeout 600 go test ./... & echo done`)
	var words [][]string
	for _, seg := range got {
		words = append(words, seg.Words)
	}
	want := [][]string{{"go", "test", "./..."}, {"echo", "done"}}
	if !reflect.DeepEqual(words, want) {
		t.Fatalf("%v, want %v", words, want)
	}
	if got[0].Text != "FOO=1 nohup timeout 600 go test ./... " {
		t.Errorf("the segment as written: %q", got[0].Text)
	}
	if segs := Segments("  ; nohup ;"); len(segs) != 0 {
		t.Errorf("a segment with no program is left out: %v", segs)
	}
}

func TestIsEnvAssignment(t *testing.T) {
	t.Parallel()
	for word, want := range map[string]bool{"FOO=bar": true, "_a1=": true, "a=b=c": true, "=bar": false, "1A=b": false, "FOO": false, "a-b=c": false, "": false} {
		if got := isEnvAssignment(word); got != want {
			t.Errorf("%q: %v, want %v", word, got, want)
		}
	}
}
