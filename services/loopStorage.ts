export const LOOP_INDEX_KEY = 'sz:loops:index';
export const EXECUTION_ZSET_KEY = 'sz:loops:executions';

export const getLoopKey = (loopId: string) => `sz:loops:def:${loopId}`;
export const getExecutionKey = (executionId: string) => `sz:loops:execution:${executionId}`;
export const getTraceKey = (executionId: string) => `${getExecutionKey(executionId)}:traces`;
