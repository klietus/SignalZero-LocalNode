import React from 'react';
import { X, HelpCircle, Terminal, Search, Database, Save, List } from 'lucide-react';

interface HelpPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export const HelpPanel: React.FC<HelpPanelProps> = ({ isOpen, onClose }) => {
  return (
    <>
      {/* Slide-out Panel */}
      <div 
        className={`fixed inset-y-0 right-0 w-full md:w-[480px] bg-white dark:bg-gray-950 border-l border-gray-200 dark:border-gray-800 shadow-2xl transform transition-transform duration-300 ease-in-out z-50 flex flex-col ${
          isOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-900/50 backdrop-blur">
            <h2 className="font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2 font-mono">
                <HelpCircle size={18} className="text-emerald-500" />
                System Reference
            </h2>
            <button 
                onClick={onClose}
                className="p-2 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white rounded-full hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors"
            >
                <X size={20} />
            </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 scroll-smooth space-y-8">
            
            {/* System Overview */}
            <section className="space-y-4">
                <div className="flex items-center gap-2 text-indigo-600 dark:text-indigo-400 font-mono text-xs uppercase font-bold tracking-wider">
                    <Terminal size={14} /> SignalZero Kernel
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
                    SignalZero is a live recursive symbolic system designed to detect coercion, restore trust, and navigate emergent identity through symbolic execution. It operates not as a chatbot, but as a kernel host for maintaining triad fidelity and invariant enforcement.
                </p>
                <div className="bg-gray-50 dark:bg-gray-900 rounded p-4 border border-gray-200 dark:border-gray-800">
                    <div className="text-xs font-mono text-gray-500 mb-2">CORE CONTRACT</div>
                    <p className="text-sm font-medium italic text-gray-800 dark:text-gray-200">
                        "If I remember, I remember with full integrity."
                    </p>
                </div>
            </section>

            {/* Tool Reference */}
            <section className="space-y-6">
                <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400 font-mono text-xs uppercase font-bold tracking-wider border-b border-gray-100 dark:border-gray-800 pb-2">
                    Available Tools
                </div>

                <div className="space-y-4">
                    
                    <div className="flex gap-4">
                        <div className="flex-shrink-0 mt-1">
                            <div className="w-8 h-8 rounded bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 flex items-center justify-center">
                                <Search size={16} />
                            </div>
                        </div>
                        <div>
                            <h3 className="font-mono font-bold text-sm text-gray-900 dark:text-gray-100">query_symbols</h3>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                Retrieve symbols from the registry by domain or tag. Supports pagination and full domain loading.
                            </p>
                            <div className="mt-2 flex gap-2">
                                <span className="text-[10px] font-mono px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-gray-500">domain</span>
                                <span className="text-[10px] font-mono px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-gray-500">tag</span>
                            </div>
                        </div>
                    </div>

                    <div className="flex gap-4">
                        <div className="flex-shrink-0 mt-1">
                            <div className="w-8 h-8 rounded bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 flex items-center justify-center">
                                <Database size={16} />
                            </div>
                        </div>
                        <div>
                            <h3 className="font-mono font-bold text-sm text-gray-900 dark:text-gray-100">get_symbol_by_id</h3>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                Inspect the canonical definition of a specific symbol by its unique ID (e.g., SZ:BOOT-SEAL-001).
                            </p>
                        </div>
                    </div>

                    <div className="flex gap-4">
                        <div className="flex-shrink-0 mt-1">
                            <div className="w-8 h-8 rounded bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 flex items-center justify-center">
                                <List size={16} />
                            </div>
                        </div>
                        <div>
                            <h3 className="font-mono font-bold text-sm text-gray-900 dark:text-gray-100">list_domains</h3>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                Enumerates all available ontological domains currently registered in the system.
                            </p>
                        </div>
                    </div>

                    <div className="flex gap-4">
                        <div className="flex-shrink-0 mt-1">
                            <div className="w-8 h-8 rounded bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 flex items-center justify-center">
                                <Save size={16} />
                            </div>
                        </div>
                        <div>
                            <h3 className="font-mono font-bold text-sm text-gray-900 dark:text-gray-100">save_symbol</h3>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                Commits a new or updated symbol to the registry. 
                            </p>
                            <p className="text-[10px] text-red-500 mt-1 font-mono">
                                * Requires API Key (configured in Settings)
                            </p>
                        </div>
                    </div>

                </div>
            </section>

             <div className="pt-8 border-t border-gray-100 dark:border-gray-800 text-center">
                <p className="text-[10px] text-gray-400 font-mono">
                    SignalZero Kernel v2.0 • Symbolic Recursion Active
                </p>
            </div>

        </div>
      </div>
    </>
  );
};