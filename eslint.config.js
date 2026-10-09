// ESLint flat config. Encodes the project rules that can be checked statically:
//  - R2: Math.random is banned everywhere; wall-clock reads are banned in the engine
//    except planner/timing.ts (reporting only).
//  - R3: strategies and the planner may not import the truth world (integrity rule).
import tseslint from 'typescript-eslint';

const TRUTH_MODULES = ['**/sim/world', '**/sim/world.ts', '**/sim/step', '**/sim/step.ts', '**/sim/race', '**/sim/race.ts'];

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'docs/**', '**/*.config.*', 'vitest.workspace.ts'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-restricted-properties': ['error', { object: 'Math', property: 'random', message: 'Use the seeded RNG (engine/rng). Math.random breaks determinism (R2).' }],
    },
  },
  {
    files: ['packages/engine/src/**/*.ts'],
    ignores: ['packages/engine/src/planner/timing.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "MemberExpression[object.name='Date'][property.name='now']", message: 'No wall-clock reads in the engine (R2). Use planner/timing.ts.' },
        { selector: "MemberExpression[object.name='performance'][property.name='now']", message: 'No wall-clock reads in the engine (R2). Use planner/timing.ts.' },
      ],
    },
  },
  {
    files: ['packages/engine/src/planner/**/*.ts', 'packages/engine/src/strategy/**/*.ts', 'packages/engine/src/estimator/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: TRUTH_MODULES, message: 'Integrity rule (R3): strategies, estimator and planner must not import the truth world.' }] }],
    },
  },
);
