
import React, { useEffect, useState } from 'react';
import { X, Loader2, Shield, LayoutGrid, ArrowDownToLine, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { domainService } from '../../services/domainService';

interface DomainPanelProps {
  domain: string | null;
  onClose: () => void;
  onSymbolClick: (id: string) => void;
  onLoadDomain: (domain: string) => void;
  onDomainChange: (domain: string) => void;
}

interface SymbolSummary {
  id: string;
  name: string;
  triad: string;
  role: string;
  symbol_tag?: string;
}

const ITEMS_PER_PAGE = 20;

export const DomainPanel: React.FC<DomainPanelProps> = ({ domain, onClose, onSymbolClick, onLoadDomain, onDomainChange }) => {
  const [pageCache, setPageCache] = useState<Record<number, SymbolSummary[]>>({});
  const [currentPage, setCurrentPage] = useState(0);
  const [availableDomains, setAvailableDomains] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  
  const [hasMore, setHasMore] = useState(true);

  // Fetch available domains from REDIS CACHE
  useEffect(() => {
    const fetchDomains = async () => {
        if (isOpen) {
            const localDomains = await domainService.listDomains();
            setAvailableDomains(localDomains.sort());
        }
    };
    fetchDomains();
  }, [isOpen]);

  useEffect(() => {
    if (domain) {
      setIsOpen(true);
      // Reset pagination when domain changes
      setPageCache({});
      setCurrentPage(0);
      setHasMore(true);
      fetchPage(0, null);
    } else {
      setIsOpen(false);
      const timer = setTimeout(() => {
        setPageCache({});
        setCurrentPage(0);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [domain]);

  const fetchPage = async (pageIndex: number, lastId: string | null) => {
    if (!domain) return;
    
    setLoading(true);
    setError(null);
    try {
      // Use Local Cache Query
      const result = await domainService.query(domain, undefined, ITEMS_PER_PAGE, lastId || undefined);

      if (!result) {
          throw new Error("Domain not found or disabled in store.");
      }

      const newItems = result.items;

      setPageCache(prev => ({
          ...prev,
          [pageIndex]: newItems
      }));

      if (newItems.length < ITEMS_PER_PAGE) {
          setHasMore(false);
      } else {
          setHasMore(true);
      }

    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleNextPage = () => {
      const currentItems = pageCache[currentPage];
      if (!currentItems || currentItems.length === 0) return;

      const nextPage = currentPage + 1;
      
      if (pageCache[nextPage]) {
          setCurrentPage(nextPage);
          if (pageCache[nextPage].length < ITEMS_PER_PAGE) {
              setHasMore(false);
          } else {
              setHasMore(true);
          }
      } else {
          const lastId = currentItems[currentItems.length - 1].id;
          fetchPage(nextPage, lastId).then(() => {
              setCurrentPage(nextPage);
          });
      }
  };

  const handlePrevPage = () => {
      if (currentPage > 0) {
          setCurrentPage(currentPage - 1);
          setHasMore(true);
      }
  };

  const currentSymbols = pageCache[currentPage] || [];

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
            <div className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-widest text-gray-500 font-mono">Domain Registry (Redis)</span>
                
                <div className="relative group">
                    <select 
                        value={domain || ""} 
                        onChange={(e) => onDomainChange(e.target.value)}
                        className="appearance-none bg-transparent font-mono font-bold text-indigo-600 dark:text-indigo-400 text-sm truncate max-w-[200px] pr-8 cursor-pointer focus:outline-none hover:text-indigo-500 transition-colors"
                    >
                        <option value="" disabled>Select Domain</option>
                        {availableDomains.map(d => (
                            <option key={d} value={d} className="bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200">
                                {d}
                            </option>
                        ))}
                    </select>
                    <ChevronDown className="absolute right-0 top-1/2 -translate-y-1/2 text-indigo-400 pointer-events-none group-hover:text-indigo-500" size={14} />
                </div>
            </div>
            
            <div className="flex items-center gap-3">
                <button
                    onClick={() => domain && onLoadDomain(domain)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors uppercase tracking-wider"
                    title="Load domain context into chat"
                >
                    <ArrowDownToLine size={14} />
                    Load
                </button>

                <button 
                    onClick={onClose}
                    className="p-2 text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white rounded-full hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors"
                >
                    <X size={20} />
                </button>
            </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 scroll-smooth">
            {loading && currentSymbols.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-64 gap-4 text-gray-400">
                    <Loader2 className="animate-spin" size={32} />
                    <span className="font-mono text-xs"> querying redis...</span>
                </div>
            ) : error ? (
                <div className="p-4 border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/10 rounded-lg text-red-600 dark:text-red-400 text-sm font-mono">
                    ERROR: {error}
                </div>
            ) : currentSymbols.length > 0 ? (
                <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
                    <div className="flex items-center justify-between text-xs font-mono text-gray-500 pb-2 border-b border-gray-100 dark:border-gray-800">
                        <span>Page {currentPage + 1} ({currentSymbols.length} items)</span>
                        <LayoutGrid size={14} />
                    </div>
                    
                    {currentSymbols.map((sym) => (
                        <button
                            key={sym.id}
                            onClick={() => onSymbolClick(sym.id)}
                            className="w-full text-left group flex flex-col gap-2 p-4 rounded-lg bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-800 hover:border-indigo-500/50 hover:bg-white dark:hover:bg-gray-900 transition-all"
                        >
                            <div className="flex items-start justify-between w-full">
                                <span className="font-bold text-gray-800 dark:text-gray-200 text-sm group-hover:text-indigo-400 transition-colors">
                                    {sym.name}
                                </span>
                                <span className="font-mono text-[10px] text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">
                                    {sym.triad}
                                </span>
                            </div>
                            
                            <div className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2">
                                {typeof sym.role === 'string' ? sym.role : 'Invalid role data'}
                            </div>

                            <div className="flex items-center gap-2 mt-1">
                                <span className="text-[10px] font-mono text-gray-400 bg-gray-100 dark:bg-gray-800 px-1.5 rounded">
                                    {sym.id}
                                </span>
                                {sym.symbol_tag && (
                                     <span className="text-[10px] font-mono text-indigo-400 bg-indigo-900/20 px-1.5 rounded border border-indigo-900/30">
                                        #{sym.symbol_tag}
                                     </span>
                                )}
                            </div>
                        </button>
                    ))}
                    
                    {/* Pagination Controls */}
                    <div className="flex items-center justify-center gap-4 pt-4 mt-4 border-t border-gray-100 dark:border-gray-800">
                        <button 
                            onClick={handlePrevPage}
                            disabled={currentPage === 0 || loading}
                            className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                            aria-label="Previous Page"
                        >
                            <ChevronLeft size={20} />
                        </button>
                        
                        <span className="text-xs font-mono text-gray-500">
                           {loading ? <Loader2 size={12} className="animate-spin inline" /> : `Page ${currentPage + 1}`}
                        </span>

                        <button 
                            onClick={handleNextPage}
                            disabled={!hasMore || loading}
                            className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                            aria-label="Next Page"
                        >
                            <ChevronRight size={20} />
                        </button>
                    </div>

                </div>
            ) : (
                <div className="flex flex-col items-center justify-center h-full text-gray-400">
                    <Shield size={48} className="mb-4 opacity-20" />
                    <p className="text-sm font-mono">No symbols found in this domain.</p>
                </div>
            )}
        </div>
      </div>
    </>
  );
};
