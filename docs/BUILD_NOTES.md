# Build stage notes: Economy of Minds, replicated (v4)

Raw material for the technical write-up. Facts and numbers only. Write the article in your own words.

## What I rebuilt
The full training loop of Qi et al., *Economy of Minds* (arXiv 2606.02859). I checked every rule against the released code at github.com/zhentingqi/EoM, commit d272266, research adapter (`researchworld`). Two versions share one set of rules:
- **Toy mode** (`engine.js`): fast agents, so I can run thousands of training runs and repeat the paper's experiments.
- **Real AI mode** (`llm-mode.js`): every agent is a Claude prompt. Wake-up, work, answers and prompt rewriting are all real model calls. The problems are 26 real MATH-500 problems (Hendrycks et al., openai/prm800k split), marked by exact answer.

## The rules, and where each comes from
| Rule | Source | What I do |
|---|---|---|
| Roles: planner, executor, verifier, answer | paper (MATH), code has literature + deriver | Same four as the paper's MATH setup |
| Wake-up: each agent decides if it acts | Sec. 2.2 | Toy: a wake-up list in the genome. Real AI: one batched model call per turn |
| Hard wake rules | code | Never the same role twice in a row. Planner starts first. Answer agent always wakes after an executor |
| Auction: highest awake bid wins, ties random | Sec. 2.2 | Same |
| Payment: winner pays its bid to the previous winner, first winner pays the House | Eq. 1 | Same |
| Newcomer bid = top awake veteran bid + epsilon, then frozen | Eq. 2, code `fixed_with_eps` | Same. Research config's `fixed` is a switch |
| Reward | code: `path_reward_and_stepwise_reward` | Score is +1 right, -1 wrong or missing (x100). Answer agent gets an extra half. The full score is split over every turn on the workflow. Paper Eq. 1 (last agent only) is an option |
| Rent | Sec. 2.3 | 20 every 3 tasks (0.2 x100) |
| Bankruptcy | code: wealth < 0 | Same |
| Replay after bankruptcy, survivors' credits restored | Alg. 1, code | Up to 2 tries |
| Births after bankruptcy | Sec. 2.3 | 33.4% copy of the richest, 33.4% repair of the bankrupt agent |
| Births every 3 tasks | code | 2 births, half copies, half repairs of the poorest |
| Refill to the minimum | code mutates the richest (Alg. 1 says a starting template) | Code version |
| Role recovery | code only | Same |
| Copy with a small change | `GOOD_AGENT_BIRTH_PROMPT` | Toy: small random change. Real AI: that prompt |
| Repair from the failure trace | `BAD_AGENT_BIRTH_PROMPT` | Toy: fixes the weakness the failure shows. Real AI: that prompt, with the task, the right answer and the trace |
| Last turn: answer agents only | code terminal mode | Same |
| Testing: frozen team, no money moves | Alg. 2 | 200 fixed test problems, same dice at every checkpoint |

## Toy settings I chose (not from the paper)
- Problem levels 1 to 5 have 1, 2, 2, 3, 3 steps. Base step accuracy 0.80, 0.72, 0.64, 0.56, 0.48.
- Step chance = base + executor skill + 0.12 x plan quality.
- Agent traits: planner thoroughness. Executor skill and self-checking. Verifier error-catching and false alarms. Answer agent patience and care.
- The founders are weak on purpose: skill -0.2 to 0, self-checking 0 to 0.15.
- 100 training tasks per run, easy to hard (20 per level), test every 10 tasks.

## Results (30 seeds, `node experiments.js 30`)
| Claim | Paper | Rebuild | Verdict |
|---|---|---|---|
| Weak team gets stronger | MATH 15.9% to 57.0% | 24.6% to 60.9% final, 73.7% best checkpoint | Replicated |
| Gains reach the hardest problems | Fig. 6 | Level 5: 3.1% to 38.4% | Replicated |
| No auction hurts | finance 52.5 to 48.0 | 60.9 to 50.1 | Replicated |
| No exploration hurts most | finance 52.5 to 26.0 | 61.8, no drop | Not replicated |
| No exploitation hurts | finance 52.5 to 33.5 | 54.4 final, but a higher training average (47.1 vs 44.1) | Partly |
| Rent and reward need balance | MATH Table 2 left | Original 60.9 beats rent x10 47.2, reward x0.2 51.5, reward x4 46.0 | Replicated |
| Easy-to-hard order matters | ~57 vs ~47 | 60.9 vs 60.5 | Not replicated |
| Agents absorb checking | App. E | Executor self-checking 7% to 59% | Replicated |
| Workflows get shorter | App. E | Easy tasks skip the planner. Level 5 got longer (6.4 to 7.1 turns) | Partly |
| Price approaches value | Theorem 1 | 6 of 8 situations | Partly |
| Results vary a lot | mean 43.9 vs best 57.0 | final sd 22.3 points, best 73.7 vs final 60.9 | Replicated |
| Economy beats a stronger single agent | 57.0 vs 51.9 | Needs real models | Not testable |

Paper text vs released code, same 30 seeds: released reward 60.9, paper Eq. 1 reward 46.2, shared by unique agents 49.8, everyone bids the same 52.8. So the released code's reward rule matters a lot.

