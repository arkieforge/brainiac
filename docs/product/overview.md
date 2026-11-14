# Overview

People sign up, and everything an application asks for lives in one place: **achievements, projects,
papers, grades, test scores, CVs, recommendation letters, IDs, profiles and links**, as **typed markdown
notes with sources**, along with **every other personal file**, each filed with the context that makes it
findable later. It syncs **live** to the site, the phone and any laptop that keeps a local copy.
People work on it with **the Claude they already pay for** (Claude Code, claude.ai, T3 Code) through MCP or
a thin CLI. No API key is needed, and the record works fully **with or without anything on disk**.
Secrets sit in a vault that agents can use only in approved ways and never see. Risky changes need your
approval, and values nobody has checked are labeled as unverified.

## Who it's for

Anyone who keeps retyping the same life into forms, or can't find the file that proves it. The first four jobs below are "applications" in Brainiac: a target with a checklist of requirements. Brainiac matches each requirement to existing facts and files before asking for anything new. The last is the record itself, kept organized whether or not an application needs it.

| Job                               | What Brainiac pulls together                                                               | What it watches                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| **University / school admission** | Transcripts, grades, test scores, SOP drafts from facts, activity lists, awards, letters   | Deadlines, missing letters, score validity                 |
| **Study abroad / visa**           | Passport, offer letter, proof of funds, IELTS/TOEFL, travel history                        | Passport and score expiry, documents each country requires |
| **Scholarships / PhD**            | Papers with author position, research projects, referees, an academic CV                   | Funding deadlines, referee follow-ups                      |
| **Job search**                    | Roles, projects with metrics and repos, skills, a resume per job, cover letters            | Pipeline status, an out-of-date LinkedIn, follow-ups       |
| **Personal files**                | Bills, receipts, leases, warranties, contracts, tax and medical papers, each with its note | Renewals, warranty and contract end dates, expiring IDs    |

## Name

**Brainiac**, built in the open at `arkieforge/brainiac`. The CLI is `brainiac` and the MCP tools are `mcp__brainiac__*`. The domain isn't chosen yet, so this plan writes `<domain>` (for example `mcp.<domain>`). Before launch, check trademark clashes and register the domain.

## What makes it different

### Typed facts with proof

Memory products store loose snippets. Brainiac stores typed notes whose front-matter is validated data, with sources tied to the exact fields they prove. "Is my CGPA 3.71 or 3.74?" has one answer and a page to show for it.

### Every file filed with context

Drop any file (a scan, a bill, a lease, a screenshot) and your Claude files it: a note says what it is, who issued it, when it matters and which notes it relates to, and the file gets a readable name in the right folder. "When does my laptop warranty end?" has one answer, with the file attached.

### Your Claude does the work

Filing, organizing, drafting and answering run in the Claude you already use, on your subscription. Brainiac supplies the record, the tools and the checks. Risky changes need an approval only you can give, tied to that exact change.

### Exact, and honest about it

Numbers and dates come straight from stored fields, every answer can be checked against the record, and values nobody has verified are labeled as unverified. Profiles out in the world (LinkedIn, GitHub, Scholar) are checked for drift.

## Two modes, every feature in each

The mode only decides whether a laptop keeps a working copy. Cloud is the full product, and a local copy is an option on top. Tool names, answers and rules are the same in both.

| Mode           | On disk                                                                                                                  | Filing                                                                                    | Search                                                   | For                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| **Cloud**      | Nothing                                                                                                                  | Your Claude through the connector ("file my inbox")                                       | In the person's DO                                       | No install: site, remote MCP, thin CLI, API, browser extension |
| **Local copy** | An Obsidian-compatible folder: normal notes and files, local-only notes, and sensitive notes only on a device you choose | The daemon starts a headless Claude Code run on your subscription, or you ask your Claude | Local SQLite: full search online, keyword search offline | Privacy-first, offline                                         |

`brainiac mode cloud|local` switches. Inbox items wait safely until an agent files them; the site shows "3 items waiting for your Claude". Background filing takes normal items only; sensitive and unclassified items wait for a session you're in.

### Feature parity, in one table

| Feature                        | Cloud (nothing on disk)                                                                                | Local copy                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capture (tell, files, links)   | Site drop zone, phone share, email-in, MCP `add`, thin CLI                                             | Same, plus the `inbox/` folder                                                                                                                                                |
| Filing                         | Your Claude via the connector                                                                          | Headless Claude Code on your subscription, or any agent via the tools                                                                                                         |
| Editing                        | Site editor (schema form + markdown source with live preview), live                                    | Any editor or Obsidian, live                                                                                                                                                  |
| query / search / related / ask | In the DO: FTS5 + vectors + graph                                                                      | Local SQLite with the same code for the notes the device holds; sensitive notes it doesn't hold are forwarded to the DO when online; keyword-only offline, and answers say so |
| File text                      | Extracted at ingest (Workers AI `toMarkdown`); pages it can't read are handed to your Claude as images | Synced files use the cloud extraction; local-only files use bundled pdf.js text, and your Claude reads the rest                                                               |
| Agents                         | Remote MCP `mcp.<domain>` (OAuth)                                                                      | `brainiac mcp serve` (stdio)                                                                                                                                                  |
| Review, questions, approvals   | Site and phone                                                                                         | Same; `brainiac review` lists them and opens the passkey page to decide                                                                                                       |
| Applications, CVs, packets     | Built in the cloud, PDFs via Typst                                                                     | Same, or locally                                                                                                                                                              |
| Secrets                        | Cloud vault, used only by the extension's form fill                                                    | Same vault; never written to disk                                                                                                                                             |
| Offline                        | No (the one gap)                                                                                       | Yes                                                                                                                                                                           |
