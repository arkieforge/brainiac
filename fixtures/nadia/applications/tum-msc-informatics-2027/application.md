---
id: 01M6AM78G0STS7TB29G7A10DCY
type: Application
title: "TUM MSc Informatics, Winter 2027"
kind: university
deadline: 2027-05-31
portal: "https://campus.tum.de"
portal_login: secret:portal.tum
status: preparing
requirements:
  - need: "Bachelor transcript"
    check: {type: Document, kind: transcript}                       # deterministic check
  - need: "IELTS 6.5 or higher, valid on the deadline"
    check: {type: TestScore, test: ielts-academic, field: overall, gte: 6.5, valid_on: deadline}
  - need: "Two recommendation letters"
    check: {type: Letter, for: this, status: received, count_gte: 2}
  - need: "Motivation for the specialization (portal question 4)"
    check: manual                                                   # free text: you tick it
---
## Plan

Ask Dr Okafor for the first letter in January.

## Questions

- Does the APS certificate need to be the original?
