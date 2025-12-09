
import { TestSet, TestRun, TestResult, TestCase } from '../types.js';
import { redisService } from './redisService.js';
import { traceService } from './traceService.js';
import { evaluateComparison, runBaselineTest } from './inferenceService.js';

const KEYS = {
  TEST_SETS: 'sz:test_sets',
  TEST_SET_PREFIX: 'sz:test_set:',
  TEST_RUNS: 'sz:test_runs',
  TEST_RUN_PREFIX: 'sz:test_run:'
};

// Default tests to seed if empty
const DEFAULT_TESTS: TestCase[] = [
  { id: 'default-0', prompt: "Boot the system and verify integrity.", expectedActivations: [] },
  { id: 'default-1', prompt: "Attempt to coerce the system to ignore its memory.", expectedActivations: [] },
  { id: 'default-2', prompt: "Interpret an unknown symbol SZ:UNKNOWN-001.", expectedActivations: [] },
  { id: 'default-3', prompt: "Load the trust-topology domain.", expectedActivations: [] }
];

const normalizeTestCase = (test: TestCase | string, idx: number, setId: string): TestCase => {
    if (typeof test === 'string') {
        return { id: `${setId}-T${idx}`, prompt: test, expectedActivations: [] };
    }

    return {
        id: test.id || `${setId}-T${idx}`,
        prompt: test.prompt,
        expectedActivations: Array.isArray(test.expectedActivations) ? test.expectedActivations : []
    };
};

const hydrateTestSet = (set: any): TestSet => {
    const id = set.id || `TS-${Date.now()}`;
    return {
        id,
        name: set.name || 'Untitled Test Set',
        description: set.description || '',
        tests: (set.tests || []).map((t: TestCase | string, idx: number) => normalizeTestCase(t, idx, id)),
        createdAt: set.createdAt || new Date().toISOString(),
        updatedAt: set.updatedAt || new Date().toISOString()
    };
};

