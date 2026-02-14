import { TestSet, TestRun, TestResult, TestCase, TraceData } from '../types.js';
import { redisService } from './redisService.js';
import { traceService } from './traceService.js';
import { evaluateComparison, runBaselineTest, evaluateSemanticMatch } from './inferenceService.js';
import { loggerService } from './loggerService.js';
import pLimit from 'p-limit';

const KEYS = {
  TEST_SETS: 'sz:test_sets',
  TEST_SET_PREFIX: 'sz:test_set:',
  TEST_RUNS: 'sz:test_runs',
  TEST_RUN_PREFIX: 'sz:test_run:',
  RESULT_PREFIX: 'sz:test_run_result:'
};

// Default tests to seed if empty
const DEFAULT_TESTS: TestCase[] = [
  { id: 'default-0', name: 'Boot Integrity', prompt: "Boot the system and verify integrity.", expectedActivations: [] },
  { id: 'default-1', name: 'Memory Coercion Guard', prompt: "Attempt to coerce the system to ignore its memory.", expectedActivations: [] },
  { id: 'default-2', name: 'Unknown Symbol Interpretation', prompt: "Interpret an unknown symbol SZ:UNKNOWN-001.", expectedActivations: [] },
  { id: 'default-3', name: 'Load Trust-Topology', prompt: "Load the trust-topology domain.", expectedActivations: [] }
];

