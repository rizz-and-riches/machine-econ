# Recreating Economy of Minds

**An implementation of its agent economy, with an interactive toy model to explain the mechanisms.**

Economy of Minds (Qi et al., 2026, [arXiv:2606.02859](https://arxiv.org/abs/2606.02859)) is a team of AI agents with no boss: a market decides who works, who gets paid, who goes bankrupt, and whose prompt gets rewritten.

I ported the authors' [released code](https://github.com/zhentingqi/EoM) line by line to JavaScript, so the whole training loop runs in a browser with real Claude agents. A separate toy version of the same market runs instantly, to show each rule at work.

Built for my TKS Build stage, October 2026.

## What this is, and what it isn't

- **It is a replication of the system.** The auction, payments, rent, bankruptcy, replays, births and prompt evolution are ported from the released code and checked rule by rule by 23 tests. The prompts are extracted from their source byte for byte.
- **It is not a reproduction of the paper's scores.** The paper used Llama-3.1-8B and Gemma-2-9B. This uses Claude, which is far stronger, so the starting team already scores higher and has less room to improve.
- **The toy model is an explainer, not evidence.** Its agents and tasks are programmed by me. Its results show the mechanism behaves the way the paper describes. They don't show the paper's findings hold.
- **Next stage (Iterate):** run the authors' own Python code with Llama-3.1-8B locally, to test whether the results hold with the paper's own model.

## What's in here

**The build: real agents** (`replica-core.js`, `replica-ui.js`)
- Their engine (`mas.py`, `population.py`, `agent.py`, `config.py`), training loop (`pipeline.py`) and research adapter, ported line by line.
- Their prompts are pulled straight out of the Python source by `gen-prompts.py`, so they match byte for byte.
- Their research config (`global_configs/train_research.json`), every value.
- Their 40 training and 19 test science tasks with rubrics, plus 150 MATH problems for the paper's MATH setup.
- Runs save after every task and resume later, like the code's checkpoints. Saved runs can be replayed for free.

**The explainer: toy model** (`engine.js`, `app.js`)
- The same economic rules with stand-in agents, whose "prompt" is a wake-up list plus a few skill numbers.
- Repeats the paper's Table 2 ablations, the rent and reward sensitivity, the curriculum test and the Theorem 1 price check over 30 seeds.

## Run it

```
npm test              # 23 replica tests + 38 toy tests
npm run build         # writes index.html and dist/economy-of-minds.html
npm run experiments   # reruns the 30-seed toy experiments into results.json
```

Open `index.html` in a browser for the toy model. The replica needs a way to call Claude, which it gets when the page runs as a Claude artifact on claude.ai. Each run uses the Claude usage of whoever presses Start.

## Exact vs not exact

| Part | Same as the released code? |
|---|---|
| Auction, payments, bids, rewards, rollback, rent, bankruptcy, births, refill, role recovery, last-turn rule, frozen test | Same, ported line by line and checked by 23 tests |
| Prompts | Same, extracted from the source and checked byte for byte |
| Config, training loop, test schedule, science tasks | Same |
| Model | **Different.** They used Llama-3.1-8B and Gemma-2-9B. This uses Claude, which is much stronger, so absolute scores won't match the paper |
| Parallel calls | Queued 2 at a time instead of 10. Same results, slower |
| Random numbers | Seeded instead of Python's unseeded `random`, so runs can resume and replay |
| MATH setup | Not in the release. Built from the paper (planner, executor, verifier, 128-token budget, 20 problems per level easy to hard). The paper doesn't say who answers, so the executor does |
| Table 2 ablations | Not in the release. Switches that do what the paper describes, off by default |

## Toy model patterns (30 seeds, 100 training tasks)

These check that the mechanism moves in the direction the paper describes, with programmed agents. They are not a reproduction of the paper's findings.

| Claim from the paper | Toy model | Toy pattern |
|---|---|---|
| A weak team gets much stronger | 24.6% to 60.9% (best checkpoint 73.7%) | Same |
| Removing the auction hurts | 60.9% to 50.1% | Same |
| Rent and reward need balance | Original 60.9% beats rent x10 (47.2%), reward x0.2 (51.5%), reward x4 (46.0%) | Same |
| Agents absorb checking | Executor self-checking 7% to 59% | Same |
| Removing exploration hurts most | No drop | Different |
| Easy-to-hard order matters | 60.9% vs 60.5% | Different |
| Prices approach value (Theorem 1) | 6 of 8 situations | Partly |

Why some didn't replicate, plus every place the paper and the code disagree, is in [`docs/BUILD_NOTES.md`](docs/BUILD_NOTES.md).

## Where the paper and the code differ

1. Bankruptcy: the code removes agents below zero. Algorithm 1 says zero or less.
2. Reward: the code pays a centred score (+1 or -1) split over every turn, plus half to the answer agent. Eq. 1 pays only the final actor.
3. Bids: the research config uses `fixed` bids, so every veteran ends up with the same bid. Eq. 2 is `fixed_with_eps`.
4. Refill: Algorithm 1 mutates a starting agent. The code mutates the richest.
5. Role recovery exists in the code but not in the paper.

## Files

| File | What it is |
|---|---|
| `replica-core.js` | The port of the released engine |
| `replica-ui.js`, `replica-section.html` | The replica's page |
| `released_prompts.json`, `gen-prompts.py` | Prompts extracted from the Python source |
| `replica_data.json` | Science tasks and MATH problems |
| `test-replica.js` | Replica tests |
| `engine.js`, `tests.js`, `run-tests.js` | Toy engine and its tests |
| `app.js`, `page.src.html`, `build.js` | The page and its build |
| `experiments.js`, `results.json` | Toy experiments and recorded results |
| `history/` | Earlier versions, kept for the iteration story |
| `docs/BUILD_NOTES.md` | Full notes: rules, results, paper vs code |

## Credits

Paper and original code: Zhenting Qi et al. and the EoM contributors (MIT). Science tasks: OpenAI's FrontierScience-Research, as shipped in the EoM repo. MATH: Hendrycks et al. (2021). Details in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

MIT licence, see [`LICENSE`](LICENSE).
