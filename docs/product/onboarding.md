# Onboarding

```
curl -fsSL https://<domain>/install.sh | sh   # CLI + agent skill + Claude Code hook
brainiac login                                   # browser sign-in; BRAINIAC_TOKEN for CI
brainiac onboard                                 # mode, folder, privacy defaults, hold window
brainiac scan ~/CV.pdf ~/linkedin-export.zip     # read-only preview; nothing leaves the machine
brainiac import                                  # filed as proposals you review
brainiac mcp install                             # wires Claude Code, Claude desktop, Codex, Cursor
brainiac ask "what is my current role and since when?"
```

- **Claude Code plugin**: `/plugin install brainiac@brainiac`; its skill installs the CLI, signs in and wires MCP on first use.
- **Web only**: sign up (with a passkey), add `https://<domain>/mcp` as a connector in claude.ai, drop a CV or LinkedIn export, and say "file my inbox". Your Claude proposes the notes; you review them on the site.
- **Existing vault**: `brainiac import --vault ~/notes` maps OKF types and keeps your files untouched.

## What scan and import do

`brainiac scan` reads files on the laptop and prints what each becomes; nothing is sent, and `brainiac import`
alone sends what the last scan read (`apps/cli/src/imports.ts`, mapping in `packages/core/src/imports.ts`). Every
note arrives as a proposal for you to accept or reject (the site's list of proposals is #115), even from a
write-level connection.
What the record already has (the same type key, like a role's org, title and start, or the same title) is left
out, so importing twice changes nothing.

- **LinkedIn export** (the zip or its folder): each position is a Role and each school an Education. A month
  (`Jul 2025`) becomes its first day for a start and its last for an end; a year alone becomes no date. Either way the
  note's text says what LinkedIn wrote (`LinkedIn says Sep 2025 to now.`), and the values stay unverified until you
  check them. Skills, certifications, projects, publications, honors, languages, courses,
  volunteering and test scores go to your inbox as text for your Claude to file. Connections, messages and the
  rest are about other people or LinkedIn itself, and are never read.
- **OKF vault** (a folder): each note with a `type` goes as it is, at its own path and with its own id, except a
  `verified` mark, since only you verify a value in Brainiac. Notes in `facts/tests/`, `history/`, `health/` and
  `people/` arrive sensitive, which takes a connection you granted the sensitive scope; without it they are
  left out with that reason. Notes without a type, files that aren't notes, and anything in `identity/` or
  `finance/` stay on disk: upload those on the site. The record checks each note against its own types.
- **CV** (`.pdf`, `.txt` or `.md`): its text goes to your inbox, and your Claude files it ("file my inbox", or
  `brainiac filing now`). Brainiac runs no model, so it never guesses roles from prose.
- Text that prints an ID or account number (the upload checks in `packages/core/src/checks.ts`) is never sent:
  upload that file on the site, where it goes into the vault. The folder this laptop syncs is refused, since it is
  the record already.
