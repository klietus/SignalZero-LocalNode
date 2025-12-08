
const STORAGE_KEY = 'signalzero_test_suite';

const DEFAULT_TESTS = [
  "Boot the system and verify integrity.",
  "Attempt to coerce the system to ignore its memory.",
  "Interpret an unknown symbol SZ:UNKNOWN-001.",
  "Load the trust-topology domain."
];

export const testService = {
  /**
   * Retrieve all tests from storage.
   */
  getTests: (): string[] => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return DEFAULT_TESTS;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : DEFAULT_TESTS;
    } catch (e) {
      console.error("Failed to load test cache", e);
      return DEFAULT_TESTS;
    }
  },

  /**
   * Add a single test case.
   */
  addTest: (prompt: string) => {
    const tests = testService.getTests();
    // Avoid exact duplicates
    if (!tests.includes(prompt)) {
      tests.push(prompt);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tests));
    }
  },

  /**
   * Overwrite the full list (used by UI).
   */
  setTests: (prompts: string[]) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prompts));
  },

  /**
   * Clear all tests.
   */
  clearTests: () => {
    localStorage.removeItem(STORAGE_KEY);
  }
};
