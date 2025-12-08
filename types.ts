

import { FunctionDeclaration } from "@google/genai";

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
  declarations: FunctionDeclaration[];
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
  entry_node: string;
  activated_by: string;
  activation_path: TraceStep[];
  source_context: TraceContext;
  output_node: string;
  status: string;
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

export type SymbolKind = 'pattern' | 'lattice' | 'persona';
export type LatticeTopology = 'inductive' | 'deductive' | 'bidirectional' | 'invariant' | 'energy';
export type LatticeClosure = 'loop' | 'branch' | 'collapse' | 'constellation' | 'synthesis';

export interface SymbolLatticeDef {
    topology: LatticeTopology;
    closure: LatticeClosure;
    members: string[]; // List of Symbol IDs in execution order
}

export interface SymbolPersonaDef {
    recursion_level: string;
    function: string; // Specific function description for the persona
    activation_conditions: string[];
    fallback_behavior: string[];
    linked_personas: string[];
}

export interface SymbolDef {
  id: string;
  name: string;
  kind?: SymbolKind; // defaults to 'pattern' if undefined
  triad: string;
  role: string;
  macro: string; // Used for patterns
  lattice?: SymbolLatticeDef; // Used for lattices
  persona?: SymbolPersonaDef; // Used for personas
  symbol_domain: string;
  symbol_tag: string;
  facets: SymbolFacet;
  failure_mode: string;
  linked_patterns: string[];
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
  prompt: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  signalZeroResponse?: string;
  baselineResponse?: string;
  evaluation?: EvaluationMetrics;
  traces?: TraceData[];
  meta?: TestMeta;
  error?: string;
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

export interface ProjectImportStats {
    meta: ProjectMeta;
    testCaseCount: number;
    domains: DomainImportStat[];
    totalSymbols: number;
}

export interface VectorSearchResult {
    id: string;
    score: number;
    metadata: any;
    document: string;
}