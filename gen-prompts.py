# Extract the released prompt strings straight from the EoM Python source (AST, no import),
# so the page uses them byte for byte. Usage: python3 gen-prompts.py <path-to-EoM-repo>
import ast, json, sys
R = sys.argv[1].rstrip('/') + '/hayekmas/'
def consts(path):
    t = ast.parse(open(path).read()); d = {}
    for n in ast.walk(t):
        if isinstance(n, ast.Assign) and len(n.targets) == 1 and isinstance(n.targets[0], ast.Name):
            v = n.value
            try:
                if isinstance(v, ast.Call) and isinstance(v.func, ast.Attribute) and v.func.attr in ('strip', 'rstrip'):
                    d[n.targets[0].id] = getattr(ast.literal_eval(v.func.value), v.func.attr)()
                else:
                    d[n.targets[0].id] = ast.literal_eval(v)
            except Exception:
                pass
        if isinstance(n, ast.ClassDef):
            for b in n.body:
                if isinstance(b, ast.Assign) and isinstance(b.targets[0], ast.Name) and b.targets[0].id in ('FROZEN_SYSTEM_PROMPT', 'TRAINABLE_SYSTEM_PROMPT'):
                    d[n.name + '.' + b.targets[0].id] = ast.literal_eval(b.value)
    return d
out = {}
out.update(consts(R + 'base/prompts.py'))
out.update(consts(R + 'adapters/researchworld/prompts.py'))
out.update(consts(R + 'adapters/researchworld/agent.py'))
keep = ['GOOD_AGENT_BIRTH_PROMPT', 'BAD_AGENT_BIRTH_PROMPT', 'WAKEUP_PROMPT', 'NEXT_STEP_PROMPT', 'ANSWER_PROMPT_POSTFIX',
        'TERMINAL_MODE_NOTE_ABSTAIN', 'TERMINAL_MODE_NOTE_NO_ABSTAIN', 'JUDGE_NOTE', 'RUBRIC_JUDGE_PROMPT']
res = {k: out[k] for k in keep}
for c in ['Literature', 'Planner', 'Deriver', 'Verifier', 'Answer']:
    for f in ['FROZEN_SYSTEM_PROMPT', 'TRAINABLE_SYSTEM_PROMPT']:
        res[c + 'ResearchAgent.' + f] = out[c + 'ResearchAgent.' + f]
res['_source'] = 'github.com/zhentingqi/EoM @ d272266, hayekmas/base/prompts.py + adapters/researchworld/{prompts,agent}.py (MIT)'
json.dump(res, open('released_prompts.json', 'w'), ensure_ascii=False, indent=1)
print('wrote released_prompts.json', len(res), 'strings')
