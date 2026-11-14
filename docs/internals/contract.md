# The contract

One set of rules for authority, models, permissions, approvals, privacy and retention. When any other section seems to say something different, this section wins.

## 1. Who holds the truth

- The person's Base Durable Object (DO) is the authority for every synced note. A laptop folder is a working copy: editable offline and synced through the protocol in "Sync engine".
- **Local-only notes** (an explicit opt-in per note or folder): the disk is the authority. They never reach the cloud; the site shows only a count. There is no hold window and no approval list on disk: anything with your shell can change a local-only note.
- **The stored form is the raw markdown text.** Front-matter is parsed from it for queries. An edit changes only the YAML node or the markdown block it touches: every byte outside it stays as it was. A property test checks exactly that.

## 2. Models: your subscription, not ours

- Every model task (filing the inbox, reading a hard scan, answering, drafting, organizing) runs in **the person's own agent on their own subscription**: Claude Code, claude.ai (web, desktop, phone) with the Brainiac connector, T3 Code, Codex, or any MCP client.
- Brainiac itself runs no Claude and needs no API key. It runs only cheap, deterministic infrastructure: document-to-text (Workers AI `toMarkdown`), embeddings, search, checks.
- Later, for people who add their own API key: an Ask box and a hosted filer on the site itself.
- Brainiac never stores or proxies anyone's subscription login.

## 3. Who may change what

| Actor                                                                                              | How it writes                                              | Level                                                         |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| **You on the site or phone**                                                                       | Direct edits                                               | Everything; the approval list below needs a passkey signature |
| **The `brainiac` CLI and MCP clients** (yours or an agent's: one credential can't tell them apart) | Through Brainiac's tools                                   | **read**, **propose** or **write**, per connection            |
| **Unattributed file edits** (anything writing the vault folder directly)                           | Synced like a write-level edit                             | write, minus the approval list                                |
| **Connectors**                                                                                     | Proposals; they may refresh only their own `synced:` block | propose                                                       |

- **Attribution is honest, not total**: changes made through Brainiac's tools are attributed and can be held. Brainiac's Claude Code hook is advisory: it blocks Edit, Write and shell commands that touch the vault path, plus Read, Grep and Glob on sensitive folders, `documents/files/` and `inbox/`, and points to the tools, but an agent with an unrestricted shell or another client can still write files. Those writes are unattributed: they sync without the hold window, and the approval list still binds them. People who let agents loose on the folder should use cloud mode or local-only notes, and the plan says so rather than promising more.
- **Hold window**: a write-level change through the tools that changes an _existing value_ on a note whose **type** is a held type (the fact types: Education, TestScore, Role, Paper, Project, Award, Trip, IdDocument and the rest of the held areas in the manifest) becomes a held proposal with `auto_apply_at` (default 3 days, per connection). It's keyed on type, so moving a note can't escape it, and moving a note out of a held area is held too. Creating a new note is never held, since new notes start unverified, except a note that `supersedes` a held-type note, which is held like an edit to it. Held proposals live in the DO, are not applied to any file until released, and are released early when you approve or verify them.
- **Only you decide proposals and conflicts.** An agent can withdraw its own proposals, nothing more.

## 4. What always needs your approval

Everyone enrolls a passkey at sign-up (sign-in is Better Auth, self-hosted, with a second passkey requested at sign-up). Approving is a WebAuthn passkey assertion whose challenge is the plan hash (the list of note, base revision and patch it covers), checked in the DO with SimpleWebAuthn. The signature itself ties you to that exact change. A review session signs one session nonce instead, valid for 10 minutes and renewed only by a new signature. It covers just verify, fix and undo on the items shown in that session; scope grants, privacy loosening, secret use and bulk deletes always need their own plan-hash signature. An agent, a token, a settings note or a confirm box inside a chat client can never create an approval; they only show the approval link.

- Any change whose _effect_ alters, clears or deletes a value you verified, or sets verification, however it arrives: an update, a delete, an `undo`, a move or type change, a replacement or a schema change. The DO checks the transaction's result against its own verification records, so clearing `verified` first and then editing doesn't get around this.
- Deleting more than 5 notes, or an update matching more than 20
- Loosening privacy (for example making a sensitive note normal, or a local-only note synced)
- Granting or raising a connection's level or a token's scope
- Using a secret whose policy is `ask`, submitting a form, and emailing anyone but you
- `organize` runs that move or convert notes, schema merges and new top-level areas

**Losing your passkeys**: two passkeys are requested at sign-up. If both are lost, recovery is sign-in plus a 72-hour wait, with a notice to every verified email address, before a new passkey can approve anything.

## 5. Privacy classes

| Class         | Examples                                                                 | Rule (same in every mode)                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **normal**    | Roles, projects, papers, awards                                          | Synced, indexed, private by default                                                                                                                                                                                        |
| **sensitive** | Grades, test scores, passport details, health, finance, family           | Synced and indexed in a separate sensitive index. Visible to you, and to a connection only if you grant it the `sensitive` scope when connecting (off by default). Never in emails, notification previews or shared caches |
| **secret**    | Passport and national ID numbers, portal passwords, bank account numbers | Secrets vault only: never indexed, never returned to agents (see "Secrets")                                                                                                                                                |

**Vault documents**: scans that print secret values (passport, national ID, visa, bank statements) are stored encrypted and are never indexed, and their text, page images and file URLs are never returned to agents. Agents get a redacted summary instead. Passport fields come from a deterministic MRZ parse on the server: name, nationality and dates go to the note, and the number goes to the vault. You view the original on the site after a passkey check. **Every upload starts unclassified** and is treated as a vault document: no indexing, no extracted text and no page images for agents, and its summary says only "unclassified document, waiting for you". It's cleared only when server-side checks (MRZ, IBAN and ID-number patterns) find nothing _and_ you confirm its kind; marking the kind at upload just replaces that confirmation tap. The checks always run, and anything they detect stays vaulted whatever kind was chosen. Vault storage ships in M0, before any upload. A redacted summary beyond kind, issuer and dates is only offered where a structured parse (like MRZ) defines exactly what is kept.

Any note or folder can additionally be made local-only, when a local copy exists. That trades cloud features for that note for never leaving the disk.

**What a laptop copy holds**: by default, normal notes, their files and your local-only notes. Sensitive notes stay in the cloud unless you choose "keep sensitive notes on this laptop" for a device you marked as yours. Vault-document files are never written to disk; only their sidecar note is. On disk, the sensitive scope binds only Brainiac's tools, not other programs that read files, and the plan says so. Brainiac's Claude Code hook also blocks Read, Grep and Glob on sensitive folders, `documents/files/` and `inbox/`.

## 6. Retention and deletion

- Deleted notes are tombstones for 30 days, then purged. Undo works from revision history (inverse changes) for 30 days.
- Deleting an account removes live data (DO storage, R2 files, indexes, Neon rows) within 24 hours. Disaster-recovery copies (DO point-in-time recovery, Neon's restore window) expire within 30 days and are never restored into a deleted account.
- Processors and what they keep (email delivery logs, treg call logs) are listed on the settings page.
