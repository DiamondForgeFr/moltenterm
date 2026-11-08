# Electron engine updates

MoltenTerm ships Chromium through Electron: a Chromium security fix reaches users only with an Electron patch and a
MoltenTerm release. This is the policy (browser audit #1961, finding M7; ticket #1983; FR-BRW-014), the checks that
keep it, and the steps of a bump.

## Policy

1. **Supported line.** Stay on a major that upstream supports (the latest three stable majors, checked against the
   release feed) and move to the next one at least four weeks before the end of support of the one we leave.
   `security/dependencies.json` `electronLifecycle` records the human review of the schedule and the tentative end of
   support (2027-04-27 for 45, so the check raises the move to the next major on 2027-03-28; 46 is scheduled stable on
   2027-01-05). Source: <https://releases.electronjs.org/schedule>.
2. **Watch.** Electron releases (<https://releases.electronjs.org/releases.json>, with the Chromium version of each),
   Electron's GitHub security advisories (<https://github.com/electron/electron/security/advisories>) and the Chrome
   Releases blog for a Chromium fix rated critical or exploited in the wild. The first two are read by the daily check
   below; the blog is read by a person (see "Limits").
3. **Patch deadlines**, counted from the Electron release that carries the fix, to a MoltenTerm release users can take:

   | Fix                                      | Deadline                             |
   | ---------------------------------------- | ------------------------------------ |
   | Exploited in the wild, or rated critical | 3 days                               |
   | High                                     | 7 days                               |
   | Any other security fix                   | The next release, and within 30 days |

   A newer release of the pinned major is a finding once it has waited more than 7 days: the high deadline, because the
   release notes only say "backported fixes from upstream Chromium" and never rate them.

4. **Every bump is requalified on a packaged build** with `node scripts/moltenterm-qualify-packaged.mjs <packaged app>`
   (#1975; the app is a `.app` or the executable). It starts the app the way a user does, in a test instance of its own,
   and checks the fuses, that `--inspect`, `NODE_OPTIONS` and `ELECTRON_RUN_AS_NODE` reach nothing, and that a changed
   `app.asar` is refused. The pull request of the bump says which platforms ran it and the result. A new Electron can
   reset a fuse or a default: the release also reads the fuses back from every packaged app
   (`scripts/moltenterm-check-fuses.mjs`).

## What checks it

| Check                                                                                        | When                                | Does what                                                                                                                           |
| -------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `electronLifecycle` in the scanner (`scripts/security/policy.mjs`)                           | Every scan, offline                 | Fails when the recorded review is overdue (at most 90 days old) or does not match the pin in `package.json` and the lock            |
| `scripts/security/electron-staleness.mjs`, run by `.github/workflows/electron-staleness.yml` | Daily, and by hand                  | Opens or updates one issue "Electron engine update overdue" labelled `security`, and closes it once nothing is left. It never bumps |
| The same script with `--enforce`, run by `security-scan.yml`                                 | Release tags and release rehearsals | Fails the dependency security job, which the release builds and the publication wait for                                            |

The script reads the pin (`package.json`, the lock and `electronLifecycle` must agree), the release feed and the
advisories, and raises:

- **newer-release**: a newer release of the same major has been out for more than 7 days (`--max-age-days`, 1 to 30).
  Inside the window it is listed as pending, with the day it becomes a finding.
- **advisory**: a published, not withdrawn Electron advisory whose vulnerable range holds the pin. The finding names the
  severity and its deadline from the policy (3, 7 or 30 days from the release that fixes it). An advisory that lists
  fixed versions no longer holds a version at or above the highest of them (GitHub sometimes keeps an open-ended range
  for a branch it did not patch); one with no fixed version at all stays open.
- **end-of-support**: the reviewed end of support of the major is within 30 days, or past.
- **unsupported-line**: the major is not among the latest three stable ones.

A read that fails (feed, advisories, a file, a malformed range or exception) exits 2 and is never reported as current.
A pull request is never stopped by a new upstream patch: only the release is.

### Critical or exploited fixes

The daily check cannot rate a Chromium fix. When the Chrome Releases blog or an Electron announcement names one, start
**Electron engine staleness** by hand with `max-age-days` 3 (a newer Electron release then becomes a finding after 3
days instead of 7) and bump the same day.

### Exceptions

When a bump cannot ship in time, or an advisory has no fix yet, `security/dependencies.json` may hold a reviewed
exception in `electronExceptions`. The rules are the scanner's (`security/README.md`): a human reviewer, a GitHub
approval link, a control, exact scopes with no wildcard, exact UTC timestamps and at most 90 days. It covers one
finding of one pin; the next release, advisory or pin needs its own.

```json
{
  "code": "newer-release",
  "id": "45.2.4",
  "version": "45.2.3",
  "reason": "45.2.4 only changes the Linux Wayland path; requalification runs on the 14th",
  "owner": "AGachet",
  "control": "No Linux build ships before the bump",
  "reviewedBy": "AGachet",
  "approval": "https://github.com/DiamondForgeFr/moltenterm/issues/0000#issuecomment-0000",
  "createdAt": "2026-11-10T09:00:00Z",
  "expiresAt": "2026-11-17T09:00:00Z"
}
```

`code` is one of `newer-release` (`id` is the newest release), `advisory` (`id` is the GHSA), `end-of-support` and
`unsupported-line` (`id` is the major). An expired exception covers nothing, and the finding shows that it expired.

## Bump procedure

1. Read the release notes of every release between the pin and the target
   (<https://github.com/electron/electron/releases>): API changes, Chromium and Node versions, fixes.
2. Pin the exact version in `package.json` and the lock with npm 10.9.2 (`node scripts/moltenterm-check-lockfile.mjs`
   must stay green), and renew `electronLifecycle` in `security/dependencies.json`: version, `reviewedAt` today,
   `reviewBy` at most 90 days later, and the tentative end of support from the schedule.
3. Run `node scripts/security/electron-staleness.mjs` (no flag): it must report the pin current.
4. Requalify (policy 4) and say what ran in the pull request.
5. Cut the release within the deadline of policy 3.

## Limits

- A release younger than 7 days is not a finding, so a critical Chromium fix inside that window depends on the person
  watching the Chrome Releases blog (the by-hand run above).
- The feed and the advisories are upstream's: a fix that Electron has not shipped, or an advisory not yet published,
  cannot be seen.
- The end of support is a human review of the schedule, not a feed: `electronLifecycle` must be renewed at least every
  90 days, which the scanner enforces.
