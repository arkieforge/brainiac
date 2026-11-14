# Overview and review

```
Record health   412 items · 371 checked · 18 look wrong · 9 stale · 3 conflicts · 5 questions
EDUCATION
  ✓  BSc CSE · AIUB · 2022–2026 · CGPA 3.84                proof: transcript p1
  !  HSC · Dhaka College · 2021 · GPA 5.00                 LinkedIn says 2020
TESTS
  ✓  IELTS Academic · 8.0 · 2026-11-02 · expires 2028-11
     IELTS Academic · 7.5 · 2025-03 · superseded
PROJECTS
  ✓  Campus Bus Tracker · lead dev · 214★ · 2025          used by 3 applications
  ?  Bangla NER toolkit · 2024                             no source for "92% F1"
```

- **Headlines**: one line per item from a per-type template in the schema; marks for checked (✓), looks wrong (!), unchecked or unproven (?), stale, and conflict.
- **Detectors** (deterministic first): note vs its own document's extracted value, note vs another note, note vs an outside profile, impossible values (end before start, score above the maximum), missing proof, duplicates, inconsistent name spellings, an expired item still used by an application, agent changes nobody looked at. Each comes with its evidence and a suggested fix.
- **Review mode**: one item at a time, worst first (flags, then anything an open application uses, then the rest). Keys: `y` correct, `e` edit, `f` apply the fix, `?` not sure, `s` skip, `u` undo; swipe on the phone.
- **"Correct" sets `verified`** for those fields at that revision. Review runs on one passkey signature (10 minutes, renewed with a tap while you keep reviewing), so each key press is an approval without a new prompt. In Claude, the same card gives an approval link instead.
- **Fix in place**: type-aware editors, the effects shown before saving ("2 drafts go stale; Edinburgh's check still passes"), one undo for all of it.
- **Checks that come to you**: a pre-flight before each submission (everything the packet sends must be checked), and a short weekly batch of anything not checked in 12 months that an open application uses.
