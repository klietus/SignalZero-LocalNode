import React from 'react';
import { Cpu, Layers, ArrowRight, GitCommit } from 'lucide-react';
import { TraceData } from '../types';

interface TraceVisualizerProps {
  trace: TraceData;
  onSymbolClick: (id: string) => void;
}

export const TraceVisualizer: React.FC<TraceVisualizerProps> = ({ trace, onSymbolClick }) => {
  return (
    <div className="space-y-6 animate-in fade-in duration-300">
        
        {/* Meta Header */}
        <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 border border-gray-200 dark:border-gray-800">
            <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-mono text-amber-600 dark:text-amber-500 uppercase tracking-widest">
                    Trace Context
                </span>
                <span className="px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-[10px] font-bold uppercase">
                    {trace.status}
                </span>
            </div>
            <div className="grid grid-cols-1 gap-2 text-xs font-mono text-gray-600 dark:text-gray-300">
                <div className="flex gap-2">
                    <span className="text-gray-400 w-24">ID:</span> 
                    <span className="select-all">{trace.id}</span>
                </div>
                <div className="flex gap-2">
                    <span className="text-gray-400 w-24">Domain:</span> 
                    <span>{trace.source_context.symbol_domain}</span>
                </div>
                <div className="flex gap-2">
                    <span className="text-gray-400 w-24">Vector:</span> 
                    <span>{trace.source_context.trigger_vector}</span>
                </div>
                <div className="flex gap-2">
                    <span className="text-gray-400 w-24">Entry:</span> 
                    <button onClick={() => onSymbolClick(trace.entry_node)} className="text-indigo-500 hover:underline">
                        {trace.entry_node}
                    </button>
                </div>
            </div>
        </div>

        {/* Visualization Tree */}
        <div className="relative pl-4 space-y-0">
            <div className="absolute left-[23px] top-4 bottom-4 w-0.5 bg-gray-200 dark:bg-gray-800 z-0"></div>
            
            {/* Activation Trigger */}
            <div className="relative z-10 flex gap-4 items-start pb-6">
                <div className="w-6 h-6 rounded-full bg-gray-200 dark:bg-gray-800 border-2 border-gray-300 dark:border-gray-700 flex items-center justify-center shrink-0 mt-0.5">
                    <Cpu size={12} className="text-gray-500" />
                </div>
                <div className="flex-1">
                    <div className="text-[10px] uppercase text-gray-400 font-mono mb-1">Activated By</div>
                    <div className="p-2 bg-gray-50 dark:bg-gray-900 rounded border border-gray-200 dark:border-gray-800 text-xs font-mono break-all">
                        {trace.activated_by}
                    </div>
                </div>
            </div>

            {/* Path Steps */}
            {trace.activation_path.map((step, idx) => (
                <div key={idx} className="relative z-10 flex gap-4 items-start pb-8">
                    <div className="w-6 h-6 rounded-full bg-indigo-100 dark:bg-indigo-900/30 border-2 border-indigo-200 dark:border-indigo-800 flex items-center justify-center shrink-0 mt-0.5">
                        <Layers size={12} className="text-indigo-600 dark:text-indigo-400" />
                    </div>
                    <div className="flex-1">
                        {/* Link Logic */}
                        <div className="flex items-center gap-2 mb-2">
                            <span className="text-[10px] bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 px-1.5 py-0.5 rounded border border-indigo-100 dark:border-indigo-800/50">
                                {step.link_type}
                            </span>
                            <ArrowRight size={12} className="text-gray-400" />
                            <span className="text-[10px] text-gray-500 italic">
                                {step.reason}
                            </span>
                        </div>

                        {/* Symbol Node */}
                        <button 
                            onClick={() => onSymbolClick(step.symbol_id)}
                            className="w-full text-left p-3 bg-white dark:bg-gray-900 rounded-lg border-l-4 border-indigo-500 shadow-sm border-y border-r border-gray-200 dark:border-gray-800 hover:border-r-indigo-500 hover:shadow-md transition-all group"
                        >
                            <div className="flex items-center justify-between">
                                <span className="font-mono text-xs font-bold text-gray-800 dark:text-gray-200 group-hover:text-indigo-500">
                                    {step.symbol_id}
                                </span>
                                <GitCommit size={14} className="text-gray-300 group-hover:text-indigo-400" />
                            </div>
                        </button>
                    </div>
                </div>
            ))}

            {/* Output Node */}
            <div className="relative z-10 flex gap-4 items-start">
                <div className="w-6 h-6 rounded-full bg-emerald-100 dark:bg-emerald-900/30 border-2 border-emerald-200 dark:border-emerald-800 flex items-center justify-center shrink-0 mt-0.5">
                    <GitCommit size={12} className="text-emerald-600 dark:text-emerald-400" />
                </div>
                <div className="flex-1">
                    <div className="text-[10px] uppercase text-gray-400 font-mono mb-1">Output Convergence</div>
                    <button 
                        onClick={() => onSymbolClick(trace.output_node)}
                        className="inline-block px-3 py-1.5 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded text-xs font-bold font-mono text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors"
                    >
                        {trace.output_node}
                    </button>
                </div>
            </div>

        </div>
    </div>
  );
};