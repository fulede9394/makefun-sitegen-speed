# sitegen-speed — a faster makefun-site

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/fulede9394/makefun-sitegen-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/fulede9394/makefun-sitegen-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

Entry for [site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122)
("Build a static site faster", $100): a dependency-free reimplementation of
makefun-site 1.0.0's `build`, written from its README spec, that returns the
same output tree byte for byte — and faster.

- `solve.js` — `run(input)`: the whole build. Front matter, the Markdown subset,
  the template dialect, slugs and the build report, re-derived from the spec and
  optimized: bulk HTML escaping, an index-jumping inline scanner, memoized
  slugs, a single-pass Markdown renderer, and templates compiled once to JS
  functions (with fused lookup/conversion helpers and reused loop scopes).
- `main.ts` — the driver: reads `/input/cases.json`, answers each case with
  `run`, writes `/output/answers.json`.

Verified locally: 3/3 practice cases byte-identical to the reference (and the
kit's own `grade-local` passes 3/3 with the L1 regrade reproduced byte for
byte), 132 hand-crafted edge cases identical, 108 randomly drawn generated
sites identical, at ~1.75x the baseline's CPU time on the practice set.
