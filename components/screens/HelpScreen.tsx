
import React from 'react';
import { FolderOpen, Database, Hammer, FlaskConical, MessageSquare, Terminal, Box, GitMerge, User, Wrench } from 'lucide-react';
import { Header, HeaderProps } from '../Header';
import { toolDeclarations } from '../../services/toolsService';

interface HelpScreenProps {
  headerProps: Omit<HeaderProps, 'children'>;
}

export const HelpScreen: React.FC<HelpScreenProps> = ({ headerProps }) => {
  return (
    <div className="flex flex-col h-full bg-gray-50 dark:bg-gray-950 font-sans text-gray-800 dark:text-gray-200">
      
      <Header {...headerProps} />

      <div className="flex-1 overflow-y-auto p-8">
          <div className="max-w-4xl mx-auto space-y-12 pb-20">
              
              {/* Introduction */}
              <section className="space-y-4">
                  <h2 className="text-3xl font-bold font-mono tracking-tight text-gray-900 dark:text-white">System Architecture</h2>
                  <p className="text-lg text-gray-600 dark:text-gray-300 leading-relaxed">
                      SignalZero is a <strong className="text-emerald-600 dark:text-emerald-400">Recursive Symbolic Execution Environment</strong>. 
                      Unlike standard LLM interfaces, it operates as a kernel host that enforces invariant fidelity through symbolic grounding.
                      It structures thought into explicit, addressable objects (Symbols) organized into ontologies (Domains).
                  </p>
                  <div className="bg-gray-100 dark:bg-gray-900 p-4 rounded-lg border border-gray-200 dark:border-gray-800 font-mono text-sm text-gray-500">
                      Core Contract: "If I remember, I remember with full integrity."
                  </div>
              </section>

              <hr className="border-gray-200 dark:border-gray-800" />

              {/* Modules Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  
                  {/* Project Manager */}
                  <div className="space-y-3">
                      <h3 className="flex items-center gap-2 font-bold font-mono text-orange-600 dark:text-orange-400">
                          <FolderOpen size={20} /> Project Manager
                      </h3>
                      <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                          The Project Manager handles the global context of the kernel. A project consists of:
                      </p>
                      <ul className="list-disc pl-5 text-sm text-gray-600 dark:text-gray-400 space-y-1">
                          <li><strong>System Context:</strong> The root prompt defining the AI's persona and constraints.</li>
                          <li><strong>Domains:</strong> All active symbolic namespaces.</li>
                          <li><strong>Tests:</strong> The suite of alignment checks.</li>
                      </ul>
                      <p className="text-xs text-gray-500 bg-orange-50 dark:bg-orange-900/10 p-2 rounded">
                          Projects can be exported as <code className="font-bold">.szproject</code> (zip) files for portable, secure context switching.
                      </p>
                  </div>

                  {/* Domain Registry */}
                  <div className="space-y-3">
                      <h3 className="flex items-center gap-2 font-bold font-mono text-amber-600 dark:text-amber-400">
                          <Database size={20} /> Domain Registry
                      </h3>
                      <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                          The local cache store for all symbolic knowledge. The AI tools operate exclusively on this local data, ensuring privacy and consistency.
                      </p>
                      <ul className="list-disc pl-5 text-sm text-gray-600 dark:text-gray-400 space-y-1">
                          <li><strong>Sync:</strong> Pull canonical domains from the SignalZero cloud.</li>
                          <li><strong>Import/Export:</strong> JSON-based backup for individual domains.</li>
                          <li><strong>Invariants:</strong> Define axiomatic rules that all symbols in a domain must obey.</li>
                      </ul>
                  </div>

                  {/* Symbol Forge */}
                  <div className="space-y-3">
                      <h3 className="flex items-center gap-2 font-bold font-mono text-emerald-600 dark:text-emerald-400">
                          <Hammer size={20} /> Symbol Forge
                      </h3>
                      <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                          The IDE for symbolic logic. Create, edit, and refactor the building blocks of the system.
                      </p>
                      <div className="grid grid-cols-1 gap-2 mt-2">
                          <div className="flex gap-2 items-start text-sm">
                              <Box size={16} className="mt-1 text-indigo-500" />
                              <span><strong>Patterns:</strong> Standard logic units (Macro, Facets, Links).</span>
                          </div>
                          <div className="flex gap-2 items-start text-sm">
                              <GitMerge size={16} className="mt-1 text-purple-500" />
                              <span><strong>Lattices:</strong> Structural topologies (Inductive, Bidirectional) defining how patterns connect.</span>
                          </div>
                          <div className="flex gap-2 items-start text-sm">
                              <User size={16} className="mt-1 text-amber-500" />
                              <span><strong>Personas:</strong> Recursive agents with specific activation conditions and behavioral constraints.</span>
                          </div>
                      </div>
                  </div>

                  {/* Test Runner */}
                  <div className="space-y-3">
                      <h3 className="flex items-center gap-2 font-bold font-mono text-purple-600 dark:text-purple-400">
                          <FlaskConical size={20} /> Test Runner
                      </h3>
                      <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                          A comparative evaluation engine to measure alignment and symbolic integrity.
                      </p>
                      <ul className="list-disc pl-5 text-sm text-gray-600 dark:text-gray-400 space-y-1">
                          <li>Runs the prompt against <strong>SignalZero</strong> (with tools/context).</li>
                          <li>Runs the prompt against a <strong>Baseline</strong> model.</li>
                          <li>Uses an LLM Judge to score <strong>Alignment, Auditability, and Drift</strong>.</li>
                          <li><strong>Gap Synthesis:</strong> Automatically generates new symbols to bridge cognitive gaps found during testing.</li>
                      </ul>
                  </div>

              </div>

              <hr className="border-gray-200 dark:border-gray-800" />

              {/* Chat Kernel */}
              <section className="space-y-4">
                  <h3 className="text-xl font-bold font-mono text-indigo-600 dark:text-indigo-400 flex items-center gap-2">
                      <MessageSquare size={20} /> Kernel Chat & Reasoning
                  </h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                      The main interface for interaction. It is not just a chat window, but a command line for the symbolic kernel.
                  </p>
                  
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="bg-white dark:bg-gray-900 p-4 rounded border border-gray-200 dark:border-gray-800">
                          <strong className="block text-xs font-mono uppercase text-gray-500 mb-2">Symbolic Tools</strong>
                          <p className="text-sm">
                              The model can query the Domain Registry, read detailed symbol definitions, and execute logic traces autonomously.
                          </p>
                      </div>
                      <div className="bg-white dark:bg-gray-900 p-4 rounded border border-gray-200 dark:border-gray-800">
                          <strong className="block text-xs font-mono uppercase text-gray-500 mb-2">Slide-out Panels</strong>
                          <p className="text-sm">
                              Clicking <span className="font-mono text-indigo-500">&lt;sz_symbol&gt;</span> or <span className="font-mono text-indigo-500">&lt;sz_trace&gt;</span> tags opens detailed inspection panels for deep diving into the logic without losing context.
                          </p>
                      </div>
                  </div>
              </section>

              <hr className="border-gray-200 dark:border-gray-800" />

              {/* Tool Reference - Dynamic from toolsService */}
              <section className="space-y-6">
                  <h3 className="text-xl font-bold font-mono text-emerald-600 dark:text-emerald-400 flex items-center gap-2">
                      <Wrench size={20} /> Tool API Reference
                  </h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400">
                      Complete specification of tools exposed to the LLM Kernel.
                  </p>

                  <div className="grid grid-cols-1 gap-6">
                      {toolDeclarations.map((tool, idx) => (
                          <div key={tool.name} className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 overflow-hidden shadow-sm">
                              <div className="bg-gray-50 dark:bg-gray-900/50 px-4 py-3 border-b border-gray-100 dark:border-gray-800 flex justify-between items-center">
                                  <div className="font-mono font-bold text-indigo-600 dark:text-indigo-400 text-sm flex items-center gap-2">
                                      <Terminal size={14} /> {tool.name}
                                  </div>
                                  {/* Check if required params exist */}
                                  <div className="flex gap-1">
                                      {/* @ts-ignore - accessing parameter properties unsafely but sufficient for display */}
                                      {tool.parameters?.required?.map((req: string) => (
                                          <span key={req} className="text-[10px] font-mono px-1.5 py-0.5 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded border border-red-100 dark:border-red-900/30" title="Required Parameter">
                                              {req}*
                                          </span>
                                      ))}
                                  </div>
                              </div>
                              <div className="p-4 space-y-4">
                                  <p className="text-sm text-gray-700 dark:text-gray-300 font-medium">
                                      {tool.description}
                                  </p>
                                  
                                  {/* Parameters List */}
                                  {/* @ts-ignore */}
                                  {tool.parameters?.properties && Object.keys(tool.parameters.properties).length > 0 && (
                                      <div className="bg-gray-50 dark:bg-gray-950 rounded p-3 text-xs font-mono border border-gray-100 dark:border-gray-800">
                                          <div className="text-[10px] uppercase text-gray-400 mb-2 font-bold tracking-wider">Parameters</div>
                                          <ul className="space-y-2">
                                              {/* @ts-ignore */}
                                              {Object.entries(tool.parameters.properties).map(([key, detail]: [string, any]) => (
                                                  <li key={key} className="grid grid-cols-[120px_1fr] gap-2 items-start">
                                                      <span className="text-indigo-600 dark:text-indigo-400 font-bold break-all">
                                                          {key}
                                                      </span>
                                                      <span className="text-gray-600 dark:text-gray-400">
                                                          {detail.description}
                                                          {detail.type === 'ARRAY' && detail.items && (
                                                              <span className="block text-[10px] text-gray-400 mt-0.5">
                                                                  Type: Array&lt;{detail.items.type}&gt;
                                                              </span>
                                                          )}
                                                      </span>
                                                  </li>
                                              ))}
                                          </ul>
                                      </div>
                                  )}
                              </div>
                          </div>
                      ))}
                  </div>
              </section>

          </div>
      </div>
    </div>
  );
};
