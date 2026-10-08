'use strict';
// Fixture decider that never answers within the budget: one blocking spawnSync with no
// timeout, the shape of a probe call stuck under load. The sleep ends by itself (budget
// plus three seconds); nothing here or in the test signals it.
const { spawnSync } = require('child_process');

const budgetMs = Number(process.env.KG_BUDGET_MS);
spawnSync('/bin/sleep', [String(budgetMs / 1000 + 3)]);
