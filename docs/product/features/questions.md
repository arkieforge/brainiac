# Questions

Gaps get found before an application finds them. Each gap becomes one short, typed question, asked where you are, and the answer is written back with its source. Finding gaps is deterministic; no model is needed.

| Gap                        | Example                                                                   | Answer input                   |
| -------------------------- | ------------------------------------------------------------------------- | ------------------------------ |
| Required field empty       | "When did your internship at Acme end?"                                   | Month picker, or "still there" |
| Requirement check failing  | "TUM needs an APS certificate. Do you have one?"                          | Upload / "applied" / "not yet" |
| Claim without proof        | "Where does '1,800 daily users' come from?"                               | Upload, link, or "estimate"    |
| A form needs something new | "The Schengen form asks for your father's full name."                     | Text, stored sensitive         |
| Extraction unsure          | "Your transcript shows 3.71 and 3.74 on different pages. Which is final?" | Choice, both pages shown       |
| Stale                      | "Are you still a TA at Northvale?"                                        | Yes / no + end date            |

- **Smallest input** that fits; suggested answers pre-filled when Brainiac can infer them, applied only on your tap. Each question says why ("TUM needs this by 31 May").
- **Where**: the overview, inline on the affected line, phone cards, `brainiac questions`, your Claude (it lists them with `query` and records your replies with `update`), and a weekly email of links (answered on the site, never by email reply).
- **Not a nag**: at most 5 a day by default, ranked by deadline (anything due within 7 days may exceed it); similar gaps batched; "not applicable" remembered; sensitive questions never in email or notification previews.
- A question closes itself when the gap disappears some other way.