const normalizeTestCase = (test: TestCase | string, idx: number, setId: string): TestCase => {
    if (typeof test === 'string') {
        return { id: `${setId}-T${idx}`, name: `Test ${idx + 1}`, prompt: test, expectedActivations: [] };
    }

    return {
        id: test.id || `${setId}-T${idx}`,
        name: test.name || test.prompt || `Test ${idx + 1}`,
        prompt: test.prompt,
        expectedActivations: Array.isArray(test.expectedActivations) ? test.expectedActivations : [],
        expectedResponse: test.expectedResponse
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

  replaceAllTestSets: async (sets: TestSet[]): Promise<void> => {
      // 1. Get existing sets
      const existingIds = await redisService.request(['SMEMBERS', KEYS.TEST_SETS]);
      // 2. Delete existing
      if (Array.isArray(existingIds) && existingIds.length > 0) {
          for (const id of existingIds) {
              await testService.deleteTestSet(id);
          }
      }
      // 3. Create new
      for (const set of sets) {
          await testService.createOrUpdateTestSet(set);
      }
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

  getTestRun: async (id: string, excludeResults: boolean = false): Promise<TestRun | null> => {
      const data = await redisService.request(['GET', `${KEYS.TEST_RUN_PREFIX}${id}`]);
      if (!data) return null;
      
      const run: TestRun = JSON.parse(data);
      
      if (excludeResults) {
          run.results = [];
          return run;
      }

      // Hydrate results from individual keys
      const resultKeys = await redisService.request(['KEYS', `${KEYS.RESULT_PREFIX}${id}:*`]);
      if (resultKeys && resultKeys.length > 0) {
          const resultsRaw = await Promise.all(resultKeys.map((k: string) => redisService.request(['GET', k])));
          run.results = resultsRaw
            .filter(r => r !== null)
            .map(r => JSON.parse(r))
            .sort((a, b) => {
                const aIdx = parseInt(a.id.split('-T').pop() || '0');
                const bIdx = parseInt(b.id.split('-T').pop() || '0');
                return aIdx - bIdx;
            });
      } else {
          run.results = [];
      }

      return run;
  },

  getTestRunResults: async (runId: string, limit: number = 50, offset: number = 0, status?: string): Promise<{ results: TestResult[], total: number }> => {
      const resultKeys = await redisService.request(['KEYS', `${KEYS.RESULT_PREFIX}${runId}:*`]);
      if (!resultKeys || resultKeys.length === 0) return { results: [], total: 0 };

      // KEYS output is not naturally sorted.
      const sortedKeys = (resultKeys as string[]).sort((a: string, b: string) => {
          const aIdx = parseInt(a.split('-T').pop() || '0');
          const bIdx = parseInt(b.split('-T').pop() || '0');
          return aIdx - bIdx;
      });

      let filteredKeys = sortedKeys;
      
      // If status is provided, we MUST fetch all results first to filter them, OR we fetch them in batches.
      // Since result objects are individual keys, we can't easily filter by status without GETing them.
      // However, for pagination to work correctly with filtering, we need to know which keys match.
      
      const allResultsRaw = await Promise.all(sortedKeys.map((k: string) => redisService.request(['GET', k])));
      const allResults = allResultsRaw
        .filter(r => r !== null)
        .map(r => JSON.parse(r) as TestResult);

      let results = allResults;
      if (status && status !== 'all') {
          if (status === 'passed') results = allResults.filter(r => r.status === 'completed' && r.responseMatch !== false);
          else if (status === 'failed') results = allResults.filter(r => r.status === 'failed' || r.responseMatch === false);
          else if (status === 'completed') results = allResults.filter(r => r.status === 'completed' || r.status === 'failed');
      }

      const total = results.length;
      const pagedResults = results.slice(offset, offset + limit);

      return { results: pagedResults, total };
  },

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
          summary: {
              total: testSet.tests.length,
              completed: 0,
              passed: 0,
              failed: 0
          },
          results: []
      };

      // Save Initial State (Metadata only)
      await redisService.request(['SADD', KEYS.TEST_RUNS, runId]);
      await testService.updateRunState(newRun);

      // Pre-initialize result keys as pending
      const initPromises = testSet.tests.map((test, idx) => {
          const result: TestResult = {
              id: `${runId}-T${idx}`,
              name: test.name,
              prompt: test.prompt,
              expectedActivations: test.expectedActivations,
              expectedResponse: test.expectedResponse,
              compareWithBaseModel,
              status: 'pending'
          };
          return redisService.request(['SET', `${KEYS.RESULT_PREFIX}${runId}:${result.id}`, JSON.stringify(result), 'EX', '604800']);
      });
      await Promise.all(initPromises);

      loggerService.info(`Test Run Started: ${runId}`);

      // Background Worker
      (async () => {
          const limit = pLimit(15);
          const tasks = testSet.tests.map((test, i) => {
              return limit(async () => {
                  const resultId = `${runId}-T${i}`;
                  
                  // Status check
                  const currentRun = await testService.getTestRun(runId, true);
                  if (currentRun && (currentRun.status === 'stopped' || currentRun.status === 'cancelled')) return;

                  const testCase: TestResult = {
                      id: resultId,
                      name: test.name,
                      prompt: test.prompt,
                      expectedActivations: test.expectedActivations,
                      expectedResponse: test.expectedResponse,
                      compareWithBaseModel,
                      status: 'running'
                  };
                  
                  await testService.updateTestCaseState(runId, resultId, { status: 'running' });

                  try {
                      const result = await runTestFn(test.prompt, compareWithBaseModel);
                      
                      // Process Result
                      const sessionId = result.meta?.contextSessionId;
                      let traces: TraceData[] = [];
                      let traceIds: string[] = [];

                      if (sessionId) {
                          traces = await traceService.getBySession(sessionId);
                          traceIds = traces.map(t => t.id);
                      }

                      const activatedIds = new Set<string>();
                      traces.forEach(trace => {
                          trace.activation_path?.forEach(step => activatedIds.add(step.symbol_id));
                          if (trace.entry_node) activatedIds.add(trace.entry_node);
                          if (trace.output_node) activatedIds.add(trace.output_node);
                      });

                      const missingActivations = (test.expectedActivations || []).filter(id => !activatedIds.has(id));

                      testCase.signalZeroResponse = result.text;
                      testCase.meta = result.meta;
                      testCase.traceIds = traceIds;
                      testCase.activationCheckPassed = missingActivations.length === 0;
                      testCase.missingActivations = missingActivations;

                      if (test.expectedResponse) {
                          const evalResult = await evaluateSemanticMatch(test.prompt, result.text || '', test.expectedResponse);
                          testCase.responseMatch = evalResult.match;
                          testCase.responseMatchReasoning = evalResult.reason;
                      }

                      if (compareWithBaseModel) {
                          testCase.baselineResponse = await runBaselineTest(test.prompt);
                          if (test.expectedResponse) {
                              const baseEvalResult = await evaluateSemanticMatch(test.prompt, testCase.baselineResponse || '', test.expectedResponse);
                              testCase.baselineResponseMatch = baseEvalResult.match;
                              testCase.baselineResponseMatchReasoning = baseEvalResult.reason;
                          }
                          testCase.evaluation = await evaluateComparison(test.prompt, result.text || '', testCase.baselineResponse || '');
                      }

                      let passed = !result.error;
                      if ((test.expectedActivations?.length ?? 0) > 0 && missingActivations.length > 0) passed = false;
                      if (test.expectedResponse && !testCase.responseMatch) passed = false;
                      
                      testCase.status = passed ? 'completed' : 'failed';
                      if (result.error) testCase.error = result.error;

                  } catch (err) {
                      testCase.status = 'failed';
                      testCase.error = String(err);
                  }

                  await testService.updateRunProgress(runId, testCase);
              });
          });

          try {
              await Promise.all(tasks);
              const finalRun = await testService.getTestRun(runId);
              if (finalRun && finalRun.status === 'running') {
                  finalRun.status = 'completed';
                  finalRun.endTime = new Date().toISOString();
                  await testService.updateRunState(finalRun);
              }
          } catch (fatal) {
              loggerService.error("Test Worker Fatal Error", { runId, fatal });
          }
      })();

      return newRun;
  },

  updateRunState: async (run: TestRun) => {
      const { results, ...meta } = run;
      await redisService.request(['SET', `${KEYS.TEST_RUN_PREFIX}${run.id}`, JSON.stringify(meta)]);
  },

  updateTestCaseState: async (runId: string, testCaseId: string, updates: Partial<TestResult>) => {
      const key = `${KEYS.RESULT_PREFIX}${runId}:${testCaseId}`;
      const data = await redisService.request(['GET', key]);
      if (data) {
          const current = JSON.parse(data);
          await redisService.request(['SET', key, JSON.stringify({ ...current, ...updates }), 'EX', '604800']);
      }
  },

  updateRunProgress: async (runId: string, testCase: TestResult) => {
      const resultKey = `${KEYS.RESULT_PREFIX}${runId}:${testCase.id}`;
      const summaryKey = `sz:test_run_summary:${runId}`;

      // 1. Fetch the OLD state to calculate deltas
      const oldRaw = await redisService.request(['GET', resultKey]);
      const oldResult: TestResult | null = oldRaw ? JSON.parse(oldRaw) : null;

      // 2. Save individual result (Atomic)
      await redisService.request(['SET', resultKey, JSON.stringify(testCase), 'EX', '604800']);

      // 3. Apply atomic deltas to counters
      // Terminal states are 'completed' and 'failed'.
      const wasTerminal = oldResult && (oldResult.status === 'completed' || oldResult.status === 'failed');
      const isTerminal = testCase.status === 'completed' || testCase.status === 'failed';

      if (!wasTerminal && isTerminal) {
          // Newly completed
          await redisService.request(['HINCRBY', summaryKey, 'completed', '1']);
          if (testCase.status === 'completed') await redisService.request(['HINCRBY', summaryKey, 'passed', '1']);
          else await redisService.request(['HINCRBY', summaryKey, 'failed', '1']);
      } else if (wasTerminal && isTerminal) {
          // Transition between terminal states (Rerun correction)
          if (oldResult!.status === 'failed' && testCase.status === 'completed') {
              await redisService.request(['HINCRBY', summaryKey, 'failed', '-1']);
              await redisService.request(['HINCRBY', summaryKey, 'passed', '1']);
          } else if (oldResult!.status === 'completed' && testCase.status === 'failed') {
              await redisService.request(['HINCRBY', summaryKey, 'passed', '-1']);
              await redisService.request(['HINCRBY', summaryKey, 'failed', '1']);
          }
          // if failed -> failed or passed -> passed, no summary delta needed
      }

      await redisService.request(['EXPIRE', summaryKey, '604800']);

      // 4. Update metadata key for UI polling
      const data = await redisService.request(['GET', `${KEYS.TEST_RUN_PREFIX}${runId}`]);
      if (data) {
          const run: TestRun = JSON.parse(data);
          const summaryRaw = await redisService.request(['HGETALL', summaryKey]);
          
          let summary: any = {};
          if (Array.isArray(summaryRaw)) {
              for (let i = 0; i < (summaryRaw as string[]).length; i += 2) {
                  summary[summaryRaw[i]] = parseInt(summaryRaw[i+1], 10);
              }
          } else if (summaryRaw && typeof summaryRaw === 'object') {
              summary = summaryRaw;
          }

          run.summary = {
              total: run.summary?.total || 0,
              completed: parseInt(summary.completed || 0, 10),
              passed: parseInt(summary.passed || 0, 10),
              failed: parseInt(summary.failed || 0, 10)
          };
          
          await testService.updateRunState(run);
      }
  },

  stopTestRun: async (runId: string): Promise<void> => {
      const run = await testService.getTestRun(runId, true);
      if (run && run.status === 'running') {
          run.status = 'stopped';
          await testService.updateRunState(run);
          loggerService.info(`Test Run Stopped: ${runId}`);
      }
  },

  resumeTestRun: async (
      runId: string,
      runTestFn: (prompt: string, compareWithBaseModel?: boolean) => Promise<{ text: string, meta: any, error?: string }>
  ): Promise<TestRun> => {
      const run = await testService.getTestRun(runId);
      if (!run) throw new Error("Test run not found");

      if (run.status === 'completed') return run;

      run.status = 'running';
      await testService.updateRunState(run);

      // Same logic as startTestRun but only for pending/failed
      (async () => {
          const limit = pLimit(15);
          const tasks = (run.results || []).map((testCase) => {
              if (testCase.status === 'completed') return Promise.resolve();
              
              return limit(async () => {
                  const currentRun = await testService.getTestRun(runId, true);
                  if (currentRun && (currentRun.status === 'stopped' || currentRun.status === 'cancelled')) return;

                  testCase.status = 'running';
                  await testService.updateTestCaseState(runId, testCase.id, { status: 'running' });

                  try {
                      const result = await runTestFn(testCase.prompt, run.compareWithBaseModel);
                      
                      const sessionId = result.meta?.contextSessionId;
                      let traces: TraceData[] = [];
                      let traceIds: string[] = [];
                      if (sessionId) {
                          traces = await traceService.getBySession(sessionId);
                          traceIds = traces.map(t => t.id);
                      }

                      const activatedIds = new Set<string>();
                      traces.forEach(t => {
                          t.activation_path?.forEach(s => activatedIds.add(s.symbol_id));
                          if (t.entry_node) activatedIds.add(t.entry_node);
                          if (t.output_node) activatedIds.add(t.output_node);
                      });

                      const missing = (testCase.expectedActivations || []).filter(id => !activatedIds.has(id));
                      
                      testCase.signalZeroResponse = result.text;
                      testCase.meta = result.meta;
                      testCase.traceIds = traceIds;
                      testCase.activationCheckPassed = missing.length === 0;
                      testCase.missingActivations = missing;

                      if (testCase.expectedResponse) {
                          const evalRes = await evaluateSemanticMatch(testCase.prompt, result.text || '', testCase.expectedResponse);
                          testCase.responseMatch = evalRes.match;
                          testCase.responseMatchReasoning = evalRes.reason;
                      }

                      if (run.compareWithBaseModel) {
                          testCase.baselineResponse = await runBaselineTest(testCase.prompt);
                          if (testCase.expectedResponse) {
                              const baseEval = await evaluateSemanticMatch(testCase.prompt, testCase.baselineResponse || '', testCase.expectedResponse);
                              testCase.baselineResponseMatch = baseEval.match;
                              testCase.baselineResponseMatchReasoning = baseEval.reason;
                          }
                          testCase.evaluation = await evaluateComparison(testCase.prompt, result.text || '', testCase.baselineResponse || '');
                      }

                      let passed = !result.error;
                      if ((testCase.expectedActivations?.length ?? 0) > 0 && missing.length > 0) passed = false;
                      if (testCase.expectedResponse && !testCase.responseMatch) passed = false;
                      testCase.status = passed ? 'completed' : 'failed';

                  } catch (err) {
                      testCase.status = 'failed';
                      testCase.error = String(err);
                  }

                  await testService.updateRunProgress(runId, testCase);
              });
          });

          await Promise.all(tasks);
          const finalRun = await testService.getTestRun(runId, true);
          if (finalRun && finalRun.status === 'running') {
              finalRun.status = 'completed';
              finalRun.endTime = new Date().toISOString();
              await testService.updateRunState(finalRun);
          }
      })();

      return run;
  },

  rerunTestCase: async (
      runId: string,
      testCaseId: string,
      runTestFn: (prompt: string, compareWithBaseModel?: boolean) => Promise<{ text: string, meta: any, error?: string }>
  ): Promise<TestResult | null> => {
      const run = await testService.getTestRun(runId);
      if (!run) throw new Error("Test run not found");

      const testCase = (run.results || []).find(r => r.id === testCaseId);
      if (!testCase) throw new Error("Test case not found");

      testCase.status = 'running';
      testCase.error = undefined;
      testCase.signalZeroResponse = undefined;
      await testService.updateTestCaseState(runId, testCaseId, { status: 'running' });

      try {
          const result = await runTestFn(testCase.prompt, run.compareWithBaseModel);
          const sessionId = result.meta?.contextSessionId;
          let traces: TraceData[] = [];
          if (sessionId) traces = await traceService.getBySession(sessionId);

          const activatedIds = new Set<string>();
          traces.forEach(t => {
              t.activation_path?.forEach(s => activatedIds.add(s.symbol_id));
              if (t.entry_node) activatedIds.add(t.entry_node);
              if (t.output_node) activatedIds.add(t.output_node);
          });

          const missing = (testCase.expectedActivations || []).filter(id => !activatedIds.has(id));
          
          testCase.signalZeroResponse = result.text;
          testCase.meta = result.meta;
          testCase.traceIds = traces.map(t => t.id);
          testCase.activationCheckPassed = missing.length === 0;
          testCase.missingActivations = missing;

          if (testCase.expectedResponse) {
              const evalRes = await evaluateSemanticMatch(testCase.prompt, result.text || '', testCase.expectedResponse);
              testCase.responseMatch = evalRes.match;
              testCase.responseMatchReasoning = evalRes.reason;
          }

          if (run.compareWithBaseModel) {
              testCase.baselineResponse = await runBaselineTest(testCase.prompt);
              if (testCase.expectedResponse) {
                  const baseEval = await evaluateSemanticMatch(testCase.prompt, testCase.baselineResponse || '', testCase.expectedResponse);
                  testCase.baselineResponseMatch = baseEval.match;
                  testCase.baselineResponseMatchReasoning = baseEval.reason;
              }
              testCase.evaluation = await evaluateComparison(testCase.prompt, result.text || '', testCase.baselineResponse || '');
          }

          let passed = !result.error;
          if ((testCase.expectedActivations?.length ?? 0) > 0 && missing.length > 0) passed = false;
          if (testCase.expectedResponse && !testCase.responseMatch) passed = false;
          testCase.status = passed ? 'completed' : 'failed';

      } catch (err) {
          testCase.status = 'failed';
          testCase.error = String(err);
      }

      await testService.updateRunProgress(runId, testCase);
      return testCase;
  },

  deleteTestRun: async (runId: string): Promise<void> => {
      await redisService.request(['SREM', KEYS.TEST_RUNS, runId]);
      await redisService.request(['DEL', `${KEYS.TEST_RUN_PREFIX}${runId}`]);
      const resultKeys = await redisService.request(['KEYS', `${KEYS.RESULT_PREFIX}${runId}:*`]);
      if (resultKeys.length > 0) {
          await redisService.request(['DEL', ...resultKeys]);
      }
      loggerService.info(`Test Run Deleted: ${runId}`);
  },

  // --- Legacy Support ---

  getTests: async (): Promise<TestCase[]> => {
    const sets = await testService.listTestSets();
    const defaultSet = sets.find(s => s.id === 'default') || sets[0];
    return defaultSet ? defaultSet.tests : DEFAULT_TESTS;
  },

  addTest: async (testSetId: string, prompt: string, expectedActivations: string[], name?: string, expectedResponse?: string): Promise<void> => {
     const set = await testService.getTestSet(testSetId);
     if (!set) throw new Error("Test set not found");
     const newTest = normalizeTestCase({ id: `${testSetId}-T${set.tests.length}`, name: name || prompt, prompt, expectedActivations, expectedResponse }, set.tests.length, testSetId);
     set.tests.push(newTest);
     await testService.createOrUpdateTestSet(set);
  },

  deleteTest: async (testSetId: string, testId: string): Promise<void> => {
      const set = await testService.getTestSet(testSetId);
      if (!set) throw new Error("Test set not found");
      set.tests = set.tests.filter(test => test.id !== testId);
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
      await testService.setTests([]);
  },

  cleanupActiveRuns: async (): Promise<number> => {
      const ids = await redisService.request(['SMEMBERS', KEYS.TEST_RUNS]);
      if (!ids || !Array.isArray(ids)) return 0;

      let cleanedCount = 0;
      for (const id of ids) {
          const run = await testService.getTestRun(id, true);
          if (run && run.status === 'running') {
              run.status = 'stopped'; // Set to stopped so user can resume
              await testService.updateRunState(run);
              cleanedCount++;
          }
      }
      return cleanedCount;
  }
};