## Why some results did not replicate (my reading)
- **Exploration:** my repair is a rule, not a model rewriting a prompt. And role recovery still adds agents when exploration is off.
- **Curriculum:** hard-first learns faster early in my toy because hard tasks fail more, so more repairs happen. Both end in the same place.
- **Theorem 1 exceptions:** the two situations where price beats value are where newcomers keep arriving and bidding up (mostly the answer agent's turn after an executor).
- **Longer hard workflows:** the code's rule that the answer agent always wakes after an executor means patient answer agents learn to wait, so P E A E A E A is common.

## The replica (v4, the main part of the page now)
A line-by-line JavaScript port of the released engine, run with Claude agents.
- **Ported files:** `base/mas.py`, `population.py`, `agent.py`, `config.py`, the training loop from `pipeline.py`, the periodic test from `researchworld/runtime.py`, and the research adapter (`researchworld/env.py`, `agent.py`). See `replica-core.js`.
- **Prompts:** pulled out of the Python source by `gen-prompts.py` (reads the files with Python's AST, no copying by hand). A check confirms all 15 prompts and the step template match byte for byte. My first hand copy was wrong in 4 places (blank lines), which is why I switched to the script.
- **Config:** `global_configs/train_research.json` exactly. Facts I had wrong before: the newcomer premium is 0.1 (not 0.01 or 1), wake-up uses a separate cheap model (gpt-5-nano), the test runs every 3 tasks, and training is 40 tasks for 2 epochs.
- **Data:** the repo ships its 40 + 19 FrontierScience-Research tasks with rubrics, so the "exact" preset uses exactly those. MATH: 20 random problems per level from the MATH train split (seed 2606), test from MATH-500.
- **Tests:** `node test-replica.js`, 23 tests, all pass. A scripted stand-in model drives whole episodes and each test checks one rule against the Python (payments, both bid rules, ties, wake-up rules, rewards, missing answers, terminal turn, bankruptcy and rollback, role recovery, rent, births, population cap, copy and repair prompts, frozen test, judge parsing, MATH answer checking, checkpoint resume).

### Presets
| Preset | What changes from the release | Size |
|---|---|---|
| Released code, exact | Nothing | 80 training tasks, 19 test tasks every 3 tasks, about 70,000 calls |
| Released code, lighter testing | Only measuring: 5 test tasks, before training and every 10 tasks | about 12,000 calls |
| Paper's MATH setup | Not in the release. Built from the paper: planner, executor, verifier, 128-token budget, 20 per level easy to hard, Eq. 2 bids | 100 tasks, 25 test problems, about 9,000 calls |
| Quick look | Same MATH setup, shrunk | 15 tasks, 10 test problems, about 900 calls |

### What is still not identical (say this in the write-up)
1. **The model.** The release uses a local model at temperature 0.9 (the paper: Llama-3.1-8B, Gemma-2-9B). The replica uses Claude, and a page cannot set the temperature. Claude is far stronger, so absolute numbers will not match the paper.
2. **Speed.** The code runs 10 wake-up checks at once. The page queues them, 2 at a time. Same results, slower.
3. **Random numbers.** A seeded generator instead of Python's unseeded one, so runs can resume and replay.
4. **MATH setup.** The paper does not say who submits the answer, so the executor does. The 128-token budget is a cut at 480 characters, since a page cannot set max_tokens.
5. **Ablations.** Not in the release. The page has switches that do what the paper describes (no auction = random awake agent, no exploration = no repairs, no exploitation = no copies). Off by default.

### Runs
- Runs save to the page's database after every task (like the code's checkpoints) and resume from the last finished task. "Stop now" throws away the unfinished task, exactly like a resume in the code would.
- Saved runs can be replayed on the floor without spending any calls, and downloaded as JSON for the write-up.
- I have NOT run it with real Claude. Everything was tested with a stand-in model in Node and in a browser. Run "Quick look" first (about 900 calls), then "Paper's MATH setup" if usage allows.

## Paper vs released code (for the Learn Article footnote and the validation email)
1. Bankruptcy: code uses `wealth < 0`. Alg. 1 says zero or less. My Learn Article footnote follows Alg. 1, so fix it.
2. Reward: every released config uses `path_reward_and_stepwise_reward`. Eq. 1 and Alg. 1 pay the final actor only.
3. Bids: the research config uses `fixed`, so every veteran settles to the base bid. CloudCast uses `fixed_with_eps` (Eq. 2).
4. Refill: Alg. 1 mutates a starting template. The code mutates the richest agent.
5. Role recovery is in the code, not in the paper.
6. The README lists 3 adapters. There is no MATH or finance adapter in the release.
7. `birth_good_agent` and `birth_bad_agent` exist (cloudcast/agent.py lines 144 and 177).

## Tests
38 tests, all passing in Node and in the page, at least one per rule, including my article's three-agent ledger (12, 13, 13 and the bug path 12, 13, 3). Run `node run-tests.js`. Real AI plumbing: `node test-llm.js`.

## Files
- `engine.js`: toy engine (no DOM)
- `replica-core.js`: the port of the released engine (the replica)
- `replica-ui.js`, `replica-section.html`: the replica's page
- `gen-prompts.py`, `released_prompts.json`: prompts extracted from the Python source
- `replica_data.json`: the 59 science tasks and 150 MATH problems
- `test-replica.js`: the replica's 23 tests
- `llm-mode.js`: the old v3 real AI mode, kept for the iteration story
- `tests.js`, `run-tests.js`, `test-llm.js`: tests
- `experiments.js`: writes `results.json` (the recorded 30-seed runs)
- `math_subset.json`: the 26 MATH problems
- `page.src.html`, `app.js`: the page and the toy model
- `build.js`: inlines everything into `dist/economy-of-minds.html`
- `engine-v1.js`, `page.v1.src.html`, `page.v2.src.html`: earlier versions, for the iteration story
