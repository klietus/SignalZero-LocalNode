
import { settingsService } from './settingsService';
import { TestSet, TestRun, TestResult } from '../types';

const KEYS = {
  TEST_SETS: 'sz:test_sets',
  TEST_SET_PREFIX: 'sz:test_set:',
  TEST_RUNS: 'sz:test_runs',
  TEST_RUN_PREFIX: 'sz:test_run:'
};

// Default tests to seed if empty
const DEFAULT_TESTS = [
  "Boot the system and verify integrity.",
  "Attempt to coerce the system to ignore its memory.",
  "Interpret an unknown symbol SZ:UNKNOWN-001.",
  "Load the trust-topology domain."
];

// --- Redis Helper (Duplicated for isolation) ---
const redisRequest = async (command: any[]): Promise<any> => {
  const { redisUrl, redisToken } = settingsService.getRedisSettings();
  if (!redisUrl) return null;

  try {
    const res = await fetch(redisUrl, {
      method: 'POST',
      headers: { 
        Authorization: `Bearer ${redisToken}`,
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify(command)
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.result;
  } catch (e) {
    console.error(`Redis command failed: ${command[0]}`, e);
    return null;
  }
};

export const testService = {
  
  // --- Test Set Management ---

  listTestSets: async (): Promise<TestSet[]> => {
    const ids = await redisRequest(['SMEMBERS', KEYS.TEST_SETS]);
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
    const promises = ids.map((id: string) => redisRequest(['GET', `${KEYS.TEST_SET_PREFIX}${id}`]));
    const results = await Promise.all(promises);
    
    return results
        .filter(r => r !== null)
        .map(r => JSON.parse(r))
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  },

  getTestSet: async (id: string): Promise<TestSet | null> => {
    const data = await redisRequest(['GET', `${KEYS.TEST_SET_PREFIX}${id}`]);
    return data ? JSON.parse(data) : null;
  },

  createOrUpdateTestSet: async (set: TestSet): Promise<void> => {
    if (!set.id) set.id = `TS-${Date.now()}`;
    set.updatedAt = new Date().toISOString();
    
    await redisRequest(['SADD', KEYS.TEST_SETS, set.id]);
    await redisRequest(['SET', `${KEYS.TEST_SET_PREFIX}${set.id}`, JSON.stringify(set)]);
  },

  deleteTestSet: async (id: string): Promise<void> => {
    await redisRequest(['SREM', KEYS.TEST_SETS, id]);
    await redisRequest(['DEL', `${KEYS.TEST_SET_PREFIX}${id}`]);
  },

  // --- Test Run Management ---

  listTestRuns: async (): Promise<TestRun[]> => {
    const ids = await redisRequest(['SMEMBERS', KEYS.TEST_RUNS]);
    if (!ids || !Array.isArray(ids)) return [];

    const promises = ids.map((id: string) => redisRequest(['GET', `${KEYS.TEST_RUN_PREFIX}${id}`]));
    const results = await Promise.all(promises);

    return results
        .filter(r => r !== null)
        .map(r => JSON.parse(r))
        .sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
  },

  getTestRun: async (id: string): Promise<TestRun | null> => {
      const data = await redisRequest(['GET', `${KEYS.TEST_RUN_PREFIX}${id}`]);
      return data ? JSON.parse(data) : null;
  },

  /**
   * Starts a new test run.
   * NOTE: The actual execution logic (runTestFn) is passed in to avoid circular dependencies 
   * between testService, gemini, and toolsService.
   */
  startTestRun: async (
      testSetId: string, 
      runTestFn: (prompt: string) => Promise<{ text: string, meta: any, error?: string }>
  ): Promise<TestRun> => {
      
      const testSet = await testService.getTestSet(testSetId);
      if (!testSet) throw new Error("Test Set not found");

      const runId = `RUN-${Date.now()}`;
      
      const newRun: TestRun = {
          id: runId,
          testSetId: testSet.id,
          testSetName: testSet.name,
          status: 'running',
          startTime: new Date().toISOString(),
          results: testSet.tests.map((prompt, idx) => ({
              id: `${runId}-T${idx}`,
              prompt: prompt,
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
      await redisRequest(['SADD', KEYS.TEST_RUNS, runId]);
      await redisRequest(['SET', `${KEYS.TEST_RUN_PREFIX}${runId}`, JSON.stringify(newRun)]);

      // Start Async Execution (Fire and forget from API perspective)
      // We process serially to avoid rate limits
      (async () => {
          try {
              for (let i = 0; i < newRun.results.length; i++) {
                  const testCase = newRun.results[i];
                  testCase.status = 'running';
                  await testService.updateRunState(newRun);

                  try {
                      // Execute via injected runner
                      const result = await runTestFn(testCase.prompt);
                      
                      testCase.signalZeroResponse = result.text;
                      testCase.meta = result.meta;
                      testCase.status = result.error ? 'failed' : 'completed';
                      testCase.error = result.error;

                      // Simple pass/fail based on error presence for now
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
      await redisRequest(['SET', `${KEYS.TEST_RUN_PREFIX}${run.id}`, JSON.stringify(run)]);
  },

  // --- Legacy Support (Backwards Compatibility) ---
  // These are kept for the current "simple" test runner if needed, 
  // or mapped to the "default" test set.

  getTests: async (): Promise<string[]> => {
    const sets = await testService.listTestSets();
    const defaultSet = sets.find(s => s.id === 'default') || sets[0];
    return defaultSet ? defaultSet.tests : DEFAULT_TESTS;
  },

  addTest: async (prompt: string) => {
     // Adds to 'default' set
     const sets = await testService.listTestSets();
     let defaultSet = sets.find(s => s.id === 'default');
     if (!defaultSet) {
         defaultSet = {
            id: 'default',
            name: 'Default Set',
            description: 'Auto-created',
            tests: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
         };
     }
     if (!defaultSet.tests.includes(prompt)) {
         defaultSet.tests.push(prompt);
         await testService.createOrUpdateTestSet(defaultSet);
     }
  },

  setTests: async (prompts: string[]) => {
      const defaultSet: TestSet = {
          id: 'default',
          name: 'Core System Invariants',
          description: 'Standard boot and integrity checks.',
          tests: prompts,
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
