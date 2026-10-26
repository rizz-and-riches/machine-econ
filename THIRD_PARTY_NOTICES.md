# Third-party notices

## Economy of Minds (hayekmas)
`replica-core.js` is a JavaScript port of the released Economy of Minds code, and
`released_prompts.json` holds prompt strings extracted from it by `gen-prompts.py`.

Source: https://github.com/zhentingqi/EoM (commit d272266)
Licence: MIT, "EoM contributors" (as stated in that repository's README and pyproject.toml).

Paper: Zhenting Qi et al., *Economy of Minds: Emerging Multi-Agent Intelligence with
Economic Interactions*, arXiv:2606.02859 (2026).

## FrontierScience-Research tasks
`replica_data.json` (`research`) contains the 40 training and 19 test tasks with rubrics
that ship in the EoM repository under `third_party/benchmarks/frontier-science-research/`.
They come from OpenAI's FrontierScience-Research benchmark and are included here only
because the EoM release redistributes them. Their terms are OpenAI's.

## MATH
`replica_data.json` (`math`) contains problems from the MATH dataset (Hendrycks et al., 2021,
MIT licence), taken from the splits in https://github.com/openai/prm800k (MIT licence).
The answer checker in `replica-core.js` ports MATH's `is_equiv` / `strip_string`.

## KaTeX
`index.html` loads KaTeX 0.16.9 from cdnjs (MIT licence) to render maths.
