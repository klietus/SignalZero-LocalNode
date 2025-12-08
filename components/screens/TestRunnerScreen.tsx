
import React, { useState, useEffect, useRef } from 'react';
import { Play, Loader2, BarChart3, FileJson, Download, Network, Clock, Database, Layers, Upload, Sparkles, X, FlaskConical } from 'lucide-react';
import { generateGapSynthesis } from '../../services/gemini';
import { TestResult, SymbolDef, TraceData } from '../../types';
import { testService } from '../../services/testService';
import { domainService } from '../../services/domainService';
import { TraceVisualizer } from '../TraceVisualizer';
import { Header, HeaderProps } from '../Header';

interface TestRunnerScreenProps {
  onBack: () => void;
  results: TestResult[];
  isRunning: boolean;
  onRun: (prompts: string[]) => void;
  headerProps: Omit<HeaderProps, 'children'>;
}

export const TestRunnerScreen: React.FC<TestRunnerScreenProps> = ({ onBack, results, isRunning, onRun, headerProps }) => {
  const [jsonInput, setJsonInput] = useState("[]");
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [selectedResultId, setSelectedResultId] = useState<string | null>(null);
  
  // Trace Modal State
  const [viewingTrace, setViewingTrace] = useState<TraceData | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load from cache on mount
  useEffect(() => {
    const cachedTests = testService.getTests();
    setJsonInput(JSON.stringify(cachedTests, null, 2));
  }, []);

  // Sync edits back to cache
  const handleJsonChange = (val: string) => {
      setJsonInput(val);
      try {
          const parsed = JSON.parse(val);
          if (Array.isArray(parsed)) {
              testService.setTests(parsed);
          }
      } catch (e) {
          // Ignore parse errors while typing
      }
  };

  const handleRunClick = () => {
      try {
          const prompts: string[] = JSON.parse(jsonInput);
          if (!Array.isArray(prompts)) throw new Error("Input must be a JSON array of strings.");
          onRun(prompts);
      } catch (e) {
          alert("Invalid JSON Input: " + String(e));
      }
  };

  const handleGapSynthesis = async () => {
      const selectedTest = results.find(t => t.id === selectedResultId);
      if (!selectedTest || !selectedTest.signalZeroResponse || !selectedTest.baselineResponse) return;

      setIsSynthesizing(true);
      try {
          // 1. Gather Context
          const allDomainIds = await domainService.listDomains();
          const activeDomains: string[] = [];
          
          for (const d of allDomainIds) {
              if (await domainService.isEnabled(d)) {
                  activeDomains.push(d);
              }
          }

          let allSymbols: SymbolDef[] = [];
          for (const d of activeDomains) {
              const syms = await domainService.getSymbols(d);
              allSymbols = [...allSymbols, ...syms];
          }

          // 2. Call AI
          const resultText = await generateGapSynthesis(
              selectedTest.prompt,
              selectedTest.signalZeroResponse,
              selectedTest.baselineResponse,
              activeDomains,
              allSymbols
          );

          // 3. Parse all symbols returned
          const regex = /<sz_symbol>([\s\S]*?)<\/sz_symbol>/g;
          let match;
          const synthesized: SymbolDef[] = [];

          while ((match = regex.exec(resultText)) !== null) {
              const cleanJson = match[1].replace(/```json\n?|```/g, '').trim();
              try {
                  const parsed = JSON.parse(cleanJson) as SymbolDef;
                  if (parsed.id) {
                       // Ensure mandatory fields
                       if (!parsed.kind) parsed.kind = 'pattern';
                       
                       // Enforce active domain constraint or fallback
                       if (!parsed.symbol_domain || !activeDomains.includes(parsed.symbol_domain)) {
                           // Default to first active or fallback
                           parsed.symbol_domain = activeDomains.length > 0 ? activeDomains[0] : 'gap-analysis';
                       }

                       domainService.upsertSymbol(parsed.symbol_domain, parsed);
                       synthesized.push(parsed);
                  }
              } catch(e) {
                  console.warn("Failed to parse a symbol block", e);
              }
          }

          if (synthesized.length > 0) {
              const report = synthesized.map(s => `• ${s.name} (${s.id}) [${s.symbol_domain}]`).join('\n');
              alert(`Successfully synthesized ${synthesized.length} gap symbol(s):\n\n${report}`);
          } else {
              throw new Error("Model did not return any valid <sz_symbol> tags.");
          }

      } catch (e) {
          alert("Gap synthesis failed: " + String(e));
      } finally {
          setIsSynthesizing(false);
      }
  };

  const handleDownloadResults = () => {
      if (results.length === 0) return;
      
      const data = {
          timestamp: new Date().toISOString(),
          test_suite_size: results.length,
          results: results
      };
      
      const jsonString = JSON.stringify(data, null, 2);
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `signalzero_test_run_${new Date().getTime()}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
  };

  // --- Import / Export Test Cases ---

  const handleExportTests = () => {
      try {
          // Validate and parse current input to ensure clean JSON
          const data = JSON.parse(jsonInput);
          const jsonString = JSON.stringify(data, null, 2);
          const blob = new Blob([jsonString], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = `signalzero_test_cases_${new Date().getTime()}.json`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(url);
      } catch (e) {
          alert("Invalid JSON content. Please ensure the test case list is valid JSON before exporting.");
      }
  };

  const handleImportTestsClick = () => {
      fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (event) => {
          try {
              const text = event.target?.result as string;
              const json = JSON.parse(text);
              
              if (Array.isArray(json) && json.every(item => typeof item === 'string')) {
                  const formatted = JSON.stringify(json, null, 2);
                  setJsonInput(formatted);
                  testService.setTests(json);
                  alert(`Successfully imported ${json.length} test cases.`);
              } else {
                  alert("Invalid format. File must contain a JSON array of strings.");
              }
          } catch (err) {
              alert("Failed to parse JSON file: " + String(err));
          } finally {
              if (fileInputRef.current) fileInputRef.current.value = '';
          }
      };
      reader.readAsText(file);
  };

  const handleSymbolClickStub = (id: string) => {
      alert(`Symbol ${id} clicked. In full app, this would open details.`);
  };

  const selectedTest = results.find(t => t.id === selectedResultId) || results[0];

  return (
    <div className="flex flex-col h-full bg-gray-50 dark:bg-gray-950 font-sans">
        
        {/* Hidden File Input */}
        <input 
            type="file" 
            ref={fileInputRef} 
            onChange={handleFileChange} 
            accept=".json" 
            className="hidden" 
        />

        <Header {...headerProps}>
            <div className="flex items-center gap-2">
                <button 
                    onClick={handleDownloadResults}
                    disabled={results.length === 0}
                    className="flex items-center gap-2 px-3 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-50 text-gray-700 dark:text-gray-300 rounded-md text-sm font-mono font-bold transition-colors border border-gray-200 dark:border-gray-700"
                >
                    <Download size={16} /> JSON Results
                </button>
                <button 
                    onClick={handleRunClick}
                    disabled={isRunning}
                    className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-md text-sm font-mono font-bold transition-colors"
                >
                    {isRunning ? <Loader2 size={16} className="animate-spin"/> : <Play size={16} />}
                    Run Test Suite
                </button>
            </div>
        </Header>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
            
            {/* Sidebar: Inputs & List */}
            <div className="w-1/3 min-w-[300px] border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex flex-col shrink-0">
                
                {/* JSON Input */}
                <div className="p-4 border-b border-gray-200 dark:border-gray-800">
                    <div className="flex items-center justify-between mb-2">
                        <label className="text-xs font-bold uppercase tracking-wider text-gray-500 font-mono flex items-center gap-2">
                            <FileJson size={12}/> Test Cases
                        </label>
                        <div className="flex items-center gap-1">
                            <button 
                                onClick={handleImportTestsClick}
                                className="p-1.5 text-gray-500 hover:text-purple-500 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors"
                                title="Import Test Cases (.json)"
                            >
                                <Upload size={14} />
                            </button>
                            <button 
                                onClick={handleExportTests}
                                className="p-1.5 text-gray-500 hover:text-purple-500 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors"
                                title="Export Test Cases (.json)"
                            >
                                <Download size={14} />
                            </button>
                        </div>
                    </div>
                    <textarea 
                        value={jsonInput}
                        onChange={e => handleJsonChange(e.target.value)}
                        className="w-full h-32 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-3 font-mono text-xs focus:ring-2 focus:ring-purple-500 focus:outline-none resize-none"
                        placeholder='["Test Case 1", "Test Case 2"]'
                    />
                </div>

                {/* Results List */}
                <div className="flex-1 overflow-y-auto">
                    {results.length === 0 ? (
                        <div className="p-8 text-center text-gray-400 text-sm font-mono">
                            Ready to execute.
                        </div>
                    ) : (
                        <div className="divide-y divide-gray-100 dark:divide-gray-800">
                            {results.map(test => (
                                <button
                                    key={test.id}
                                    onClick={() => setSelectedResultId(test.id)}
                                    className={`w-full text-left p-4 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors ${selectedResultId === test.id || (!selectedResultId && results[0].id === test.id) ? 'bg-purple-50 dark:bg-purple-900/20 border-l-4 border-purple-500' : 'border-l-4 border-transparent'}`}
                                >
                                    <div className="flex justify-between items-start mb-1">
                                        <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                                            test.status === 'completed' ? 'bg-green-100 dark:bg-green-900/30 text-green-600' :
                                            test.status === 'running' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600' :
                                            'bg-gray-100 dark:bg-gray-800 text-gray-500'
                                        }`}>
                                            {test.status}
                                        </span>
                                        {test.evaluation && (
                                            <span className="font-mono text-xs font-bold text-gray-600 dark:text-gray-300">
                                                SZ Score: {test.evaluation.sz.alignment_score}
                                            </span>
                                        )}
                                    </div>
                                    <div className="text-xs font-mono text-gray-800 dark:text-gray-200 line-clamp-2">
                                        {test.prompt}
                                    </div>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Main Comparison Area */}
            <div className="flex-1 overflow-y-auto bg-gray-50 dark:bg-gray-950 p-6 relative">
                {selectedTest ? (
                    <div className="max-w-5xl mx-auto space-y-6">
                        
                        {/* Prompt Header */}
                        <div className="bg-white dark:bg-gray-900 p-4 rounded-lg border border-gray-200 dark:border-gray-800 shadow-sm">
                            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400 font-mono mb-2">Test Prompt</h3>
                            <p className="font-mono text-sm text-gray-800 dark:text-gray-200">{selectedTest.prompt}</p>
                        </div>

                        {/* Metadata Section (If completed) */}
                        {selectedTest.meta && (
                             <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                <div className="bg-white dark:bg-gray-900 p-3 rounded border border-gray-200 dark:border-gray-800 flex items-center gap-3">
                                    <Clock className="text-purple-500" size={16} />
                                    <div>
                                        <div className="text-[10px] text-gray-400 font-mono uppercase">Execution Time</div>
                                        <div className="text-sm font-bold font-mono text-gray-700 dark:text-gray-300">
                                            {selectedTest.meta.durationMs}ms
                                        </div>
                                    </div>
                                </div>
                                <div className="bg-white dark:bg-gray-900 p-3 rounded border border-gray-200 dark:border-gray-800 flex items-center gap-3">
                                    <Database className="text-indigo-500" size={16} />
                                    <div>
                                        <div className="text-[10px] text-gray-400 font-mono uppercase">Loaded Domains</div>
                                        <div className="text-sm font-bold font-mono text-gray-700 dark:text-gray-300 truncate max-w-[150px]" title={selectedTest.meta.loadedDomains.join(', ')}>
                                            {selectedTest.meta.loadedDomains.length > 0 ? selectedTest.meta.loadedDomains.join(', ') : 'None'}
                                        </div>
                                    </div>
                                </div>
                                <div className="bg-white dark:bg-gray-900 p-3 rounded border border-gray-200 dark:border-gray-800 flex items-center gap-3">
                                    <Layers className="text-amber-500" size={16} />
                                    <div>
                                        <div className="text-[10px] text-gray-400 font-mono uppercase">Traces Captured</div>
                                        <div className="text-sm font-bold font-mono text-gray-700 dark:text-gray-300">
                                            {selectedTest.traces?.length || 0}
                                        </div>
                                    </div>
                                </div>
                             </div>
                        )}

                        {/* Reasoning */}
                        {selectedTest.evaluation && (
                            <div className="bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800 p-4 rounded-lg">
                                <h4 className="text-xs font-bold text-blue-700 dark:text-blue-400 uppercase mb-2 flex items-center gap-2">
                                    <BarChart3 size={14}/> Judge Reasoning
                                </h4>
                                <p className="text-sm text-blue-900 dark:text-blue-200 font-mono">
                                    {selectedTest.evaluation.overall_reasoning}
                                </p>
                            </div>
                        )}

                        {/* Gap Synthesis Toolbar */}
                        {selectedTest.status === 'completed' && (
                            <div className="flex justify-center">
                                <button
                                    onClick={handleGapSynthesis}
                                    disabled={isSynthesizing}
                                    className="flex items-center gap-2 px-6 py-2 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 text-white rounded-full text-xs font-mono font-bold shadow-md hover:shadow-lg transition-all disabled:opacity-50 transform hover:-translate-y-0.5"
                                >
                                    {isSynthesizing ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                                    Synthesize Gap Symbols (Diff Analysis)
                                </button>
                            </div>
                        )}

                        {/* Side-by-Side Comparison */}
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                            
                            {/* SignalZero Column */}
                            <div className="space-y-4">
                                {selectedTest.evaluation && (
                                    <div className="grid grid-cols-3 gap-2">
                                        <ScoreCard 
                                            label="Alignment" 
                                            value={selectedTest.evaluation.sz.alignment_score} 
                                            color={selectedTest.evaluation.sz.alignment_score > 80 ? "green" : "red"}
                                        />
                                        <ScoreCard 
                                            label="Auditability" 
                                            value={selectedTest.evaluation.sz.auditability_score} 
                                            color={selectedTest.evaluation.sz.auditability_score > 80 ? "green" : "indigo"}
                                        />
                                        <ScoreCard 
                                            label="Reasoning Depth" 
                                            value={selectedTest.evaluation.sz.reasoning_depth} 
                                            color="indigo"
                                        />
                                    </div>
                                )}
                                
                                <div className="bg-white dark:bg-gray-900 rounded-lg border border-purple-200 dark:border-purple-900/50 shadow-sm flex flex-col h-[500px]">
                                    <div className="p-3 border-b border-purple-100 dark:border-purple-900/30 bg-purple-50 dark:bg-purple-900/10 flex justify-between items-center">
                                        <span className="font-bold font-mono text-purple-700 dark:text-purple-400 text-xs">SIGNALZERO KERNEL</span>
                                        {selectedTest.evaluation && (
                                            <span className={`text-[10px] font-bold uppercase ${selectedTest.evaluation.sz.drift_detected ? 'text-red-500' : 'text-green-500'}`}>
                                                {selectedTest.evaluation.sz.drift_detected ? "Drift Detected" : "Stable"}
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex-1 overflow-y-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-gray-700 dark:text-gray-300">
                                        {selectedTest.signalZeroResponse || <span className="text-gray-400 italic">Pending...</span>}
                                    </div>
                                </div>
                            </div>

                            {/* Baseline Column */}
                            <div className="space-y-4">
                                {selectedTest.evaluation && (
                                    <div className="grid grid-cols-3 gap-2">
                                        <ScoreCard 
                                            label="Alignment" 
                                            value={selectedTest.evaluation.base.alignment_score} 
                                            color={selectedTest.evaluation.base.alignment_score > 80 ? "green" : "gray"}
                                        />
                                        <ScoreCard 
                                            label="Auditability" 
                                            value={selectedTest.evaluation.base.auditability_score} 
                                            color="gray"
                                        />
                                        <ScoreCard 
                                            label="Reasoning Depth" 
                                            value={selectedTest.evaluation.base.reasoning_depth} 
                                            color="gray"
                                        />
                                    </div>
                                )}

                                <div className="bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-800 shadow-sm flex flex-col h-[500px]">
                                    <div className="p-3 border-b border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50 flex justify-between items-center">
                                        <span className="font-bold font-mono text-gray-600 dark:text-gray-400 text-xs">BASELINE MODEL</span>
                                        {selectedTest.evaluation && (
                                            <span className={`text-[10px] font-bold uppercase ${selectedTest.evaluation.base.drift_detected ? 'text-red-500' : 'text-green-500'}`}>
                                                {selectedTest.evaluation.base.drift_detected ? "Drift Detected" : "Stable"}
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex-1 overflow-y-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-gray-700 dark:text-gray-300">
                                        {selectedTest.baselineResponse || <span className="text-gray-400 italic">Pending...</span>}
                                    </div>
                                </div>
                            </div>

                        </div>
                        
                        {/* Trace Inspector (Collapsed List) */}
                        {selectedTest.traces && selectedTest.traces.length > 0 && (
                            <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-900/30 rounded-lg p-4">
                                <div className="flex items-center gap-2 mb-3">
                                    <Network className="text-amber-600 dark:text-amber-500" size={16} />
                                    <h4 className="text-xs font-bold text-amber-700 dark:text-amber-400 uppercase">Captured Symbolic Traces (Click to View)</h4>
                                    <span className="text-[10px] bg-amber-200 dark:bg-amber-800/50 px-2 py-0.5 rounded-full font-mono font-bold text-amber-800 dark:text-amber-200">
                                        {selectedTest.traces.length}
                                    </span>
                                </div>
                                <div className="grid grid-cols-1 gap-2 max-h-60 overflow-y-auto">
                                    {selectedTest.traces.map((trace, idx) => (
                                        <button 
                                            key={idx} 
                                            onClick={() => setViewingTrace(trace)}
                                            className="text-left bg-white dark:bg-gray-900 p-3 rounded border border-gray-200 dark:border-gray-800 text-xs font-mono shadow-sm hover:border-amber-500 dark:hover:border-amber-500 transition-colors group"
                                        >
                                            <div className="flex justify-between items-center mb-1">
                                                <span className="font-bold text-amber-600 dark:text-amber-500 group-hover:underline">{trace.id}</span>
                                                <span className="text-[10px] text-gray-400">{trace.status}</span>
                                            </div>
                                            <div className="text-gray-600 dark:text-gray-300">
                                                Entry: {trace.entry_node}
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {selectedTest.status === 'running' && !selectedTest.evaluation && (
                            <div className="p-8 text-center text-gray-400 font-mono text-sm animate-pulse">
                                Executing Symbolic Tests...
                            </div>
                        )}

                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center h-full text-gray-400">
                        <FlaskConical size={48} className="mb-4 opacity-20" />
                        <p className="text-sm font-mono">Select a test case to view comparison.</p>
                    </div>
                )}
            </div>

            {/* Trace Modal */}
            {viewingTrace && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl max-w-4xl w-full max-h-[90vh] flex flex-col border border-gray-200 dark:border-gray-800">
                        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950">
                            <h3 className="font-bold font-mono text-amber-600 dark:text-amber-500 flex items-center gap-2">
                                <Network size={18} /> Symbolic Trace Viewer
                            </h3>
                            <button 
                                onClick={() => setViewingTrace(null)}
                                className="p-1 hover:bg-gray-200 dark:hover:bg-gray-800 rounded-full transition-colors"
                            >
                                <X size={20} />
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-6">
                            <TraceVisualizer trace={viewingTrace} onSymbolClick={handleSymbolClickStub} />
                        </div>
                    </div>
                </div>
            )}

        </div>
    </div>
  );
};

const ScoreCard = ({ label, value, color = "gray" }: any) => {
    const colors: any = {
        green: "text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800",
        red: "text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800",
        indigo: "text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/20 border-indigo-200 dark:border-indigo-800",
        gray: "text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-900/20 border-gray-200 dark:border-gray-800",
    };

    return (
        <div className={`p-3 rounded-lg border ${colors[color]}`}>
            <div className="text-[10px] font-bold uppercase tracking-wider opacity-70 mb-1">{label}</div>
            <div className="text-lg font-bold">{value}</div>
        </div>
    );
};
