
import React, { useState, useEffect, useRef } from 'react';
import { Save, Plus, ChevronRight, Check, AlertTriangle, Loader2, Sparkles, MessageSquarePlus, Trash2, GitMerge, Layout, Box, ArrowRightLeft, X, User, UserCog, Repeat } from 'lucide-react';
import { domainService } from '../../services/domainService';
import { SymbolDef, SymbolFacet } from '../../types';
import { generateSymbolSynthesis, generatePersonaConversion, generateLatticeConversion, generateRefactor } from '../../services/gemini';
import { Header, HeaderProps } from '../Header';

interface SymbolDevScreenProps {
    onBack: () => void;
    initialDomain?: string | null;
    initialSymbol?: SymbolDef | null;
    headerProps: Omit<HeaderProps, 'children'>;
}

const DEFAULT_PATTERN: SymbolDef = {
    id: 'SZ:NEW-PATTERN-001',
    name: 'New Pattern',
    kind: 'pattern',
    triad: '⟐⇌⟐',
    role: '',
    macro: '',
    symbol_domain: 'root',
    symbol_tag: 'draft',
    facets: {
        function: 'diagnose',
        topology: 'linear',
        commit: 'ledger',
        temporal: 'instant',
        gate: [],
        substrate: ['symbolic'],
        invariants: []
    },
    failure_mode: '',
    linked_patterns: []
};

const DEFAULT_LATTICE: SymbolDef = {
    id: 'SZ:NEW-LATTICE-001',
    name: 'New Lattice',
    kind: 'lattice',
    triad: '⟐≡⟐',
    role: '',
    macro: '', // Lattices don't strictly use macro, they use lattice def
    lattice: {
        topology: 'inductive',
        closure: 'loop',
        members: []
    },
    symbol_domain: 'root',
    symbol_tag: 'draft',
    facets: { // Minimal facets for lattice
        function: 'orchestrate',
        topology: 'lattice',
        commit: 'recursive',
        temporal: 'flow',
        gate: [],
        substrate: ['symbolic'],
        invariants: []
    },
    failure_mode: '',
    linked_patterns: []
};

const DEFAULT_PERSONA: SymbolDef = {
    id: 'SZ:NEW-PERSONA-001',
    name: 'New Persona',
    kind: 'persona',
    triad: '⟐⟐⟐',
    role: 'Persona Agent',
    macro: '',
    symbol_domain: 'root',
    symbol_tag: 'persona',
    facets: {
        function: 'interact',
        topology: 'recursive',
        commit: 'memory',
        temporal: 'narrative',
        gate: [],
        substrate: ['persona'],
        invariants: []
    },
    persona: {
        recursion_level: 'root',
        function: '',
        activation_conditions: [],
        fallback_behavior: [],
        linked_personas: []
    },
    failure_mode: '',
    linked_patterns: []
};


const INPUT_STYLE = "w-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none transition-all text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500";

const Label = ({ children }: { children: React.ReactNode }) => (
    <label className="text-xs font-bold uppercase tracking-wider text-gray-500 font-mono block mb-1">
        {children}
    </label>
);

const AutoResizeTextarea = ({ value, onChange, className, placeholder, rows = 2, disabled, ...props }: any) => {
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = 'auto';
            textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
        }
    }, [value]);

    return (
        <textarea
            ref={textareaRef}
            value={value}
            onChange={onChange}
            rows={rows}
            placeholder={placeholder}
            disabled={disabled}
            className={`${className} resize-none overflow-hidden block`}
            {...props}
        />
    );
};

// Helper to safely join arrays even if data is malformed (e.g. string or undefined)
const safeJoin = (arr: any, sep: string) => {
    if (Array.isArray(arr)) {
        // Ensure all elements are strings
        return arr.map(item => typeof item === 'object' ? (item.id || JSON.stringify(item)) : String(item)).join(sep);
    }
    return '';
};

// Ensure data integrity for Editor state
const sanitizeForEditor = (raw: any): SymbolDef => {
    const copy = JSON.parse(JSON.stringify(raw));
    
    // Top Level Strings - Ensure empty string if missing
    copy.name = copy.name || '';
    copy.triad = copy.triad || '';
    copy.role = copy.role || '';
    copy.macro = copy.macro || '';
    copy.symbol_tag = copy.symbol_tag || '';
    copy.failure_mode = copy.failure_mode || '';
    copy.kind = copy.kind || 'pattern';
    
    // Arrays
    copy.linked_patterns = copy.linked_patterns || [];

    // Facets
    if (!copy.facets) copy.facets = {};
    copy.facets.function = copy.facets.function || '';
    copy.facets.topology = copy.facets.topology || '';
    copy.facets.commit = copy.facets.commit || '';
    copy.facets.temporal = copy.facets.temporal || '';
    copy.facets.gate = copy.facets.gate || [];
    copy.facets.substrate = copy.facets.substrate || [];
    copy.facets.invariants = copy.facets.invariants || [];

    // Lattice Specific
    if (copy.kind === 'lattice') {
        if (!copy.lattice) copy.lattice = {};
        // For dropdowns, defaults are acceptable, but for text/lists ensure empty
        copy.lattice.topology = copy.lattice.topology || 'inductive';
        copy.lattice.closure = copy.lattice.closure || 'loop';
        copy.lattice.members = copy.lattice.members || [];
    }

    // Persona Specific
    if (copy.kind === 'persona') {
        if (!copy.persona) copy.persona = {};
        copy.persona.recursion_level = copy.persona.recursion_level || 'root';
        copy.persona.function = copy.persona.function || '';
        copy.persona.activation_conditions = copy.persona.activation_conditions || [];
        copy.persona.fallback_behavior = copy.persona.fallback_behavior || [];
        copy.persona.linked_personas = copy.persona.linked_personas || [];
    }

    return copy as SymbolDef;
};