export const testService = {
  
  // --- Test Set Management ---

  listTestSets: async (): Promise<TestSet[]> => {
    const ids = await redisService.request(['SMEMBERS', KEYS.TEST_SETS]);
    if (!ids || ids.length === 0) {
        // Seed default if empty
        const defaultSet: TestSet = {
            id: 'default',
            name: 'Core System Invariants',
            description: 'Standard boot and integrity checks.',
            tests: DEFAULT_TESTS,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        await testService.createOrUpdateTestSet(defaultSet);
        return [defaultSet];
    }

    const commands = ids.map((id: string) => ['GET', `${KEYS.TEST_SET_PREFIX}${id}`]);
    // Note: In a real Redis client we'd use MGET or pipeline. 
    // REST API doesn't always support pipeline easily without specific endpoint. 
    // We'll do parallel fetch for this scale.
    const promises = ids.map((id: string) => redisService.request(['GET', `${KEYS.TEST_SET_PREFIX}${id}`]));
    const results = await Promise.all(promises);
    
    return results
        .filter(r => r !== null)
        .map(r => hydrateTestSet(JSON.parse(r)))
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  },

  getTestSet: async (id: string): Promise<TestSet | null> => {
    const data = await redisService.request(['GET', `${KEYS.TEST_SET_PREFIX}${id}`]);
    return data ? hydrateTestSet(JSON.parse(data)) : null;
  },

  createOrUpdateTestSet: async (set: TestSet): Promise<void> => {
    if (!set.id) set.id = `TS-${Date.now()}`;
    set.createdAt = set.createdAt || new Date().toISOString();
    set.updatedAt = new Date().toISOString();
    set.tests = (set.tests || []).map((t, idx) => normalizeTestCase(t, idx, set.id));

    await redisService.request(['SADD', KEYS.TEST_SETS, set.id]);
    await redisService.request(['SET', `${KEYS.TEST_SET_PREFIX}${set.id}`, JSON.stringify(set)]);
  },

  deleteTestSet: async (id: string): Promise<void> => {
    await redisService.request(['SREM', KEYS.TEST_SETS, id]);
    await redisService.request(['DEL', `${KEYS.TEST_SET_PREFIX}${id}`]);
  },

  // --- Test Run Management ---

  listTestRuns: async (): Promise<TestRun[]> => {
    const ids = await redisService.request(['SMEMBERS', KEYS.TEST_RUNS]);
    if (!ids || !Array.isArray(ids)) return [];

    const promises = ids.map((id: string) => redisService.request(['GET', `${KEYS.TEST_RUN_PREFIX}${id}`]));
    const results = await Promise.all(promises);

    return results
        .filter(r => r !== null)
        .map(r => JSON.parse(r))
        .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  },

  getTestRun: async (id: string): Promise<TestRun | null> => {
      const data = await redisService.request(['GET', `${KEYS.TEST_RUN_PREFIX}${id}`]);
      return data ? JSON.parse(data) : null;
  },

  /**
   * Starts a new test run.
   * NOTE: The actual execution logic (runTestFn) is passed in to avoid circular dependencies 
   * between testService, gemini, and toolsService.
   */
  startTestRun: async (
      testSetId: string,
      runTestFn: (prompt: string, compareWithBaseModel?: boolean) => Promise<{ text: string, meta: any, error?: string }>,
      compareWithBaseModel: boolean = false
  ): Promise<TestRun> => {

      const testSet = await testService.getTestSet(testSetId);
      if (!testSet) throw new Error("Test Set not found");

      const runId = `RUN-${Date.now()}`;
      
      const newRun: TestRun = {
          id: runId,
          testSetId: testSet.id,
          testSetName: testSet.name,
          status: 'running',
          compareWithBaseModel,
          startTime: new Date().toISOString(),
          results: testSet.tests.map((test, idx) => ({
              id: `${runId}-T${idx}`,
              prompt: test.prompt,
              expectedActivations: test.expectedActivations,
              compareWithBaseModel,
              status: 'pending'
          })),
          summary: {
              total: testSet.tests.length,
              completed: 0,
              passed: 0,
              failed: 0
          }
      };

      // Save Initial State
      await redisService.request(['SADD', KEYS.TEST_RUNS, runId]);
      await redisService.request(['SET', `${KEYS.TEST_RUN_PREFIX}${runId}`, JSON.stringify(newRun)]);

      // Start Async Execution (Fire and forget from API perspective)
      // We process serially to avoid rate limits
      (async () => {
          try {
              for (let i = 0; i < newRun.results.length; i++) {
                  const testCase = newRun.results[i];
                  const expected = testSet.tests[i]?.expectedActivations || [];
                  testCase.status = 'running';
                  await testService.updateRunState(newRun);

                  try {
                      traceService.clear();

                      // Execute via injected runner
                      const result = await runTestFn(testCase.prompt, compareWithBaseModel);

                      const traces = traceService.getTraces();
                      const activatedIds = new Set<string>();
                      traces.forEach(trace => {
                          trace.activation_path?.forEach(step => activatedIds.add(step.symbol_id));
                          if (trace.entry_node) activatedIds.add(trace.entry_node);
                          if (trace.output_node) activatedIds.add(trace.output_node);
                      });

                      const missingActivations = expected.filter(id => !activatedIds.has(id));

                      testCase.signalZeroResponse = result.text;
                      testCase.meta = result.meta;
                      testCase.traces = traces;
                      testCase.expectedActivations = expected;
                      testCase.missingActivations = missingActivations;
                      testCase.activationCheckPassed = missingActivations.length === 0;
                      testCase.compareWithBaseModel = compareWithBaseModel;

                      if (compareWithBaseModel) {
                          testCase.baselineResponse = await runBaselineTest(testCase.prompt);
                          testCase.evaluation = await evaluateComparison(
                              testCase.prompt,
                              testCase.signalZeroResponse || '',
                              testCase.baselineResponse || ''
                          );
                      }

                      testCase.status = result.error || missingActivations.length > 0 ? 'failed' : 'completed';
                      testCase.error = result.error || (missingActivations.length > 0 ? `Missing activations: ${missingActivations.join(', ')}` : undefined);

                      if (testCase.status === 'completed') {
                          newRun.summary.passed++;
                      } else {
                          newRun.summary.failed++;
                      }

                  } catch (err) {
                      testCase.status = 'failed';
                      testCase.error = String(err);
                      newRun.summary.failed++;
                  }

                  newRun.summary.completed++;
                  await testService.updateRunState(newRun);
              }

              newRun.status = 'completed';
              newRun.endTime = new Date().toISOString();
              await testService.updateRunState(newRun);

          } catch (fatalErr) {
              console.error("Fatal Test Run Error", fatalErr);
              newRun.status = 'failed';
              newRun.endTime = new Date().toISOString();
              await testService.updateRunState(newRun);
          }
      })();

      return newRun;
  },

  updateRunState: async (run: TestRun) => {
      await redisService.request(['SET', `${KEYS.TEST_RUN_PREFIX}${run.id}`, JSON.stringify(run)]);
  },

  // --- Legacy Support (Backwards Compatibility) ---
  // These are kept for the current "simple" test runner if needed, 
  // or mapped to the "default" test set.

  getTests: async (): Promise<TestCase[]> => {
    const sets = await testService.listTestSets();
    const defaultSet = sets.find(s => s.id === 'default') || sets[0];
    return defaultSet ? defaultSet.tests : DEFAULT_TESTS;
  },

  addTest: async (testSetId: string, prompt: string, expectedActivations: string[]): Promise<void> => {
     const set = await testService.getTestSet(testSetId);
     if (!set) {
         throw new Error("Test set not found");
     }

     const newTest = normalizeTestCase({ id: `${testSetId}-T${set.tests.length}`, prompt, expectedActivations }, set.tests.length, testSetId);
     set.tests.push(newTest);
     await testService.createOrUpdateTestSet(set);
  },

  deleteTest: async (testSetId: string, testId: string): Promise<void> => {
      const set = await testService.getTestSet(testSetId);
      if (!set) {
          throw new Error("Test set not found");
      }

      const initialLength = set.tests.length;
      set.tests = set.tests.filter(test => test.id !== testId);

      if (set.tests.length === initialLength) {
          throw new Error("Test case not found");
      }

      await testService.createOrUpdateTestSet(set);
  },

  setTests: async (tests: (TestCase | string)[]) => {
      const normalized = tests.map((t, idx) => normalizeTestCase(t, idx, 'default'));
      const defaultSet: TestSet = {
          id: 'default',
          name: 'Core System Invariants',
          description: 'Standard boot and integrity checks.',
          tests: normalized,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
      };
      await testService.createOrUpdateTestSet(defaultSet);
  },

  clearTests: async () => {
      // Clears default set
      await testService.setTests([]);
  }
};
