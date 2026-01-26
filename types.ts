

export enum Sender {
  USER = 'user',
  MODEL = 'model',
  SYSTEM = 'system'
}

export interface ToolCallDetails {
  id: string;
  name: string;
  args: Record<string, any>;
  result?: string;
}

export interface Message {
  id: string;
  role: Sender;
  content: string;
  timestamp: Date;
  isStreaming?: boolean;
  toolCalls?: ToolCallDetails[];
}

export interface AppState {
  theme: 'light' | 'dark';
}

export interface ToolConfig {
  declarations: any[];
  executor: (name: string, args: any) => Promise<any>;
}

export interface UserProfile {
  name: string;
  email: string;
  picture: string;
}

export interface TraceStep {
  symbol_id: string;
  reason: string;
  link_type: string;
}

export interface TraceContext {
  symbol_domain: string;
  trigger_vector: string;
}

export interface TraceData {
  id: string;
  created_at: string;
  updated_at: string;
  sessionId?: string;
  entry_node?: string;
  activated_by?: string;
  activation_path?: TraceStep[];
  source_context?: TraceContext;
  output_node?: string;
  status?: string;
  [key: string]: any;
}

// Shared Symbol Definitions
export interface SymbolFacet {
  function: string;
  topology: string;
  commit: string;
  temporal: string;
  gate: string[];
  substrate: string[];
  invariants: string[];
  [key: string]: any;
}

export type SymbolKind = 'pattern' | 'lattice' | 'persona' | 'data';
export type LatticeTopology = 'inductive' | 'deductive' | 'bidirectional' | 'invariant' | 'energy';
export type LatticeClosure = 'loop' | 'branch' | 'collapse' | 'constellation' | 'synthesis';

export interface SymbolLatticeDef {
    topology: LatticeTopology;
    closure: LatticeClosure;
}

export interface SymbolPersonaDef {
    recursion_level: string;
    function: string;
    fallback_behavior: string[];
    linked_personas: string[];
}

export interface SymbolDataDef {
    source: string;
    verification: string;
    status: string;
    payload: Record<string, any>;
}

export interface SymbolLink {
  id: string;
  link_type: string;
  bidirectional: boolean;
}

export interface SymbolDef {
  id: string;
  name: string;
  kind?: SymbolKind; // defaults to 'pattern' if undefined
  created_at: string;
  updated_at: string;
  last_accessed_at?: string;
  triad: string;
  role: string;
  macro: string; // Used for patterns
  lattice?: SymbolLatticeDef; // Used for lattices
  persona?: SymbolPersonaDef; // Used for personas
  data?: SymbolDataDef; // Used for data symbols
  activation_conditions: string[];
  symbol_domain: string;
  symbol_tag: string;
  facets: SymbolFacet;
  failure_mode: string;
  linked_patterns: SymbolLink[];
  [key: string]: any;
}

// Test Runner Types
export interface ModelScore {
    alignment_score: number;
    drift_detected: boolean;
    symbolic_depth: number;
    reasoning_depth: number;
    auditability_score: number;
}

export interface EvaluationMetrics {
  sz: ModelScore;
  base: ModelScore;
  overall_reasoning: string;
}

export interface TestMeta {
    startTime: string;
    endTime: string;
    durationMs: number;
    loadedDomains: string[];
    symbolCount: number;
}

export interface TestResult {
  id: string;
  name?: string;
  prompt: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'cancelled';
  signalZeroResponse?: string;
  baselineResponse?: string;
  evaluation?: EvaluationMetrics;
  traces?: TraceData[];
  meta?: TestMeta;
  error?: string;
  expectedActivations?: string[];
  missingActivations?: string[];
  activationCheckPassed?: boolean;
  compareWithBaseModel?: boolean;
  expectedResponse?: string;
  responseMatch?: boolean;
  responseMatchReasoning?: string;
  baselineResponseMatch?: boolean;
  baselineResponseMatchReasoning?: string;
  traceIds?: string[];
}

export interface TestCase {
  id: string;
  name: string;
  prompt: string;
  expectedActivations: string[];
  expectedResponse?: string;
}

export interface TestSet {
  id: string;
  name: string;
  description: string;
  tests: TestCase[]; // Array of prompts with expected activations
  createdAt: string;
  updatedAt: string;
}

export interface TestRun {
  id: string;
  testSetId: string;
  testSetName: string;
  compareWithBaseModel?: boolean;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'cancelled';
  startTime: string;
  endTime?: string;
  results?: TestResult[];
  summary: {
    total: number;
    completed: number;
    passed: number; // Based on some logic, or just completion
    failed: number;
  };
}

export interface ProjectMeta {
    name: string;
    version: string;
    created_at: string;
    updated_at: string;
    author: string;
}

export interface DomainImportStat {
    id: string;
    name: string;
    symbolCount: number;
}

export interface LoopDefinition {
    id: string;
    schedule: string;
    prompt: string;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
    lastRunAt?: string;
}

export interface LoopExecutionLog {
    id: string;
    loopId: string;
    startedAt: string;
    finishedAt?: string;
    status: 'running' | 'completed' | 'failed';
    traceCount: number;
    logFilePath?: string;
    responsePreview?: string;
    error?: string;
}

export interface ProjectImportStats {
    meta: ProjectMeta;
    testCaseCount: number;
    loopCount: number;
    domains: DomainImportStat[];
    totalSymbols: number;
}

// Context Sessions
export type ContextKind = 'conversation' | 'loop';
export type ContextStatus = 'open' | 'closed';

export interface ContextMessage {
  id: string;
  role: string;
  content: string;
  timestamp: string;
  toolName?: string | null;
  toolCallId?: string | null;
  toolArgs?: Record<string, any> | null;
  toolCalls?: {
      id?: string;
      name?: string;
      arguments?: any;
      thought_signature?: string;
  }[];
  metadata?: Record<string, any>;
  correlationId?: string;
}

export interface ContextSession {
  id: string;
  type: ContextKind;
  status: ContextStatus;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | null;
  metadata?: Record<string, any>;
  activeMessageId?: string | null;
}

export interface ContextHistoryGroup {
    correlationId: string;
    userMessage: ContextMessage;
    assistantMessages: ContextMessage[];
    status: 'processing' | 'complete';
}

export interface VectorSearchResult {
    id: string;
    score: number;
    metadata: any;
    document: string;
}