// --- Drag & Drop Relationship Component ---
const SymbolRelationshipField = ({
    items,
    onChange,
    placeholder
}: {
    items: any[] | undefined,
    onChange: (newItems: string[]) => void,
    placeholder: string
}) => {
    const safeItems = Array.isArray(items) ? items : [];

    const handleRemove = (indexToRemove: number) => {
        // Filter and ensure we pass back strings
        const newItems = safeItems
            .filter((_, idx) => idx !== indexToRemove)
            .map(item => typeof item === 'object' ? (item.id || JSON.stringify(item)) : String(item));
        onChange(newItems);
    };

    const handleDrop = (e: React.DragEvent) => {
        e.preventDefault();
        const symbolId = e.dataTransfer.getData("text/plain");
        if (symbolId) {
            // Check existence using string comparison
            const exists = safeItems.some(item => {
                const idStr = typeof item === 'object' ? item.id : item;
                return idStr === symbolId;
            });

            if (!exists) {
                // Ensure we preserve existing structure but add new ID string
                const newItems = [
                    ...safeItems.map(item => typeof item === 'object' ? (item.id || JSON.stringify(item)) : String(item)),
                    symbolId
                ];
                onChange(newItems);
            }
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        e.preventDefault(); // Essential to allow dropping
    };

    return (
        <div
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            className="min-h-[60px] w-full bg-gray-50 dark:bg-gray-900/50 border-2 border-dashed border-gray-200 dark:border-gray-700 rounded-lg p-2 transition-colors hover:border-indigo-400 dark:hover:border-indigo-600"
        >
            {safeItems.length === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-gray-400 italic pointer-events-none">
                    {placeholder} (Drag symbols here)
                </div>
            ) : (
                <div className="flex flex-wrap gap-2">
                    {safeItems.map((item, idx) => {
                        // Safe render for objects
                        const display = typeof item === 'object' ? (item.id || "Invalid Obj") : item;
                        return (
                            <div key={`${display}-${idx}`} className="flex items-center gap-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded px-2 py-1 shadow-sm group">
                                <span className="text-[10px] font-mono text-gray-700 dark:text-gray-300">{display}</span>
                                <button
                                    onClick={() => handleRemove(idx)}
                                    className="text-gray-400 hover:text-red-500 transition-colors"
                                >
                                    <X size={12} />
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};


export const SymbolDevScreen: React.FC<SymbolDevScreenProps> = ({ onBack, initialDomain, initialSymbol, headerProps }) => {
    // --- State ---
    const [domains, setDomains] = useState<string[]>([]);
    const [selectedDomain, setSelectedDomain] = useState<string>('');

    const [symbolList, setSymbolList] = useState<any[]>([]);

    const [currentSymbol, setCurrentSymbol] = useState<SymbolDef>(DEFAULT_PATTERN);
    const [originalId, setOriginalId] = useState<string | null>(null);

    const [isDirty, setIsDirty] = useState(false);
    const [saveMessage, setSaveMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);

    // Synthesis State
    const [synthesisInput, setSynthesisInput] = useState("");
    const [isSynthesizing, setIsSynthesizing] = useState(false);
    const [synthMode, setSynthMode] = useState<'create' | 'refactor'>('create');

    // Conversion State
    const [isConverting, setIsConverting] = useState(false);

    // Delete State
    const [deleteSymbolId, setDeleteSymbolId] = useState<string | null>(null);

    // Conversion State
    const [isConvertModalOpen, setIsConvertModalOpen] = useState(false);
    const [convertConfig, setConvertConfig] = useState({
        newId: '',
        topology: 'inductive',
        closure: 'loop',
        members: [] as string[]
    });

    // --- Effects ---

    // Load Domains from Local Cache
    useEffect(() => {
        const fetchDomains = async () => {
            const localDomains = await domainService.listDomains();
            setDomains(localDomains.sort());

            // Determine Domain selection
            let targetDomain = selectedDomain;

            if (initialSymbol?.symbol_domain && localDomains.includes(initialSymbol.symbol_domain)) {
                targetDomain = initialSymbol.symbol_domain;
            } else if (initialDomain && localDomains.includes(initialDomain)) {
                targetDomain = initialDomain;
            } else if (localDomains.length > 0 && !selectedDomain) {
                targetDomain = localDomains[0];
            }

            if (targetDomain) setSelectedDomain(targetDomain);
        };
        fetchDomains();
    }, [initialDomain, initialSymbol]);

    // Hydrate Symbol
    useEffect(() => {
        const hydrate = async () => {
             if (initialSymbol) {
                // Check if it's a known ID to set originalID
                const exists = await domainService.findById(initialSymbol.id);
                
                // If it exists, use the stored version to ensure we edit the source of truth
                // If it's a candidate (not in store), use the passed object but sanitize it
                const source = exists || initialSymbol;
                
                const sanitized = sanitizeForEditor(source);
                setCurrentSymbol(sanitized);

                if (exists) {
                    setOriginalId(exists.id);
                    setIsDirty(false);
                } else {
                    setOriginalId(null); // New Candidate
                    setIsDirty(true); // Needs save
                    setSaveMessage({ type: 'success', text: 'Candidate Loaded from Chat' });
                }
            }
        };
        hydrate();
    }, [initialSymbol]);

    // Load Symbols from Cache when domain changes
    useEffect(() => {
        const fetchSymbols = async () => {
            if (!selectedDomain) return;
            // Pure Local Load
            const cached = await domainService.getSymbols(selectedDomain);
            setSymbolList(cached);
        };
        fetchSymbols();
    }, [selectedDomain]);

    // --- Handlers ---

    const handleDragStart = (e: React.DragEvent, id: string) => {
        e.dataTransfer.setData("text/plain", id);
        e.dataTransfer.effectAllowed = "copy";
    };

    const handleSelectSymbol = async (id: string) => {
        if (isDirty) {
            if (!window.confirm("You have unsaved changes. Discard them?")) return;
        }

        setSaveMessage(null);

        const cached = await domainService.findById(id);
        if (cached) {
            const sanitized = sanitizeForEditor(cached);
            setCurrentSymbol(sanitized);
            setOriginalId(cached.id);
            setIsDirty(false);
        } else {
            alert("Symbol not found in store.");
        }
    };

    const handleNewPattern = () => {
        if (isDirty) {
            if (!window.confirm("You have unsaved changes. Discard them?")) return;
        }
        setSaveMessage(null);

        setCurrentSymbol({
            ...DEFAULT_PATTERN,
            symbol_domain: selectedDomain || 'root',
            id: `SZ:${(selectedDomain || 'NEW').toUpperCase()}-PAT-001`
        });
        setOriginalId(null);
        setIsDirty(false);
    };

    const handleNewLattice = () => {
        if (isDirty) {
            if (!window.confirm("You have unsaved changes. Discard them?")) return;
        }
        setSaveMessage(null);

        setCurrentSymbol({
            ...DEFAULT_LATTICE,
            symbol_domain: selectedDomain || 'root',
            id: `SZ:${(selectedDomain || 'NEW').toUpperCase()}-LAT-001`
        });
        setOriginalId(null);
        setIsDirty(false);
    };

    const handleNewPersona = () => {
        if (isDirty) {
            if (!window.confirm("You have unsaved changes. Discard them?")) return;
        }
        setSaveMessage(null);

        setCurrentSymbol({
            ...DEFAULT_PERSONA,
            symbol_domain: selectedDomain || 'root',
            id: `SZ:${(selectedDomain || 'NEW').toUpperCase()}-PER-001`
        });
        setOriginalId(null);
        setIsDirty(false);
    };

    const requestDeleteSymbol = (id: string) => {
        setDeleteSymbolId(id);
    };

    const confirmDeleteSymbol = async () => {
        if (!deleteSymbolId) return;

        const idToDelete = deleteSymbolId;
        // CASCADE DELETE: Remove this symbol from other linked patterns
        await domainService.deleteSymbol(selectedDomain, idToDelete, true);

        // Refresh list
        const updatedList = await domainService.getSymbols(selectedDomain);
        setSymbolList(updatedList);

        // If deleted symbol was selected, reset without confirmation since it's gone
        if (currentSymbol.id === idToDelete) {
            setSaveMessage(null);
            handleNewPattern();
        }

        setDeleteSymbolId(null);
    };

    const handleConvertToLattice = async () => {
        setIsConverting(true); // Start loading state

        try {
            // Use AI to synthesize the lattice definition
            const resultText = await generateLatticeConversion(currentSymbol);

            const match = resultText.match(/<sz_symbol>([\s\S]*?)<\/sz_symbol>/);
            if (match && match[1]) {
                const cleanJson = match[1].replace(/```json\n?|```/g, '').trim();
                const newLattice = JSON.parse(cleanJson);

                // Normalize members to string array
                let members = newLattice.lattice?.members || [];
                if (Array.isArray(members)) {
                    members = members.map((m: any) => typeof m === 'object' ? m.id : String(m));
                }

                // Fallback to linked_patterns if members empty
                if (!members || members.length === 0) {
                    members = currentSymbol.linked_patterns || [];
                }
                // Ensure linked_patterns is also normalized
                if (Array.isArray(members)) {
                    members = members.map((m: any) => typeof m === 'object' ? m.id : String(m));
                }

                setConvertConfig({
                    newId: newLattice.id || (originalId || currentSymbol.id).replace('PAT', 'LAT') + '-LAT',
                    topology: newLattice.lattice?.topology || 'inductive',
                    closure: newLattice.lattice?.closure || 'loop',
                    members: members
                });
                setIsConvertModalOpen(true);
            } else {
                throw new Error("Invalid model response for lattice conversion");
            }
        } catch (e) {
            console.error("Conversion synth failed", e);
            // Fallback to manual defaults
            const oldId = originalId || currentSymbol.id;
            const newId = oldId.includes('PAT')
                ? oldId.replace('PAT', 'LAT')
                : `${oldId}-LAT`;

            // Normalize linked_patterns
            const members = (currentSymbol.linked_patterns || []).map((m: any) => typeof m === 'object' ? m.id : String(m));

            setConvertConfig({
                newId,
                topology: 'inductive',
                closure: 'loop',
                // Populate from current links by default on manual fallback
                members: members
            });
            setIsConvertModalOpen(true);
        } finally {
            setIsConverting(false);
        }
    };

    const handleConvertToPersona = async () => {
        const oldId = originalId || currentSymbol.id;
        setIsConverting(true);
        try {
            const resultText = await generatePersonaConversion(currentSymbol);

            // Parse out the <sz_symbol> block
            const match = resultText.match(/<sz_symbol>([\s\S]*?)<\/sz_symbol>/);
            if (match && match[1]) {
                const cleanJson = match[1].replace(/```json\n?|```/g, '').trim();
                const newPersona = JSON.parse(cleanJson);

                if (!newPersona.id) throw new Error("Generated Persona missing ID");

                // 1. Propagate Rename (Links to old ID should now point to new ID)
                await domainService.propagateRename(currentSymbol.symbol_domain, oldId, newPersona.id);

                // 2. Delete old symbol (non-cascading)
                await domainService.deleteSymbol(currentSymbol.symbol_domain, oldId, false);

                // 3. Upsert New Persona
                await domainService.upsertSymbol(currentSymbol.symbol_domain, newPersona);

                // 4. Update UI
                const updatedList = await domainService.getSymbols(currentSymbol.symbol_domain);
                setSymbolList(updatedList);
                
                const sanitized = sanitizeForEditor(newPersona);
                setCurrentSymbol(sanitized);
                setOriginalId(sanitized.id);
                
                setIsDirty(false);
                setSaveMessage({ type: 'success', text: 'Converted to Persona' });

            } else {
                throw new Error("Failed to parse synthesis response");
            }
        } catch (e) {
            alert("Persona conversion failed: " + String(e));
        } finally {
            setIsConverting(false);
        }
    };

    const confirmConversion = async () => {
        const oldId = originalId || currentSymbol.id;

        const newLatticeSymbol: SymbolDef = {
            ...currentSymbol,
            id: convertConfig.newId,
            kind: 'lattice',
            role: 'lattice', // Set role per request
            lattice: {
                topology: convertConfig.topology as any,
                closure: convertConfig.closure as any,
                members: convertConfig.members // Use synthesized members
            },
            // Clear linked_patterns as they have moved to members
            linked_patterns: [],
            // Merge facets but ensure lattice defaults are applied where relevant
            facets: {
                ...currentSymbol.facets,
                function: 'orchestrate',
                topology: 'lattice'
            }
        };

        try {
            // 1. Propagate Rename: Update existing links to point to new ID
            await domainService.propagateRename(currentSymbol.symbol_domain, oldId, convertConfig.newId);

            // 2. Delete old (NO CASCADE, because we just updated the links)
            await domainService.deleteSymbol(currentSymbol.symbol_domain, oldId, false);

            // 3. Save new
            await domainService.upsertSymbol(currentSymbol.symbol_domain, newLatticeSymbol);

            // 4. Update UI
            const updatedList = await domainService.getSymbols(currentSymbol.symbol_domain);
            setSymbolList(updatedList);

            setCurrentSymbol(sanitizeForEditor(newLatticeSymbol));
            setOriginalId(convertConfig.newId);
            setIsDirty(false);
            setSaveMessage({ type: 'success', text: 'Converted to Lattice' });
            setIsConvertModalOpen(false);

        } catch (e) {
            console.error(e);
            alert("Conversion failed: " + String(e));
        }
    };

    const handleSynthesis = async () => {
        if (!synthesisInput.trim()) return;
        setIsSynthesizing(true);

        try {
            if (synthMode === 'create') {
                // --- CREATE MODE ---
                if (isDirty) {
                    if (!window.confirm("Synthesizing will replace current editor content with a new symbol. Discard unsaved changes?")) {
                        setIsSynthesizing(false);
                        return;
                    }
                }

                // Pass current domain and list of existing symbols to give the AI context for linking
                const resultText = await generateSymbolSynthesis(synthesisInput, selectedDomain, symbolList);

                const match = resultText.match(/<sz_symbol>([\s\S]*?)<\/sz_symbol>/);
                if (match && match[1]) {
                    const cleanJson = match[1].replace(/```json\n?|```/g, '').trim();
                    const parsed = JSON.parse(cleanJson);

                    if (parsed.id) {
                        let baseDefault = DEFAULT_PATTERN;
                        if (parsed.kind === 'lattice') baseDefault = DEFAULT_LATTICE;
                        if (parsed.kind === 'persona') baseDefault = DEFAULT_PERSONA;

                        // Ensure base facets exist even if parsed ones are merged
                        const baseFacets = JSON.parse(JSON.stringify(baseDefault.facets));

                        // Merge synthesized props onto defaults, then sanitize
                        const merged = {
                            ...baseDefault,
                            ...parsed,
                            facets: { ...baseFacets, ...(parsed.facets || {}) },
                            lattice: parsed.lattice ? { ...baseDefault.lattice, ...parsed.lattice } : baseDefault.lattice,
                            persona: parsed.persona ? { ...baseDefault.persona, ...parsed.persona } : baseDefault.persona
                        };

                        const sanitized = sanitizeForEditor(merged);
                        setCurrentSymbol(sanitized);

                        setOriginalId(null);
                        setIsDirty(true);
                        setSynthesisInput("");
                        setSaveMessage({ type: 'success', text: 'Synthesized New Symbol' });
                    } else {
                        throw new Error("Generated JSON missing ID");
                    }
                } else {
                    throw new Error("Model response did not contain valid <sz_symbol> tags.");
                }

            } else {
                // --- REFACTOR MODE ---
                const response = await generateRefactor(synthesisInput, selectedDomain, symbolList);

                // Extract tool calls manually since we are using generateContent directly
                const calls = response.candidates?.[0]?.content?.parts
                    ?.filter(p => p.functionCall)
                    .map(p => p.functionCall);

                if (calls && calls.length > 0) {
                    const call = calls.find(c => c && c.name === 'bulk_update_symbols');
                    if (call && call.args && (call.args as any).updates) {
                        const updates = (call.args as any).updates as any[];

                        // --- LOGGING ---
                        console.group("Refactor Operation Logs");
                        console.log("Raw Payload:", updates);

                        updates.forEach((u: any) => {
                            const original = symbolList.find(s => s.id === u.old_id);
                            // Ensure we enforce domain on the new symbol before logging
                            const updatedSymbol = { ...u.symbol_data, symbol_domain: selectedDomain };

                            console.groupCollapsed(`Update: ${u.old_id} -> ${updatedSymbol.id}`);
                            console.log("BEFORE (Original):", original || "Symbol not found in current list");
                            console.log("AFTER (New):", updatedSymbol);
                            console.groupEnd();

                            // Mutate the update object for the actual processing step below
                            u.symbol_data = updatedSymbol;
                        });
                        console.groupEnd();
                        // ---------------

                        const results = await domainService.processRefactorOperation(updates);

                        // Refresh List
                        const updatedList = await domainService.getSymbols(selectedDomain);
                        setSymbolList(updatedList);

                        // If current symbol was modified, reload it or reset if deleted
                        // Simple approach: reload if ID matches or was renamed
                        // For now, let's just clear selection to be safe
                        handleNewPattern();

                        setSynthesisInput("");
                        setSaveMessage({ type: 'success', text: `Refactored ${results.count} symbols (${results.renamedIds.length} renamed).` });
                    } else {
                        throw new Error("Model did not call the bulk update tool correctly.");
                    }
                } else {
                    throw new Error("Model provided text instead of executing a refactor tool call.");
                }
            }
        } catch (e) {
            alert(`Operation failed: ${String(e)}`);
            console.error(e);
        } finally {
            setIsSynthesizing(false);
        }
    };

    const handleChange = (field: keyof SymbolDef, value: any) => {
        setCurrentSymbol(prev => ({ ...prev, [field]: value }));
        setIsDirty(true);
    };

    const handleFacetChange = (field: keyof SymbolFacet, value: any) => {
        setCurrentSymbol(prev => ({
            ...prev,
            facets: {
                ...(prev.facets || DEFAULT_PATTERN.facets),
                [field]: value
            }
        }));
        setIsDirty(true);
    };

    const handleLatticeChange = (field: string, value: any) => {
        if (!currentSymbol.lattice) return;
        setCurrentSymbol(prev => ({
            ...prev,
            lattice: {
                ...prev.lattice!,
                [field]: value
            }
        }));
        setIsDirty(true);
    }

    const handlePersonaChange = (field: string, value: any) => {
        if (!currentSymbol.persona) return;
        setCurrentSymbol(prev => ({
            ...prev,
            persona: {
                ...prev.persona!,
                [field]: value
            }
        }));
        setIsDirty(true);
    }

    const handleArrayChange = (
        parent: 'root' | 'facets' | 'lattice' | 'persona',
        field: string,
        value: string | string[]
    ) => {
        // Logic for tag component vs text input
        let array: string[] = [];
        if (Array.isArray(value)) {
            array = value;
        } else {
            array = value.split(',').map(s => s.trim()).filter(s => s);
        }

        if (parent === 'root') {
            handleChange(field as keyof SymbolDef, array);
        } else if (parent === 'facets') {
            handleFacetChange(field as keyof SymbolFacet, array);
        } else if (parent === 'lattice') {
            handleLatticeChange(field, array);
        } else if (parent === 'persona') {
            handlePersonaChange(field, array);
        }
    };

    const handleLinesArrayChange = (
        parent: 'persona',
        field: string,
        value: string
    ) => {
        // Split by newlines for text blocks
        const array = value.split('\n').map(s => s.trim()).filter(s => s);
        if (parent === 'persona') {
            handlePersonaChange(field, array);
        }
    };

    const handleSave = async () => {
        setSaveMessage(null);

        try {
            // Handle Rename: Delete old symbol if ID has changed and we are tracking an original ID
            if (originalId && originalId !== currentSymbol.id) {
                console.log(`Renaming symbol: ${originalId} -> ${currentSymbol.id}`);

                // 1. Propagate Rename
                await domainService.propagateRename(currentSymbol.symbol_domain, originalId, currentSymbol.id);

                // 2. Delete old symbol, but DO NOT cascade delete the references we just updated
                await domainService.deleteSymbol(currentSymbol.symbol_domain, originalId, false);
            }

            // Save to local cache
            await domainService.upsertSymbol(currentSymbol.symbol_domain, currentSymbol);

            // Refresh list
            const updatedList = await domainService.getSymbols(currentSymbol.symbol_domain);
            setSymbolList(updatedList);

            // Update original ID to match new saved state
            setOriginalId(currentSymbol.id);

            setSaveMessage({ type: 'success', text: 'Saved to Store' });
            setIsDirty(false);
        } catch (e) {
            setSaveMessage({ type: 'error', text: 'Save failed' });
            console.error(e);
        }
    };

    // Group symbols by kind
    const patterns = symbolList.filter(s => !s.kind || s.kind === 'pattern');
    const lattices = symbolList.filter(s => s.kind === 'lattice');
    const personas = symbolList.filter(s => s.kind === 'persona');

    return (
        <div className="flex flex-col h-full bg-gray-50 dark:bg-gray-950 font-sans relative">

            <Header {...headerProps}>
                <div className="flex items-center gap-4">
                    {saveMessage && (
                        <span className={`text-xs font-mono flex items-center gap-1 ${saveMessage.type === 'success' ? 'text-emerald-500' : 'text-amber-500'}`}>
                            {saveMessage.type === 'success' ? <Check size={14} /> : <AlertTriangle size={14} />}
                            {saveMessage.text}
                        </span>
                    )}
                    <button
                        onClick={handleSave}
                        disabled={!isDirty}
                        className="flex items-center gap-2 px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-mono text-sm font-bold transition-all"
                    >
                        <Save size={16} />
                        {isDirty ? 'Save to Cache' : 'Saved'}
                    </button>
                </div>
            </Header>

            <div className="flex-1 flex overflow-hidden">
                {/* Sidebar */}
                <div className="w-80 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex flex-col shrink-0">
                    <div className="p-4 border-b border-gray-200 dark:border-gray-800">
                        <Label>Local Domain</Label>
                        <div className="relative">
                            <select
                                value={selectedDomain}
                                onChange={(e) => setSelectedDomain(e.target.value)}
                                className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-2 text-sm font-mono appearance-none"
                            >
                                {domains.map(d => <option key={d} value={d}>{d}</option>)}
                            </select>
                            <ChevronRight className="absolute right-2 top-3 text-gray-400 rotate-90" size={14} />
                        </div>
                    </div>

                    {/* Synthesis Box */}
                    <div className="p-4 border-b border-gray-200 dark:border-gray-800 bg-indigo-50/50 dark:bg-indigo-900/10">
                        <div className="flex justify-between items-center mb-2">
                            <label className="text-xs font-mono font-bold text-indigo-500 uppercase flex items-center gap-1">
                                <Sparkles size={12} /> AI Forge
                            </label>
                            <div className="flex bg-gray-200 dark:bg-gray-800 rounded p-0.5">
                                <button
                                    onClick={() => setSynthMode('create')}
                                    className={`px-2 py-0.5 text-[10px] font-bold rounded font-mono transition-colors ${synthMode === 'create' ? 'bg-white dark:bg-gray-700 text-indigo-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                                >
                                    Create
                                </button>
                                <button
                                    onClick={() => setSynthMode('refactor')}
                                    className={`px-2 py-0.5 text-[10px] font-bold rounded font-mono transition-colors ${synthMode === 'refactor' ? 'bg-white dark:bg-gray-700 text-purple-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                                >
                                    Refactor
                                </button>
                            </div>
                        </div>

                        <div className="relative">
                            <AutoResizeTextarea
                                value={synthesisInput}
                                onChange={(e: any) => setSynthesisInput(e.target.value)}
                                placeholder={synthMode === 'create' ? "Describe a new symbol to synthesize..." : "Describe how to refactor symbols in this domain..."}
                                rows={3}
                                className="w-full bg-white dark:bg-gray-950 border border-indigo-200 dark:border-indigo-800 rounded p-2 text-xs mb-2 focus:ring-1 focus:ring-indigo-500 outline-none"
                                disabled={isSynthesizing}
                            />
                            <button
                                onClick={handleSynthesis}
                                disabled={isSynthesizing || !synthesisInput.trim()}
                                className={`w-full text-white py-1.5 rounded text-xs font-bold font-mono transition-colors flex items-center justify-center gap-2 disabled:opacity-50 ${synthMode === 'create' ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-purple-600 hover:bg-purple-700'}`}
                            >
                                {isSynthesizing ? <Loader2 size={12} className="animate-spin" /> : synthMode === 'create' ? <MessageSquarePlus size={12} /> : <Repeat size={12} />}
                                {synthMode === 'create' ? "Synthesize New" : "Run Bulk Refactor"}
                            </button>
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto p-2 space-y-4">

                        {/* Patterns List */}
                        <div>
                            <div className="flex items-center justify-between px-2 pb-1 mb-1 border-b border-gray-100 dark:border-gray-800">
                                <div className="text-[10px] font-mono font-bold uppercase text-gray-400 flex items-center gap-1">
                                    <Box size={12} /> Patterns
                                </div>
                                <button onClick={handleNewPattern} className="text-gray-400 hover:text-emerald-500 p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors" title="New Pattern">
                                    <Plus size={12} />
                                </button>
                            </div>
                            {patterns.length === 0 ? (
                                <div className="p-2 text-center text-xs text-gray-400 font-mono italic">
                                    No patterns.
                                </div>
                            ) : (
                                patterns.map(sym => (
                                    <div key={sym.id} className="group relative flex items-center mb-0.5">
                                        <button
                                            draggable
                                            onDragStart={(e) => handleDragStart(e, sym.id)}
                                            onClick={() => handleSelectSymbol(sym.id)}
                                            className={`w-full text-left p-2 pr-8 rounded text-xs font-mono truncate transition-colors flex items-center justify-between cursor-grab active:cursor-grabbing ${currentSymbol.id === sym.id
                                                ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800'
                                                : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400 border border-transparent'
                                                }`}
                                        >
                                            <span>{sym.id}</span>
                                            {currentSymbol.id === sym.id && <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 mr-1"></div>}
                                        </button>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                requestDeleteSymbol(sym.id);
                                            }}
                                            className="absolute right-2 p-1 text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity z-10"
                                            title="Delete Symbol"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                ))
                            )}
                        </div>

                        {/* Lattices List */}
                        <div>
                            <div className="flex items-center justify-between px-2 pb-1 mb-1 mt-4 border-b border-gray-100 dark:border-gray-800">
                                <div className="text-[10px] font-mono font-bold uppercase text-gray-400 flex items-center gap-1">
                                    <GitMerge size={12} /> Lattices
                                </div>
                                <button onClick={handleNewLattice} className="text-gray-400 hover:text-purple-500 p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors" title="New Lattice">
                                    <Plus size={12} />
                                </button>
                            </div>
                            {lattices.length === 0 ? (
                                <div className="p-2 text-center text-xs text-gray-400 font-mono italic">
                                    No lattices.
                                </div>
                            ) : (
                                lattices.map(sym => (
                                    <div key={sym.id} className="group relative flex items-center mb-0.5">
                                        <button
                                            draggable
                                            onDragStart={(e) => handleDragStart(e, sym.id)}
                                            onClick={() => handleSelectSymbol(sym.id)}
                                            className={`w-full text-left p-2 pr-8 rounded text-xs font-mono truncate transition-colors flex items-center justify-between cursor-grab active:cursor-grabbing ${currentSymbol.id === sym.id
                                                ? 'bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800'
                                                : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400 border border-transparent'
                                                }`}
                                        >
                                            <span>{sym.id}</span>
                                            {currentSymbol.id === sym.id && <div className="w-1.5 h-1.5 rounded-full bg-purple-500 mr-1"></div>}
                                        </button>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                requestDeleteSymbol(sym.id);
                                            }}
                                            className="absolute right-2 p-1 text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity z-10"
                                            title="Delete Symbol"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                ))
                            )}
                        </div>

                        {/* Personas List */}
                        <div>
                            <div className="flex items-center justify-between px-2 pb-1 mb-1 mt-4 border-b border-gray-100 dark:border-gray-800">
                                <div className="text-[10px] font-mono font-bold uppercase text-gray-400 flex items-center gap-1">
                                    <User size={12} /> Personas
                                </div>
                                <button onClick={handleNewPersona} className="text-gray-400 hover:text-amber-500 p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors" title="New Persona">
                                    <Plus size={12} />
                                </button>
                            </div>
                            {personas.length === 0 ? (
                                <div className="p-2 text-center text-xs text-gray-400 font-mono italic">
                                    No personas.
                                </div>
                            ) : (
                                personas.map(sym => (
                                    <div key={sym.id} className="group relative flex items-center mb-0.5">
                                        <button
                                            draggable
                                            onDragStart={(e) => handleDragStart(e, sym.id)}
                                            onClick={() => handleSelectSymbol(sym.id)}
                                            className={`w-full text-left p-2 pr-8 rounded text-xs font-mono truncate transition-colors flex items-center justify-between cursor-grab active:cursor-grabbing ${currentSymbol.id === sym.id
                                                ? 'bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800'
                                                : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-400 border border-transparent'
                                                }`}
                                        >
                                            <span>{sym.id}</span>
                                            {currentSymbol.id === sym.id && <div className="w-1.5 h-1.5 rounded-full bg-amber-500 mr-1"></div>}
                                        </button>
                                        <button
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                requestDeleteSymbol(sym.id);
                                            }}
                                            className="absolute right-2 p-1 text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity z-10"
                                            title="Delete Symbol"
                                        >
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                ))
                            )}
                        </div>

                    </div>

                    <div className="p-4 border-t border-gray-200 dark:border-gray-800 grid grid-cols-3 gap-2">
                        <button
                            onClick={handleNewPattern}
                            className="flex items-center justify-center gap-1 bg-emerald-600 hover:bg-emerald-700 text-white py-2 rounded text-[10px] font-bold font-mono transition-colors"
                            title="New Pattern"
                        >
                            <Plus size={10} /> Pattern
                        </button>
                        <button
                            onClick={handleNewLattice}
                            className="flex items-center justify-center gap-1 bg-purple-600 hover:bg-purple-700 text-white py-2 rounded text-[10px] font-bold font-mono transition-colors"
                            title="New Lattice"
                        >
                            <Plus size={10} /> Lattice
                        </button>
                        <button
                            onClick={handleNewPersona}
                            className="flex items-center justify-center gap-1 bg-amber-600 hover:bg-amber-700 text-white py-2 rounded text-[10px] font-bold font-mono transition-colors"
                            title="New Persona"
                        >
                            <Plus size={10} /> Persona
                        </button>
                    </div>
                </div>

                {/* Main Editor */}
                <div className="flex-1 flex flex-col h-full overflow-hidden">
                    {/* Toolbar */}
                    <div className="h-16 border-b border-gray-200 dark:border-gray-800 bg-white/50 dark:bg-gray-900/50 backdrop-blur flex items-center justify-between px-6">
                        <div className="flex items-center gap-3">
                            <div>
                                <h1 className="text-lg font-bold font-mono text-gray-900 dark:text-white">Editor</h1>
                                <p className="text-xs text-gray-500 font-mono">{currentSymbol.id}</p>
                            </div>
                            <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider ${currentSymbol.kind === 'lattice'
                                ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-600'
                                : currentSymbol.kind === 'persona'
                                    ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-600'
                                    : 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600'
                                }`}>
                                {currentSymbol.kind || 'Pattern'}
                            </span>
                        </div>
                    </div>

                    {/* Form Area */}
                    <div className="flex-1 overflow-y-auto p-8">
                        <div className="max-w-4xl mx-auto space-y-8 pb-20">

                            {/* Identity Section (Common) */}
                            <section className="bg-white dark:bg-gray-900 rounded-lg p-6 border border-gray-200 dark:border-gray-800 shadow-sm space-y-4 relative">
                                <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-800 pb-2 mb-4">
                                    <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400 font-mono">Identity & Ontology</h3>
                                    <div className="flex items-center gap-2">
                                        {/* Convert to Lattice Button (Only for Patterns) */}
                                        {currentSymbol.kind !== 'lattice' && currentSymbol.kind !== 'persona' && currentSymbol.id !== DEFAULT_PATTERN.id && (
                                            <button
                                                onClick={handleConvertToLattice}
                                                disabled={isConverting}
                                                className="flex items-center gap-1.5 px-3 py-1 bg-purple-50 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 border border-purple-200 dark:border-purple-800 rounded text-[10px] font-bold font-mono hover:bg-purple-100 dark:hover:bg-purple-900/40 transition-colors disabled:opacity-50"
                                            >
                                                {isConverting ? <Loader2 size={12} className="animate-spin" /> : <ArrowRightLeft size={12} />}
                                                Convert to Lattice
                                            </button>
                                        )}

                                        {/* Convert to Persona Button (For Patterns & Lattices) */}
                                        {currentSymbol.kind !== 'persona' && currentSymbol.id !== DEFAULT_PATTERN.id && currentSymbol.id !== DEFAULT_LATTICE.id && (
                                            <button
                                                onClick={handleConvertToPersona}
                                                disabled={isConverting}
                                                className="flex items-center gap-1.5 px-3 py-1 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-800 rounded text-[10px] font-bold font-mono hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors disabled:opacity-50"
                                            >
                                                {isConverting ? <Loader2 size={12} className="animate-spin" /> : <UserCog size={12} />}
                                                Convert to Persona
                                            </button>
                                        )}
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    <div className="space-y-1">
                                        <Label>Symbol ID (Unique)</Label>
                                        <input
                                            type="text"
                                            value={currentSymbol.id}
                                            onChange={e => handleChange('id', e.target.value)}
                                            className={`${INPUT_STYLE} font-mono`}
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label>Name</Label>
                                        <input
                                            type="text"
                                            value={currentSymbol.name}
                                            onChange={e => handleChange('name', e.target.value)}
                                            className={INPUT_STYLE}
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label>Triad (Unicode)</Label>
                                        <input
                                            type="text"
                                            value={currentSymbol.triad}
                                            onChange={e => handleChange('triad', e.target.value)}
                                            className={`${INPUT_STYLE} font-mono`}
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label>Role</Label>
                                        <input
                                            type="text"
                                            value={currentSymbol.role}
                                            onChange={e => handleChange('role', e.target.value)}
                                            className={INPUT_STYLE}
                                        />
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 gap-6 pt-2">
                                    <div className="space-y-1">
                                        <Label>Domain</Label>
                                        <input
                                            type="text"
                                            value={currentSymbol.symbol_domain}
                                            disabled
                                            className={`${INPUT_STYLE} opacity-60 cursor-not-allowed`}
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label>Tag</Label>
                                        <input
                                            type="text"
                                            value={currentSymbol.symbol_tag || ''}
                                            onChange={e => handleChange('symbol_tag', e.target.value)}
                                            className={INPUT_STYLE}
                                        />
                                    </div>
                                </div>
                            </section>

                            {/* LATTICE SECTION */}
                            {currentSymbol.kind === 'lattice' && (
                                <section className="bg-purple-50 dark:bg-purple-900/10 rounded-lg p-6 border border-purple-100 dark:border-purple-800/30 space-y-4">
                                    <h3 className="text-xs font-bold uppercase tracking-widest text-purple-500 font-mono border-b border-purple-200 dark:border-purple-800/30 pb-2 mb-4 flex items-center gap-2">
                                        <Layout size={14} /> Lattice Definition
                                    </h3>
                                    <div className="grid grid-cols-2 gap-6">
                                        <div className="space-y-1">
                                            <Label>Execution Topology</Label>
                                            <select
                                                value={currentSymbol.lattice?.topology || 'inductive'}
                                                onChange={e => handleLatticeChange('topology', e.target.value)}
                                                className={INPUT_STYLE}
                                            >
                                                <option value="inductive">Inductive (Bottom-Up)</option>
                                                <option value="deductive">Deductive (Top-Down)</option>
                                                <option value="bidirectional">Bidirectional (Flow)</option>
                                                <option value="invariant">Invariant (Constraint)</option>
                                                <option value="energy">Energy (State)</option>
                                            </select>
                                        </div>
                                        <div className="space-y-1">
                                            <Label>Closure Type</Label>
                                            <select
                                                value={currentSymbol.lattice?.closure || 'loop'}
                                                onChange={e => handleLatticeChange('closure', e.target.value)}
                                                className={INPUT_STYLE}
                                            >
                                                <option value="loop">Loop (Recursive)</option>
                                                <option value="branch">Branch (Forking)</option>
                                                <option value="collapse">Collapse (Reduction)</option>
                                                <option value="constellation">Constellation (Graph)</option>
                                                <option value="synthesis">Synthesis (Merge)</option>
                                            </select>
                                        </div>
                                    </div>
                                    <div className="space-y-1">
                                        <Label>Lattice Members (Execution Order)</Label>
                                        <SymbolRelationshipField
                                            items={currentSymbol.lattice?.members}
                                            onChange={(newItems) => handleLatticeChange('members', newItems)}
                                            placeholder="No members assigned"
                                        />
                                    </div>
                                </section>
                            )}

                            {/* PERSONA SECTION */}
                            {currentSymbol.kind === 'persona' && (
                                <section className="bg-amber-50 dark:bg-amber-900/10 rounded-lg p-6 border border-amber-100 dark:border-amber-800/30 space-y-4">
                                    <h3 className="text-xs font-bold uppercase tracking-widest text-amber-500 font-mono border-b border-amber-200 dark:border-amber-800/30 pb-2 mb-4 flex items-center gap-2">
                                        <User size={14} /> Persona Definition
                                    </h3>

                                    <div className="grid grid-cols-2 gap-6">
                                        <div className="space-y-1">
                                            <Label>Recursion Level</Label>
                                            <select
                                                value={currentSymbol.persona?.recursion_level || 'root'}
                                                onChange={e => handlePersonaChange('recursion_level', e.target.value)}
                                                className={INPUT_STYLE}
                                            >
                                                <option value="root">Root</option>
                                                <option value="recursive">Recursive</option>
                                                <option value="fractal">Fractal</option>
                                            </select>
                                        </div>
                                        <div className="space-y-1">
                                            <Label>Function</Label>
                                            <input
                                                value={currentSymbol.persona?.function || ''}
                                                onChange={e => handlePersonaChange('function', e.target.value)}
                                                className={INPUT_STYLE}
                                                placeholder="Primary function of this persona"
                                            />
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-6">
                                        <div className="space-y-1">
                                            <Label>Activation Conditions</Label>
                                            <AutoResizeTextarea
                                                value={safeJoin(currentSymbol.persona?.activation_conditions, '\n')}
                                                onChange={(e: any) => handleLinesArrayChange('persona', 'activation_conditions', e.target.value)}
                                                placeholder="One condition per line..."
                                                className={INPUT_STYLE}
                                            />
                                        </div>
                                        <div className="space-y-1">
                                            <Label>Fallback Behavior</Label>
                                            <AutoResizeTextarea
                                                value={safeJoin(currentSymbol.persona?.fallback_behavior, '\n')}
                                                onChange={(e: any) => handleLinesArrayChange('persona', 'fallback_behavior', e.target.value)}
                                                placeholder="One behavior per line..."
                                                className={INPUT_STYLE}
                                            />
                                        </div>
                                    </div>

                                    <div className="space-y-1">
                                        <Label>Linked Personas</Label>
                                        <SymbolRelationshipField
                                            items={currentSymbol.persona?.linked_personas}
                                            onChange={(newItems) => handlePersonaChange('linked_personas', newItems)}
                                            placeholder="No linked personas"
                                        />
                                    </div>

                                </section>
                            )}

                            {/* Logic & Facets (Common, but hidden for lattice members usually?) - Keeping common per request */}
                            {/* Logic section (Macro) - Relevant for Pattern, less so for Lattice but kept for notes */}
                            {currentSymbol.kind !== 'lattice' && (
                                <section className="bg-white dark:bg-gray-900 rounded-lg p-6 border border-gray-200 dark:border-gray-800 shadow-sm space-y-4">
                                    <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400 font-mono border-b border-gray-100 dark:border-gray-800 pb-2 mb-4">
                                        Functional Logic
                                    </h3>
                                    <div className="space-y-1">
                                        <Label>Macro (Logic Flow)</Label>
                                        <AutoResizeTextarea
                                            value={currentSymbol.macro || ''}
                                            onChange={(e: any) => handleChange('macro', e.target.value)}
                                            className={`${INPUT_STYLE} font-mono`}
                                            placeholder="e.g. monitor -> detect -> log -> remediate"
                                        />
                                    </div>
                                </section>
                            )}

                            {/* Facets */}
                            <section className="bg-white dark:bg-gray-900 rounded-lg p-6 border border-gray-200 dark:border-gray-800 shadow-sm space-y-4">
                                <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400 font-mono border-b border-gray-100 dark:border-gray-800 pb-2 mb-4">
                                    Operational Facets
                                </h3>
                                <div className="grid grid-cols-2 gap-6">
                                    <div className="space-y-1">
                                        <Label>Function</Label>
                                        <input
                                            type="text"
                                            value={currentSymbol.facets?.function}
                                            onChange={e => handleFacetChange('function', e.target.value)}
                                            className={INPUT_STYLE}
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label>Topology</Label>
                                        <input
                                            type="text"
                                            value={currentSymbol.facets?.topology}
                                            onChange={e => handleFacetChange('topology', e.target.value)}
                                            className={INPUT_STYLE}
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label>Commit Type</Label>
                                        <input
                                            type="text"
                                            value={currentSymbol.facets?.commit}
                                            onChange={e => handleFacetChange('commit', e.target.value)}
                                            className={INPUT_STYLE}
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label>Temporal</Label>
                                        <input
                                            type="text"
                                            value={currentSymbol.facets?.temporal}
                                            onChange={e => handleFacetChange('temporal', e.target.value)}
                                            className={INPUT_STYLE}
                                        />
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 gap-6 mt-4">
                                    <div className="space-y-1">
                                        <Label>Invariants (Comma Separated)</Label>
                                        <input
                                            type="text"
                                            value={safeJoin(currentSymbol.facets?.invariants, ', ')}
                                            onChange={e => handleArrayChange('facets', 'invariants', e.target.value)}
                                            className={INPUT_STYLE}
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label>Substrate (Comma Separated)</Label>
                                        <input
                                            type="text"
                                            value={safeJoin(currentSymbol.facets?.substrate, ', ')}
                                            onChange={e => handleArrayChange('facets', 'substrate', e.target.value)}
                                            className={INPUT_STYLE}
                                        />
                                    </div>
                                </div>
                            </section>

                            {/* Integrity */}
                            <section className="bg-red-50 dark:bg-red-900/10 rounded-lg p-6 border border-red-100 dark:border-red-900/30 space-y-4">
                                <h3 className="text-xs font-bold uppercase tracking-widest text-red-400 font-mono border-b border-red-200 dark:border-red-900/30 pb-2 mb-4">
                                    System Integrity
                                </h3>
                                <div className="space-y-1">
                                    <Label>Failure Mode</Label>
                                    <AutoResizeTextarea
                                        value={currentSymbol.failure_mode || ''}
                                        onChange={(e: any) => handleChange('failure_mode', e.target.value)}
                                        className={`${INPUT_STYLE} border-red-200 dark:border-red-900/50 bg-white dark:bg-red-950/20`}
                                        placeholder="Describe how this symbol fails..."
                                    />
                                </div>
                            </section>

                            {/* Linked Patterns (For non-lattice, non-persona symbols primarily, but kept generic) */}
                            {currentSymbol.kind !== 'lattice' && currentSymbol.kind !== 'persona' && (
                                <section className="bg-white dark:bg-gray-900 rounded-lg p-6 border border-gray-200 dark:border-gray-800 shadow-sm space-y-4">
                                    <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400 font-mono border-b border-gray-100 dark:border-gray-800 pb-2 mb-4">
                                        Symbolic Links
                                    </h3>
                                    <div className="space-y-1">
                                        <Label>Linked Patterns</Label>
                                        <SymbolRelationshipField
                                            items={currentSymbol.linked_patterns}
                                            onChange={(newItems) => handleChange('linked_patterns', newItems)}
                                            placeholder="No linked patterns"
                                        />
                                    </div>
                                </section>
                            )}

                        </div>
                    </div>
                </div>

                {/* Delete Confirmation Modal */}
                {deleteSymbolId && (
                    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl max-w-sm w-full p-6 border border-gray-200 dark:border-gray-800">
                            <h3 className="font-bold font-mono text-red-600 dark:text-red-400 mb-2 flex items-center gap-2">
                                <Trash2 size={18} /> Delete Symbol?
                            </h3>
                            <p className="text-sm text-gray-600 dark:text-gray-300 mb-6 font-mono">
                                Are you sure you want to delete <strong>{deleteSymbolId}</strong>? This will also remove it from any linked patterns in this domain.
                            </p>
                            <div className="flex gap-2 justify-end">
                                <button
                                    onClick={() => setDeleteSymbolId(null)}
                                    className="px-4 py-2 border border-gray-300 dark:border-gray-700 rounded text-xs font-mono hover:bg-gray-50 dark:hover:bg-gray-800"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={confirmDeleteSymbol}
                                    className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded text-xs font-mono font-bold"
                                >
                                    Delete
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Convert Modal */}
                {isConvertModalOpen && (
                    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl max-w-md w-full p-6 border border-gray-200 dark:border-gray-800">
                            <h3 className="font-bold font-mono text-purple-600 dark:text-purple-400 mb-4 flex items-center gap-2">
                                <Layout size={18} /> Configure Lattice Conversion
                            </h3>

                            <div className="space-y-4 mb-6">
                                <div className="space-y-1">
                                    <Label>New Lattice ID</Label>
                                    <input
                                        value={convertConfig.newId}
                                        onChange={(e) => setConvertConfig(prev => ({ ...prev, newId: e.target.value }))}
                                        className={INPUT_STYLE}
                                    />
                                </div>
                                <div className="space-y-1">
                                    <Label>Topology</Label>
                                    <select
                                        value={convertConfig.topology}
                                        onChange={(e) => setConvertConfig(prev => ({ ...prev, topology: e.target.value }))}
                                        className={INPUT_STYLE}
                                    >
                                        <option value="inductive">Inductive</option>
                                        <option value="deductive">Deductive</option>
                                        <option value="bidirectional">Bidirectional</option>
                                        <option value="invariant">Invariant</option>
                                        <option value="energy">Energy</option>
                                    </select>
                                </div>
                                <div className="space-y-1">
                                    <Label>Closure</Label>
                                    <select
                                        value={convertConfig.closure}
                                        onChange={(e) => setConvertConfig(prev => ({ ...prev, closure: e.target.value }))}
                                        className={INPUT_STYLE}
                                    >
                                        <option value="loop">Loop</option>
                                        <option value="branch">Branch</option>
                                        <option value="collapse">Collapse</option>
                                        <option value="constellation">Constellation</option>
                                        <option value="synthesis">Synthesis</option>
                                    </select>
                                </div>
                            </div>

                            <div className="flex gap-2 justify-end">
                                <button
                                    onClick={() => setIsConvertModalOpen(false)}
                                    className="px-4 py-2 border border-gray-300 dark:border-gray-700 rounded text-xs font-mono hover:bg-gray-50 dark:hover:bg-gray-800"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={confirmConversion}
                                    className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded text-xs font-mono font-bold"
                                >
                                    Confirm Conversion
                                </button>
                            </div>
                        </div>
                    </div>
                )}

            </div>
        </div>
    )
};
