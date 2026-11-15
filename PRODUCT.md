# Product

<!-- impeccable:product-schema 1 -->

<!-- Written from AGENTS.md, docs/internals/contract.md, docs/product/features/viewer.md and issue #51. -->

## Platform

web (desktop and phone browsers, one PWA on phones)

## Users

- **The person.** A student or early-career applicant keeping their whole record for admissions, study abroad,
  scholarships and jobs: grades, test scores, roles, papers, letters, IDs. They open the site to check what their
  Claude filed, fix a value, approve a change with a passkey, and answer questions. On a laptop for long sessions,
  on a phone for quick reviews between other things.
- **Their Claude.** It does the filing and drafting through MCP. It never sees the site; the site is where the
  person sees and decides what it did.

## Product Purpose

Brainiac keeps a person's record as typed markdown notes with sources, synced live between the site, phones and
laptops, and run by the Claude they already pay for. The site is where they read the record, edit it, and decide:
verify values, approve or reject proposals, answer what their Claude asked.

Success means the person trusts every number on an application because they checked it here, quickly.

## Positioning

The record that decides your applications, kept as plain files your own Claude works on, with every fact sourced
and every risky change approved by you.

## Operating Context

- Dense information: a record has hundreds of items, each with fields, sources and checks.
- Live sync over one WebSocket; offline shows this device's copy.
- Sensitive notes load on demand and say so when offline.
- Reviews happen in short bursts, often one-handed on a phone.

## Capabilities and Constraints

- Every number shown comes from a stored field; unchecked values say so.
- Approvals are passkey signatures; the UI only asks, it never approves for the person.
- Brainiac runs no model, so there is no chat box and no generated copy in the UI.
- First screen for a returning user under the p95 in docs/operations/quality-bar.md: no heavy hero, no motion on
  load beyond a short fade.

## Brand Commitments

- Correct facts over decoration. A wrong CGPA is worse than a plain screen.
- Your data stays yours: no third-party UI services, nothing that phones home.
- Open source; fictional fixture data (Nadia Karim) in every screenshot.

## Evidence on Hand

- #51 mock rounds: direction A, Workbench (T3 Code's frame), then motion at the Max level, then the tactile
  character direction: Pin UI's physical objects as reference, stick-it-up's Pip as mascot, Phosphor icons.
- Rejected: dev-tool glow (Vapi-like), badge collections with invented achievements, an editorial archive look.
  All read as generated rather than made.
- Mobbin references in those mocks: Plane intake, Mercury and Aboard approvals, Evernote and Air viewers, Fabric
  and Lightfield note rails, Tinder and Badoo card decks, Fey and Vapi command palettes, Ladder and Cal AI badges.

## Product Principles

1. Show the record, not the app. Chrome stays quiet so values carry the screen.
2. Every decision is one key or one swipe, and can be undone.
3. Motion explains a change the person made; nothing moves on its own.
4. Character comes from made things (stickers, stamps, a file box), never from invented data.
5. Dense by default, readable at 390px.
