
import React, { useState, useEffect, useRef } from 'react';
import { ToggleLeft, ToggleRight, CloudDownload, Plus, Edit3, Loader2, ArrowRight, Download, Upload, Trash2, Settings, X, Shield, Tag, FileText, AlertTriangle, Database } from 'lucide-react';
import { domainService } from '../../services/domainService';
import { SymbolDef } from '../../types';
import { Header, HeaderProps } from '../Header';

interface SymbolStoreScreenProps {
  onBack: () => void;
  onNavigateToForge: (domain: string) => void;
  headerProps: Omit<HeaderProps, 'children'>;
}

interface ImportCandidate {
    domainId: string;
    domainName: string;
    description: string;
    invariants: string[];
    symbols: SymbolDef[];
}

export const SymbolStoreScreen: React.FC<SymbolStoreScreenProps> = ({ onBack, onNavigateToForge, headerProps }) => {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Sync UI State
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [remoteDomains, setRemoteDomains] = useState<string[]>([]);
  const [loadingRemote, setLoadingRemote] = useState(false);
  const [syncingDomain, setSyncingDomain] = useState<string | null>(null);

  // Create UI State
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newDomainId, setNewDomainId] = useState('');
  const [newDomainName, setNewDomainName] = useState('');
  const [newDomainDesc, setNewDomainDesc] = useState('');
  const [newDomainInvariants, setNewDomainInvariants] = useState<string[]>([]);
  const [newInvariantInputCreate, setNewInvariantInputCreate] = useState('');

  // Settings UI State
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [editingDomainId, setEditingDomainId] = useState<string | null>(null);
  const [settingsName, setSettingsName] = useState('');
  const [settingsDescription, setSettingsDescription] = useState('');
  const [settingsInvariants, setSettingsInvariants] = useState<string[]>([]);
  const [newInvariantInput, setNewInvariantInput] = useState('');

  // Delete UI State
  const [deleteCandidate, setDeleteCandidate] = useState<string | null>(null);

  // Import UI State
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importCandidate, setImportCandidate] = useState<ImportCandidate | null>(null);

  const loadLocalData = async () => {
    setLoading(true);
    const meta = await domainService.getMetadata();
    setItems(meta);
    setLoading(false);
  };

  useEffect(() => {
    loadLocalData();
  }, []);

  const handleToggle = async (id: string, currentState: boolean) => {
    await domainService.toggleDomain(id, !currentState);
    loadLocalData();
  };

  const calculateSize = async (id: string) => {
     const symbols = await domainService.getSymbols(id);
     const json = JSON.stringify(symbols);
     return (json.length / 1024).toFixed(2) + ' KB';
  };
  
  // UseEffect hack to display sizes after load? No, simplest is to display count which is available.
  // For size, we can't easily sync display in the map. Removing size calc from direct render or make it async state.
  // For simplicity in this refactor, removing dynamic size calc or just showing "N/A" if heavy.
  // Actually getMetadata returns count, let's stick to count.

  // --- Sync Logic ---

  const openSyncModal = async () => {
      setIsSyncModalOpen(true);
      setLoadingRemote(true);
      try {
          const res = await fetch('https://api.signal-zero.ai/domains');
          if (res.ok) {
              const data = await res.json();
              setRemoteDomains(data);
          }
      } catch (e) {
          console.error("Remote domain fetch failed", e);
      } finally {
          setLoadingRemote(false);
      }
  };

  const handleSyncDomain = async (domain: string) => {
      setSyncingDomain(domain);
      try {
          // Fetch all symbols (up to reasonable limit)
          const res = await fetch(`https://api.signal-zero.ai/symbol?symbol_domain=${domain}&limit=1000`);
          if (!res.ok) throw new Error("Sync failed");
          
          const data = await res.json();
          const symbols = data.items || data || [];

          await domainService.bulkUpsert(domain, symbols);
          loadLocalData();
          setIsSyncModalOpen(false);
      } catch (e) {
          alert("Failed to sync domain: " + String(e));
      } finally {
          setSyncingDomain(null);
      }
  };

  // --- Create Logic ---

  const handleAddInvariantCreate = () => {
      if (newInvariantInputCreate.trim()) {
          setNewDomainInvariants(prev => [...prev, newInvariantInputCreate.trim()]);
          setNewInvariantInputCreate('');
      }
  };

  const handleRemoveInvariantCreate = (index: number) => {
      setNewDomainInvariants(prev => prev.filter((_, i) => i !== index));
  };

  const handleCreateDomain = async () => {
      if (!newDomainId.trim()) return;
      
      const id = newDomainId.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
      const name = newDomainName.trim() || id;

      // Initialize empty domain in cache
      await domainService.bulkUpsert(id, []);
      // Update metadata
      await domainService.updateDomainMetadata(id, {
          name: name,
          description: newDomainDesc,
          invariants: newDomainInvariants
      });

      loadLocalData();
      setIsCreateModalOpen(false);
      
      // Reset
      setNewDomainId('');
      setNewDomainName('');
      setNewDomainDesc('');
      setNewDomainInvariants([]);

      onNavigateToForge(id);
  };

  // --- Settings Logic ---

  const openSettingsModal = (domain: any) => {
      setEditingDomainId(domain.id);
      setSettingsName(domain.name || domain.id);
      setSettingsDescription(domain.description || '');
      setSettingsInvariants(domain.invariants || []);
      setNewInvariantInput('');
      setIsSettingsModalOpen(true);
  };

  const handleAddInvariant = () => {
      if (newInvariantInput.trim()) {
          setSettingsInvariants(prev => [...prev, newInvariantInput.trim()]);
          setNewInvariantInput('');
      }
  };

  const handleRemoveInvariant = (index: number) => {
      setSettingsInvariants(prev => prev.filter((_, i) => i !== index));
  };

  const handleSaveSettings = async () => {
      if (editingDomainId) {
          await domainService.updateDomainMetadata(editingDomainId, {
              name: settingsName,
              description: settingsDescription,
              invariants: settingsInvariants
          });
          loadLocalData();
          setIsSettingsModalOpen(false);
          setEditingDomainId(null);
      }
  };

  // --- Delete Logic ---

  const handleDeleteRequest = (domainId: string) => {
      setDeleteCandidate(domainId);
  };

  const handleConfirmDelete = async () => {
      if (deleteCandidate) {
          await domainService.deleteDomain(deleteCandidate);
          loadLocalData();
          setDeleteCandidate(null);
      }
  };

  // --- Export Logic ---

  const handleExportDomain = async (domainId: string) => {
      const symbols = await domainService.getSymbols(domainId);
      // Get current metadata
      const allMeta = await domainService.getMetadata();
      const current = allMeta.find(m => m.id === domainId);

      const data = {
          domain: domainId,
          name: current?.name || domainId,
          exported_at: new Date().toISOString(),
          count: symbols.length,
          description: current?.description || "",
          invariants: current?.invariants || [],
          items: symbols
      };

      const jsonString = JSON.stringify(data, null, 2);
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      
      link.href = url;
      link.download = `signalzero_domain_${domainId}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
  };

  // --- Import Logic ---

  const handleImportClick = () => {
      fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      
      console.group("File Import Operation");
      console.log(`Reading file: ${file.name} (${file.size} bytes)`);

      const reader = new FileReader();
      reader.onload = (event) => {
          try {
              const text = event.target?.result as string;
              console.log("File content read successfully. Parsing JSON...");
              
              const json = JSON.parse(text);
              
              let domainId = '';
              let domainName = '';
              let symbols: SymbolDef[] = [];
              let description = '';
              let invariants: string[] = [];

              if (Array.isArray(json)) {
                  // Direct array import
                  console.log("Format detected: Direct Symbol Array");
                  symbols = json;
                  // Try to infer domain from first symbol
                  if (symbols.length > 0 && symbols[0].symbol_domain) {
                      domainId = symbols[0].symbol_domain;
                  } else {
                      domainId = file.name.replace('.json', '').replace('signalzero_domain_', '');
                  }
              } else if (json.items && Array.isArray(json.items)) {
                  // Exported format
                  console.log("Format detected: SignalZero Export Object");
                  symbols = json.items;
                  domainId = json.domain || file.name.replace('.json', '');
                  domainName = json.name || domainId;
                  description = json.description || '';
                  invariants = json.invariants || [];
              } else {
                  throw new Error("Invalid JSON format. Expected array or object with 'items'.");
              }

              if (!domainId) domainId = 'imported_domain';

              // Normalize domain ID
              domainId = domainId.toLowerCase().replace(/[^a-z0-9-_]/g, '-');
              if (!domainName) domainName = domainId;
              
              console.log(`Target Domain ID: ${domainId}`);
              console.log(`Target Domain Name: ${domainName}`);
              console.log(`Symbol Count: ${symbols.length}`);

              // SANITIZATION STEP
              const sanitizedSymbols = symbols.map(s => {
                  const copy = { ...s };
                  if (!copy.kind) copy.kind = 'pattern';
                  if (!copy.facets) {
                      copy.facets = {
                          function: 'unknown',
                          topology: 'linear',
                          commit: 'ledger',
                          temporal: 'instant',
                          gate: [],
                          substrate: ['symbolic'],
                          invariants: []
                      };
                  }
                  if (copy.kind === 'lattice') {
                      if (!copy.lattice) {
                          copy.lattice = {
                              topology: 'inductive',
                              closure: 'loop',
                              members: []
                          };
                      } else {
                          if (!copy.lattice.members) copy.lattice.members = [];
                      }
                  }
                  if (copy.kind === 'persona') {
                      if (!copy.persona) {
                          copy.persona = {
                              recursion_level: 'root',
                              function: copy.role || 'Agent',
                              activation_conditions: [],
                              fallback_behavior: [],
                              linked_personas: []
                          };
                      } else {
                          if (!copy.persona.activation_conditions) copy.persona.activation_conditions = [];
                          if (!copy.persona.fallback_behavior) copy.persona.fallback_behavior = [];
                          if (!copy.persona.linked_personas) copy.persona.linked_personas = [];
                      }
                  }
                  if (!copy.linked_patterns) copy.linked_patterns = [];
                  return copy;
              });

              setImportCandidate({
                  domainId,
                  domainName,
                  description,
                  invariants,
                  symbols: sanitizedSymbols
              });

          } catch (err) {
              console.error("Import Error:", err);
              alert("Failed to import file: " + String(err));
          } finally {
              console.groupEnd();
              if (fileInputRef.current) fileInputRef.current.value = '';
          }
      };
      reader.readAsText(file);
  };

  const handleConfirmImport = async () => {
      if (!importCandidate) return;

      const { domainId, domainName, description, invariants, symbols } = importCandidate;
      
      console.log(`Confirmed import for ${domainId}`);
      await domainService.bulkUpsert(domainId, symbols);
      await domainService.updateDomainMetadata(domainId, { name: domainName, description, invariants });
      
      loadLocalData();
      setImportCandidate(null);
  };

  return (
    <div className="flex flex-col h-full bg-gray-50 dark:bg-gray-950 font-sans">
      
      <input type="file" ref={fileInputRef} onChange={handleFileChange} accept=".json" className="hidden" />

      <Header {...headerProps}>
         <div className="flex items-center gap-2">
             <button 
                onClick={handleImportClick}
                className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-md text-xs font-mono font-bold transition-colors border border-gray-200 dark:border-gray-700"
                title="Import JSON file"
             >
                 <Upload size={14} /> Import
             </button>
             <button 
                onClick={openSyncModal}
                className="flex items-center gap-2 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-md text-xs font-mono font-bold transition-colors"
             >
                 <CloudDownload size={14} /> Sync
             </button>
             <button 
                onClick={() => setIsCreateModalOpen(true)}
                className="flex items-center gap-2 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-md text-xs font-mono font-bold transition-colors"
             >
                 <Plus size={14} /> Create
             </button>
         </div>
      </Header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto space-y-4">
            
            <div className="bg-blue-50 dark:bg-blue-900/10 border border-blue-200 dark:border-blue-800 p-4 rounded-lg flex items-start gap-3">
                <Database size={20} className="text-blue-500 mt-0.5 shrink-0" />
                <div className="text-sm text-blue-800 dark:text-blue-200">
                    <strong className="block mb-1 font-mono uppercase text-xs">Redis Architecture</strong>
                    The AI tools now operate exclusively on the Redis cache (Upstash). Sync from cloud, Import JSON backups, or Create domains for local development.
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {items.length === 0 && !loading && (
                    <div className="col-span-full text-center py-12 text-gray-400 font-mono text-sm border-2 border-dashed border-gray-200 dark:border-gray-800 rounded-lg">
                        No cached domains found. <br/>
                        <button onClick={openSyncModal} className="text-indigo-500 hover:underline mt-2">Sync from Cloud</button>, <button onClick={handleImportClick} className="text-indigo-500 hover:underline">Import File</button>, or create a new one.
                    </div>
                )}

                {items.map((item) => (
                    <div key={item.id} className={`relative p-5 rounded-lg border transition-all flex flex-col justify-between group ${
                        item.enabled 
                        ? 'bg-white dark:bg-gray-900 border-emerald-500/30 shadow-sm' 
                        : 'bg-gray-100 dark:bg-gray-900/50 border-gray-200 dark:border-gray-800 opacity-75'
                    }`}>
                        <div>
                            <div className="flex justify-between items-start mb-4">
                                <div className="min-w-0">
                                    <h3 className="font-bold font-mono text-gray-900 dark:text-gray-100 truncate max-w-[150px]" title={item.name}>{item.name}</h3>
                                    <div className="text-[10px] text-gray-400 font-mono mt-0.5 truncate max-w-[150px]">{item.id}</div>
                                    <div className="text-[10px] text-gray-500 mt-1">
                                        Cached: {new Date(item.lastUpdated).toLocaleDateString()}
                                    </div>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            openSettingsModal(item);
                                        }}
                                        className="p-1.5 text-gray-400 hover:text-indigo-500 dark:hover:text-indigo-400 transition-colors"
                                        title="Domain Settings"
                                    >
                                        <Settings size={16} />
                                    </button>
                                    <button
                                        onClick={() => handleExportDomain(item.id)}
                                        className="p-1.5 text-gray-400 hover:text-indigo-500 dark:hover:text-indigo-400 transition-colors"
                                        title="Export Domain JSON"
                                    >
                                        <Download size={16} />
                                    </button>
                                    <button 
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleDeleteRequest(item.id);
                                        }} 
                                        className="p-1.5 text-gray-400 hover:text-red-500 transition-colors"
                                        title="Delete Domain"
                                    >
                                        <Trash2 size={16} />
                                    </button>
                                    <button 
                                        onClick={() => handleToggle(item.id, item.enabled)}
                                        className={`transition-colors p-1 ${item.enabled ? 'text-emerald-500 hover:text-emerald-600' : 'text-gray-400 hover:text-gray-600'}`}
                                        title={item.enabled ? "Disable for AI Tools" : "Enable for AI Tools"}
                                    >
                                        {item.enabled ? <ToggleRight size={28} /> : <ToggleLeft size={28} />}
                                    </button>
                                </div>
                            </div>

                            <div className="flex items-center gap-4 text-xs font-mono text-gray-600 dark:text-gray-400 border-t border-gray-100 dark:border-gray-800 pt-3">
                                <div>
                                    <span className="block text-[10px] text-gray-400 uppercase">Symbols</span>
                                    <span className="font-bold text-lg">{item.count}</span>
                                </div>
                                <div>
                                    {/* Removed Size calculation for simplicity in Redis migration */}
                                </div>
                            </div>
                            
                            {item.description && (
                                <div className="mt-3 text-xs text-gray-500 line-clamp-2">
                                    {item.description}
                                </div>
                            )}
                        </div>
                        
                        <button 
                            onClick={() => onNavigateToForge(item.id)}
                            className="mt-4 w-full py-2 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 rounded text-xs font-mono font-bold flex items-center justify-center gap-2 transition-colors opacity-0 group-hover:opacity-100"
                        >
                            <Edit3 size={12} /> Open in Forge
                        </button>
                    </div>
                ))}
            </div>
        </div>
      </div>

      {/* Sync Modal */}
      {isSyncModalOpen && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
              <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl max-w-md w-full overflow-hidden border border-gray-200 dark:border-gray-800">
                  <div className="p-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950 flex justify-between items-center">
                      <h3 className="font-bold font-mono">Sync Domain from Cloud</h3>
                      <button onClick={() => setIsSyncModalOpen(false)}><ArrowRight size={20}/></button>
                  </div>
                  <div className="max-h-[300px] overflow-y-auto p-2">
                      {loadingRemote ? (
                          <div className="p-8 flex justify-center"><Loader2 className="animate-spin text-gray-400"/></div>
                      ) : (
                          remoteDomains.map(d => (
                              <button
                                key={d}
                                onClick={() => handleSyncDomain(d)}
                                disabled={!!syncingDomain}
                                className="w-full text-left p-3 hover:bg-gray-100 dark:hover:bg-gray-800 rounded flex justify-between items-center font-mono text-sm"
                              >
                                  {d}
                                  {syncingDomain === d ? <Loader2 size={16} className="animate-spin"/> : <CloudDownload size={16} className="text-gray-400"/>}
                              </button>
                          ))
                      )}
                  </div>
              </div>
          </div>
      )}

      {/* Create Modal */}
      {isCreateModalOpen && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
              <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl max-w-md w-full p-6 border border-gray-200 dark:border-gray-800 flex flex-col max-h-[90vh] overflow-hidden">
                  <h3 className="font-bold font-mono mb-4 text-emerald-500 flex items-center gap-2">
                      <Plus size={18} /> Create Local Domain
                  </h3>
                  
                  <div className="overflow-y-auto space-y-4 pr-2">
                      <div className="space-y-1">
                          <label className="text-xs font-bold uppercase tracking-wider text-gray-500 font-mono">Domain ID (Slug)</label>
                          <input 
                            className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-2 font-mono text-sm focus:outline-none focus:border-emerald-500"
                            placeholder="e.g. project-alpha"
                            value={newDomainId}
                            onChange={e => setNewDomainId(e.target.value)}
                          />
                      </div>
                      <div className="space-y-1">
                          <label className="text-xs font-bold uppercase tracking-wider text-gray-500 font-mono">Display Name</label>
                          <input 
                            className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-2 text-sm focus:outline-none focus:border-emerald-500"
                            placeholder="e.g. Project Alpha"
                            value={newDomainName}
                            onChange={e => setNewDomainName(e.target.value)}
                          />
                      </div>
                      <div className="space-y-1">
                          <label className="text-xs font-bold uppercase tracking-wider text-gray-500 font-mono">Description</label>
                          <textarea 
                              value={newDomainDesc}
                              onChange={e => setNewDomainDesc(e.target.value)}
                              placeholder="Purpose of this domain..."
                              rows={2}
                              className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-2 text-sm focus:outline-none focus:border-emerald-500"
                          />
                      </div>
                      <div className="space-y-1">
                           <label className="text-xs font-bold uppercase tracking-wider text-gray-500 font-mono flex items-center gap-2">
                               <Shield size={12} /> Invariants
                           </label>
                           <div className="flex gap-2">
                               <input 
                                  value={newInvariantInputCreate}
                                  onChange={e => setNewInvariantInputCreate(e.target.value)}
                                  onKeyDown={e => e.key === 'Enter' && handleAddInvariantCreate()}
                                  placeholder="Add invariant..."
                                  className="flex-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-2 text-xs font-mono focus:outline-none focus:border-emerald-500"
                               />
                               <button 
                                  onClick={handleAddInvariantCreate}
                                  className="px-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-bold