
import React, { useEffect, useState } from 'react';
import { X, Loader2, Database, Shield, Activity, GitBranch, Globe, Sparkles, AlertTriangle, Hammer, Layout, User, Box, ArrowRight } from 'lucide-react';
import { domainService } from '../../services/domainService';
import { SymbolDef } from '../../types';

interface SymbolDetailPanelProps {
  symbolId: string | null;
  symbolData?: any; // Can be passed directly from chat context
  onClose: () => void;
  onSymbolClick?: (id: string) => void;
  onDomainClick?: (domain: string) => void;
  onInterpret?: (id: string) => void;
  onOpenInForge?: (data: any) => void;
}

export const SymbolDetailPanel: React.FC<SymbolDetailPanelProps> = ({ 
    symbolId, 
    symbolData,
    onClose, 
    onSymbolClick, 
    onDomainClick, 
    onInterpret,
    onOpenInForge 
}) => {
  const [data, setData] = useState<SymbolDef | null>(null);
  const [loading, setLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  
  // "Candidate" means we have data from the chat, but it's not in the local store
  const [isCandidate, setIsCandidate] = useState(false);
  const [isUnregistered, setIsUnregistered] = useState(false);

  useEffect(() => {
    if (symbolId) {
      setIsOpen(true);
      loadSymbol(symbolId);
    } else {
      setIsOpen(false);
      const timer = setTimeout(() => {
          setData(null);
          setIsCandidate(false);
          setIsUnregistered(false);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [symbolId, symbolData]);

  const loadSymbol = async (id: string) => {
    setLoading(true);
    setIsCandidate(false);
    setIsUnregistered(false);
    setData(null);

    // 1. Try Local Cache (Truth)
    const cached = await domainService.findById(id);
    if (cached) {
        setData(cached);
        setLoading(false);
        return;
    }

    // 2. Try Context Data (From Chat - Synthesis Candidate)
    if (symbolData && symbolData.id === id) {
        setData(symbolData);
        setIsCandidate(true);
        setLoading(false);
        return;
    }

    // 3. Fallback: Unregistered / Unknown
    // We create a partial object to satisfy UI
    setData({
        id: id,
        name: "Unregistered Symbol",
        kind: 'pattern',
        role: "This symbol ID is not currently in the local registry. Use the Interpret function to synthesize a definition or create it in the Forge.",
        triad: "VOID",
        symbol_domain: 'unknown',
        symbol_tag: 'missing',
        facets: {
            function: 'unknown',
            topology: 'unknown',
            commit: 'unknown',
            temporal: 'unknown',
            gate: [],
            substrate: [],
            invariants: []
        },
        failure_mode: 'Registry Miss',
        linked_patterns: [],
        macro: ''
    } as SymbolDef);
    setIsUnregistered(true);
    setLoading(false);
  };

  const getKindIcon = (kind?: string) => {
      switch(kind) {
          case 'lattice': return <Layout size={14} className="text-purple-500" />;
          case 'persona': return <User size={14} className="text-amber-500" />;
          default: return <Box size={14} className="text-indigo-500" />;
      }
  };

  const getKindColor = (kind?: string) => {
      switch(kind) {
          case 'lattice': return 'bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-800';
          case 'persona': return 'bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800';
          default: return 'bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 border-indigo-200 dark:border-indigo-800';
      }
  };

  // Safe renderer for potential object items in array
  const safeRenderItem = (item: any) => {
      if (typeof item === 'object') {
          return item.id || JSON.stringify(item);
      }
      return String(item);
  }

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
            <div className="flex flex-col">
                <span className="text-[10px] uppercase tracking-widest text-gray-500 font-mono">
                    {isCandidate ? "Synthesis Candidate" : "Symbol Inspection"}
                </span>
                <h2 className="font-mono font-bold text-emerald-600 dark:text-emerald-400 text-sm truncate max-w-[300px]">
                    {symbolId || "Select Symbol"}
                </h2>
            </div>
            <button 
                onClick={onClose}
                className="p-2 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white rounded-full hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors"
            >
                <X size={20} />
            </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 scroll-smooth">
            {loading ? (
                <div className="flex flex-col items-center justify-center h-64 gap-4 text-gray-400">
                    <Loader2 className="animate-spin" size={32} />
                    <span className="font-mono text-xs">Querying Registry...</span>
                </div>
            ) : data ? (
                <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                    
                    {/* Candidate / Unregistered Warnings */}
                    {isCandidate && (
                         <div className="bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 p-4 rounded-lg flex items-start gap-3">
                             <Sparkles className="text-indigo-500 flex-shrink-0" size={18} />
                             <div className="text-xs text-indigo-800 dark:text-indigo-200">
                                 <strong className="block mb-1 font-mono">Synthesis Candidate</strong>
                                 This symbol was generated in the stream but not yet saved to the registry. 
                             </div>
                         </div>
                    )}

                    {isUnregistered && (
                         <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-4 rounded-lg flex items-start gap-3">
                             <AlertTriangle className="text-amber-500 flex-shrink-0" size={18} />
                             <div className="text-xs text-amber-800 dark:text-amber-200">
                                 <strong className="block mb-1 font-mono">Registry Miss</strong>
                                 This symbol has not been canonicalized.
                             </div>
                         </div>
                    )}

                    {/* Identity Block */}
                    <div className="space-y-2">
                        <div className="flex items-start justify-between gap-4">
                            <h1 className="text-2xl font-bold text-gray-900 dark:text-white font-sans tracking-tight">
                                {data.name || "Unknown Symbol"}
                            </h1>
                            <div className="flex flex-col items-end gap-1">
                                <span className={`font-mono text-[10px] px-2 py-0.5 rounded border uppercase font-bold flex items-center gap-1 ${getKindColor(data.kind)}`}>
                                    {getKindIcon(data.kind)}
                                    {data.kind || 'pattern'}
                                </span>
                                <span className={`font-mono text-xs px-2 py-0.5 rounded border ${isUnregistered ? 'text-gray-500 border-gray-500/30 bg-gray-500/10' : 'text-emerald-500 border-emerald-500/30 bg-emerald-500/10'}`}>
                                    {data.triad || "NO-TRIAD"}
                                </span>
                            </div>
                        </div>
                        <p className="text-gray-600 dark:text-gray-400 text-sm leading-relaxed border-l-2 border-gray-200 dark:border-gray-800 pl-3 italic">
                            {data.role || "No role definition available."}
                        </p>
                    </div>

                    {/* LATTICE SPECIFIC DATA */}
                    {data.kind === 'lattice' && data.lattice && (
                         <div className="bg-purple-50 dark:bg-purple-900/10 rounded-lg p-4 border border-purple-100 dark:border-purple-800/30 space-y-4">
                            <div className="flex items-center gap-2 text-purple-600 dark:text-purple-400 font-mono text-xs uppercase font-bold border-b border-purple-200 dark:border-purple-800/30 pb-2">
                                <Layout size={12} /> Lattice Structure
                            </div>
                            
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-1">
                                    <span className="text-[10px] text-gray-500 uppercase font-mono">Topology</span>
                                    <div className="text-sm font-bold text-purple-800 dark:text-purple-300 capitalize">{data.lattice.topology}</div>
                                </div>
                                <div className="space-y-1">
                                    <span className="text-[10px] text-gray-500 uppercase font-mono">Closure</span>
                                    <div className="text-sm font-bold text-purple-800 dark:text-purple-300 capitalize">{data.lattice.closure}</div>
                                </div>
                            </div>
                            
                            {data.lattice.members && data.lattice.members.length > 0 && (
                                <div>
                                    <span className="text-[10px] text-gray-500 uppercase font-mono mb-2 block">Lattice Members</span>
                                    <ul className="space-y-1">
                                        {data.lattice.members.map((member: any, i: number) => {
                                            const memberId = safeRenderItem(member);
                                            return (
                                                <li key={i} className="flex items-center gap-2">
                                                    <div className="w-5 h-5 rounded-full bg-purple-200 dark:bg-purple-800 text-purple-700 dark:text-purple-300 flex items-center justify-center text-[10px] font-bold font-mono">
                                                        {i + 1}
                                                    </div>
                                                    <button 
                                                        onClick={() => onSymbolClick && onSymbolClick(memberId)}
                                                        className="text-xs font-mono text-gray-700 dark:text-gray-300 hover:text-purple-500 transition-colors"
                                                    >
                                                        {memberId}
                                                    </button>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </div>
                            )}
                         </div>
                    )}

                    {/* PERSONA SPECIFIC DATA */}
                    {data.kind === 'persona' && data.persona && (
                        <div className="bg-amber-50 dark:bg-amber-900/10 rounded-lg p-4 border border-amber-100 dark:border-amber-800/30 space-y-4">
                            <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400 font-mono text-xs uppercase font-bold border-b border-amber-200 dark:border-amber-800/30 pb-2">
                                <User size={12} /> Persona Profile
                            </div>

                             <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-1">
                                    <span className="text-[10px] text-gray-500 uppercase font-mono">Recursion Level</span>
                                    <div className="text-sm font-bold text-amber-800 dark:text-amber-300 capitalize">{data.persona.recursion_level}</div>
                                </div>
                                <div className="space-y-1">
                                    <span className="text-[10px] text-gray-500 uppercase font-mono">Primary Function</span>
                                    <div className="text-sm text-amber-800 dark:text-amber-300">{data.persona.function}</div>
                                </div>
                            </div>

                            {data.persona.activation_conditions && (
                                <div className="space-y-1">
                                    <span className="text-[10px] text-gray-500 uppercase font-mono">Activation Conditions</span>
                                    <ul className="text-xs text-gray-700 dark:text-gray-300 list-disc pl-4 space-y-1">
                                        {data.persona.activation_conditions.map((cond, i) => (
                                            <li key={i}>{safeRenderItem(cond)}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {data.persona.fallback_behavior && (
                                <div className="space-y-1">
                                    <span className="text-[10px] text-gray-500 uppercase font-mono">Fallback Behavior</span>
                                    <ul className="text-xs text-gray-700 dark:text-gray-300 list-disc pl-4 space-y-1">
                                        {data.persona.fallback_behavior.map((beh, i) => (
                                            <li key={i}>{safeRenderItem(beh)}</li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            
                             {data.persona.linked_personas && data.persona.linked_personas.length > 0 && (
                                <div>
                                    <span className="text-[10px] text-gray-500 uppercase font-mono mb-2 block">Linked Personas</span>
                                    <div className="flex flex-wrap gap-2">
                                        {data.persona.linked_personas.map((link, i) => {
                                            const linkId = safeRenderItem(link);
                                            return (
                                                <button 
                                                    key={i}
                                                    onClick={() => onSymbolClick && onSymbolClick(linkId)}
                                                    className="flex items-center gap-1.5 px-2 py-1 bg-amber-100 dark:bg-amber-900/40 rounded text-[10px] font-mono font-bold text-amber-800 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-900/60"
                                                >
                                                    <User size={10} /> {linkId}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* PATTERN SPECIFIC DATA (Macro) */}
                    {(!data.kind || data.kind === 'pattern') && data.macro && (
                        <div className="bg-gray-100 dark:bg-gray-900 rounded p-4 border-l-2 border-indigo-500">
                            <div className="flex items-center gap-2 mb-2 text-indigo-600 dark:text-indigo-400 font-mono text-xs uppercase font-bold">
                                <Activity size={12} /> Macro Logic
                            </div>
                            <code className="text-xs md:text-sm font-mono text-gray-700 dark:text-gray-300 block whitespace-pre-wrap">
                                {data.macro}
                            </code>
                        </div>
                    )}

                    {/* Facets Grid (Common) */}
                    {data.facets && (
                        <div className="grid grid-cols-1 gap-4">
                             <div className="text-[10px] uppercase tracking-widest text-gray-500 font-mono border-b border-gray-200 dark:border-gray-800 pb-1">
                                Operational Facets
                            </div>
                            
                            <div className="grid grid-cols-2 gap-4">
                                <FacetItem label="Function" value={data.facets.function} />
                                <FacetItem label="Topology" value={data.facets.topology} />
                                <FacetItem label="Commit" value={data.facets.commit} />
                                <FacetItem label="Temporal" value={data.facets.temporal} />
                            </div>

                            {/* Arrays */}
                            {data.facets.invariants && data.facets.invariants.length > 0 && (
                                <div className="space-y-1">
                                    <div className="text-xs font-mono text-gray-500">Invariants</div>
                                    <div className="flex flex-wrap gap-2">
                                        {data.facets.invariants.map((inv, i) => (
                                            <span key={i} className="px-2 py-1 rounded bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-500 text-xs flex items-center gap-1 border border-amber-200 dark:border-amber-900/30">
                                                <Shield size={10} /> {safeRenderItem(inv)}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Failure Mode (Common) */}
                    {data.failure_mode && (
                         <div className="bg-red-50 dark:bg-red-950/30 p-4 rounded border border-red-100 dark:border-red-900/30">
                            <div className="text-xs font-bold text-red-600 dark:text-red-400 uppercase font-mono mb-1">
                                ⚠️ Failure Mode
                            </div>
                            <p className="text-sm text-red-800 dark:text-red-300">
                                {data.failure_mode}
                            </p>
                         </div>
                    )}

                    {/* Linked Patterns (Common / Pattern only) */}
                    {/* Note: Lattice uses 'members', Persona uses 'linked_personas'. This handles legacy or pattern-specific links */}
                    {data.linked_patterns && data.linked_patterns.length > 0 && (
                        <div>
                             <div className="text-[10px] uppercase tracking-widest text-gray-500 font-mono border-b border-gray-200 dark:border-gray-800 pb-1 mb-3">
                                <GitBranch size={10} className="inline mr-1" /> Linked Patterns
                            </div>
                            <ul className="space-y-1">
                                {data.linked_patterns.map((link, i) => {
                                    const linkId = safeRenderItem(link);
                                    return (
                                        <li key={i} className="text-xs font-mono pl-2 border-l border-gray-300 dark:border-gray-700">
                                            <button 
                                                onClick={() => onSymbolClick && onSymbolClick(linkId)}
                                                className="text-emerald-600 dark:text-emerald-400 hover:text-emerald-500 hover:underline text-left break-all transition-colors"
                                            >
                                                {linkId}
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    )}

                    {/* Metadata */}
                    <div className="pt-8 mt-8 border-t border-gray-200 dark:border-gray-800 text-[10px] font-mono text-gray-400 flex flex-col gap-1">
                        <div>
                            DOMAIN: {' '}
                            {data.symbol_domain ? (
                                <button 
                                    onClick={() => onDomainClick && data.symbol_domain && onDomainClick(data.symbol_domain)}
                                    className="text-indigo-500 hover:text-indigo-400 hover:underline inline-flex items-center gap-1"
                                >
                                    <Globe size={10} />
                                    {data.symbol_domain}
                                </button>
                            ) : "N/A"}
                        </div>
                        <div>TAG: {data.symbol_tag || "N/A"}</div>
                        <div>RAW_ID: {data.id}</div>
                    </div>

                    {/* Action Buttons */}
                    <div className="pt-6 mt-6 border-t border-gray-100 dark:border-gray-800 space-y-3">
                        
                        {/* Open in Forge (Candidate) */}
                        {(isCandidate || isUnregistered) && onOpenInForge && (
                            <button
                                onClick={() => data && onOpenInForge(data)}
                                className="w-full py-3 px-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg flex items-center justify-center gap-2 transition-all font-mono text-sm shadow-sm hover:shadow-md font-bold"
                            >
                                <Hammer size={16} />
                                Open in Forge to Create
                            </button>
                        )}

                        {/* Interpret Button */}
                        {onInterpret && (
                            <button
                                onClick={() => data && onInterpret(data.id)}
                                className="w-full py-3 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg flex items-center justify-center gap-2 transition-all font-mono text-sm shadow-sm hover:shadow-md"
                            >
                                <Sparkles size={16} />
                                Interpret Recursive Meaning
                            </button>
                        )}
                        
                        {/* Edit existing in forge */}
                        {!isCandidate && !isUnregistered && onOpenInForge && (
                            <button
                                onClick={() => data && onOpenInForge(data)}
                                className="w-full py-2 px-4 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg flex items-center justify-center gap-2 transition-all font-mono text-xs font-bold"
                            >
                                <Hammer size={14} /> Edit in Forge
                            </button>
                        )}
                    </div>

                </div>
            ) : (
                <div className="flex flex-col items-center justify-center h-full text-gray-400">
                    <Database size={48} className="mb-4 opacity-20" />
                    <p className="text-sm font-mono">Select a symbol to inspect data.</p>
                </div>
            )}
        </div>
      </div>
    </>
  );
};

const FacetItem: React.FC<{label: string, value: any}> = ({ label, value }) => {
    if (!value) return null;
    return (
        <div className="bg-gray-50 dark:bg-gray-900/50 p-2 rounded border border-gray-200 dark:border-gray-800">
            <div className="text-[10px] text-gray-400 uppercase font-mono mb-0.5">{label}</div>
            <div className="text-sm font-medium text-gray-700 dark:text-gray-300">{typeof value === 'object' ? JSON.stringify(value) : value}</div>
        </div>
    )
}
