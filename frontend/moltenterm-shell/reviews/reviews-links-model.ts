// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Where the ticket and PR numbers of the Integration panel lead (#1921, FR-REV-001 AC19). The owner and the repository
// are never written here: they come from the pull request's own address, which gh gave for the project.

// issueUrlOfPr: the repository's issue page for a ticket, built from a pull request's address; "" when the address is
// not a pull request's, since a guess would open a wrong page.
export function issueUrlOfPr(prUrl: string, ticket: number): string {
    if (!prUrl || !(ticket > 0)) {
        return "";
    }
    const repoUrl = prUrl.replace(/\/pull\/\d+\/?$/, "");
    return repoUrl === prUrl ? "" : `${repoUrl}/issues/${ticket}`;
}

// ticketLinkUrl: the ticket's own address when the workflow tool gave one (it may not be GitHub's), else its issue page
// on the PR's repository; "" when there is no ticket or nothing to build it from.
export function ticketLinkUrl(ticket: number, ticketUrl: string, prUrl: string): string {
    if (!(ticket > 0)) {
        return "";
    }
    return ticketUrl || issueUrlOfPr(prUrl, ticket);
}
