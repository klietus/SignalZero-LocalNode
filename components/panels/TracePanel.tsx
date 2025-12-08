
import React, { useState, useEffect } from 'react';
import { X, Network, Download, ChevronDown, Activity } from 'lucide-react';
import { TraceData } from '../../types';
import { TraceVisualizer } from '../TraceVisualizer';

interface TracePanelProps {
  isOpen: boolean;
  onClose: () => void;
  traces: TraceData[];
  selectedTraceId: string | null;
  onSelectTrace: (id: string) => void;
  onSymbolClick: (id: string) => void;
}

export const TracePanel: React.FC<TracePanelProps> = ({ 
  isOpen, 
  onClose, 
  traces, 
  selectedTraceId, 
  onSelectTrace,
  onSymbolClick
}) => {
  const [activeTrace, setActiveTrace] = useState<TraceData | null>(null);
  const [isDownloadMenuOpen, setIsDownloadMenuOpen] = useState(false);

  useEffect(() => {
    if (selectedTraceId) {
      const found = traces.find(t => t.id === selectedTraceId);
      if (found) setActiveTrace(found);
    } else if (traces.length > 0 && !activeTrace) {
      // Default to most recent if none selected
      setActiveTrace(traces[traces.length - 1]);
    }
  }, [selectedTraceId, traces, activeTrace]);

  const handleSymbolClick = (id: string) => {
    onSymbolClick(id);
  };

  const downloadJson = (data: any, filenamePrefix: string) => {
    if (!data) return;
    
    const jsonString = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    
    // Create safe filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    link.href = url;
    link.download = `${filenamePrefix}_${timestamp}.json`;
    
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setIsDownloadMenuOpen(false);
  };

  return (
    <>
      {/* Slide-out Panel (Left Side) */}
      <div 
        className={`fixed inset-y-0 left-0 w-full md:w-[600px] bg-gray-50 dark:bg-gray-950 border-r border-gray-200 dark:border-gray-800 shadow-2xl transform transition-transform duration-300 ease-in-out z-40 flex flex-col ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-white/50 dark:bg-gray-900/50 backdrop-blur">
            <h2 className="font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2 font-mono text-sm">
                <Network size={16} className="text-amber-500" />
                Recursive Reasoning Log
            </h2>
            <div className="flex items-center gap-2">
                
                {/* Download Dropdown */}
                <div className="relative">
                    <button 
                        onClick={() => setIsDownloadMenuOpen(!isDownloadMenuOpen)}
                        className="flex items-center gap-1 px-2 py-1.5 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white rounded hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors font-mono text-xs"
                        title="Export Traces"
                    >
                        <Download size={14} />
                        <span>Export</span>
                        <ChevronDown size={12} />
                    </button>

                    {isDownloadMenuOpen && (
                        <div className="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg shadow-xl z-50 py-1 flex flex-col">
                            <button
                                onClick={() => activeTrace && downloadJson(activeTrace, `signalzero_trace_${activeTrace.id}`)}
                                disabled={!activeTrace}
                                className="w-full text-left px-4 py-2 text-xs font-mono text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
                            >
                                Download Current Trace
                            </button>
                            <button
                                onClick={() => downloadJson(traces, 'signalzero_traces_all')}
                                disabled={traces.length === 0}
                                className="w-full text-left px-4 py-2 text-xs font-mono text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50 border-t border-gray-100 dark:border-gray-800"
                            >
                                Download All Traces ({traces.length})
                            </button>
                        </div>
                    )}
                </div>

                <div className="h-4 w-px bg-gray-300 dark:bg-gray-700 mx-1"></div>

                <button 
                    onClick={onClose}
                    className="p-1.5 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white rounded-full hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors"
                >
                    <X size={18} />
                </button>
            </div>
        </div>

        {/* Content Layout */}
        <div className="flex-1 flex overflow-hidden">
            
            {/* Sidebar List */}
            <div className="w-1/3 border-r border-gray-200 dark:border-gray-800 overflow-y-auto bg-gray-100/50 dark:bg-gray-900/30">
                {traces.length === 0 ? (
                    <div className="p-4 text-xs text-gray-400 font-mono text-center mt-10">
                        No traces captured.
                    </div>
                ) : (
                    <div className="flex flex-col">
                        {traces.slice().reverse().map((trace) => (
                            <button
                                key={trace.id}
                                onClick={() => {
                                    onSelectTrace(trace.id);
                                    setActiveTrace(trace);
                                }}
                                className={`p-3 text-left border-b border-gray-200 dark:border-gray-800 transition-colors hover:bg-white dark:hover:bg-gray-800 ${
                                    activeTrace?.id === trace.id 
                                    ? 'bg-white dark:bg-gray-800 border-l-4 border-l-amber-500' 
                                    : 'border-l-4 border-l-transparent'
                                }`}
                            >
                                <div className="font-mono text-[10px] text-gray-500 mb-1 truncate">
                                    {trace.id}
                                </div>
                                <div className="font-bold text-xs text-gray-800 dark:text-gray-200 truncate">
                                    {trace.entry_node}
                                </div>
                                <div className="flex items-center gap-1 mt-1 text-[10px] text-gray-400">
                                    <Activity size={10} />
                                    <span className="truncate">{trace.status}</span>
                                </div>
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {/* Main Detail View */}
            <div className="w-2/3 overflow-y-auto p-6 bg-white dark:bg-gray-950">
                {activeTrace ? (
                    <TraceVisualizer trace={activeTrace} onSymbolClick={handleSymbolClick} />
                ) : (
                    <div className="flex flex-col items-center justify-center h-full text-gray-400">
                        <Network size={48} className="mb-4 opacity-20" />
                        <p className="text-sm font-mono">Select a trace to visualize reasoning path.</p>
                    </div>
                )}
            </div>
        </div>
      </div>
    </>
  );
};
