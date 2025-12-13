
import { GoogleGenAI, Chat, GenerateContentResponse, FunctionCallingConfigMode } from "@google/genai";
import { toolDeclarations } from "./toolsService.ts";
import { ACTIVATION_PROMPT } from '../symbolic_system/activation_prompt.ts';
import { EvaluationMetrics, TraceData, TestMeta, SymbolDef } from '../types.ts';
import { domainService } from './domainService.ts';
import { embedText } from './embeddingService.ts';
import { buildSystemMetadataBlock } from './timeService.ts';

// Initialize the client strictly with process.env.API_KEY
// Export for use in vectorService
const apiKey = process.env.API_KEY || "missing-api-key";
if (!process.env.API_KEY) {
    console.warn("WARNING: API_KEY not found in environment. AI features will fail until configured.");
}
export const ai = new GoogleGenAI({ apiKey });

type ModelName = 'gemini-3' | 'gemini-2.5-pro' | 'gemini-2.5-flash';

const MODEL_FALLBACK_ORDER: ModelName[] = ['gemini-3', 'gemini-2.5-pro', 'gemini-2.5-flash'];

const chatModelMap = new WeakMap<Chat, number>();
let chatSessionModelIndex: number | null = null;
let chatSessionSystemInstruction: string | null = null;

// Create a persistent chat session
let chatSession: Chat | null = null;

const createChatInstance = (model: ModelName, systemInstruction: string) => {
  const chat = ai.chats.create({
    model,
    config: {
      systemInstruction,
      thinkingConfig: { thinkingBudget: 16000 },
      tools: [{ functionDeclarations: toolDeclarations }],
    },
  });

  chatModelMap.set(chat, MODEL_FALLBACK_ORDER.indexOf(model));

  return chat;
};

const buildChatWithFallback = (systemInstruction: string, startingIndex = 0) => {
  const errors: string[] = [];

  for (let offset = 0; offset < MODEL_FALLBACK_ORDER.length; offset++) {
    const index = (startingIndex + offset) % MODEL_FALLBACK_ORDER.length;
    const model = MODEL_FALLBACK_ORDER[index];

    try {
      const chat = createChatInstance(model, systemInstruction);
      return { chat, index };
    } catch (error) {
      errors.push(`${model}: ${String(error)}`);
    }
  }

  throw new Error(`All models failed: ${errors.join(' | ')}`);
};

const switchChatAfterError = (systemInstruction: string, failedIndex: number, persistSession: boolean) => {
  const errors: string[] = [];

  for (let offset = 1; offset < MODEL_FALLBACK_ORDER.length; offset++) {
    const index = (failedIndex + offset) % MODEL_FALLBACK_ORDER.length;
    const model = MODEL_FALLBACK_ORDER[index];

    try {
      const chat = createChatInstance(model, systemInstruction);

      if (persistSession) {
        chatSession = chat;
        chatSessionModelIndex = index;
        chatSessionSystemInstruction = systemInstruction;
      }

      return { chat, index };
    } catch (error) {
      errors.push(`${model}: ${String(error)}`);
    }
  }

  throw new Error(`All models failed: ${errors.join(' | ')}`);
};

export const getChatSession = (systemInstruction: string) => {
  if (!chatSession || chatSessionSystemInstruction !== systemInstruction) {
    const { chat, index } = buildChatWithFallback(systemInstruction);
    chatSession = chat;
    chatSessionModelIndex = index;
    chatSessionSystemInstruction = systemInstruction;
  }
  return chatSession;
};

export const resetChatSession = () => {
  chatSession = null;
  chatSessionModelIndex = null;
  chatSessionSystemInstruction = null;
};

export const createFreshChatSession = (systemInstruction: string) => {
  const { chat } = buildChatWithFallback(systemInstruction);
  return chat;
};

const generateWithModelFallback = async (operation: (model: ModelName) => Promise<GenerateContentResponse>) => {
  const errors: string[] = [];

  for (const model of MODEL_FALLBACK_ORDER) {
    try {
      return await operation(model);
    } catch (error) {
      errors.push(`${model}: ${String(error)}`);
    }
  }

  throw new Error(`All models failed: ${errors.join(' | ')}`);
};

const wrapMessageWithMetadata = (message: any) => {
  const metadataText = { text: `[SYSTEM_METADATA] ${JSON.stringify(buildSystemMetadataBlock())}` };

  if (Array.isArray(message)) {
      return [...message, metadataText];
  }

  if (typeof message === 'string') {
      return [ { text: message }, metadataText ];
  }

  return [message, metadataText];
};

// --- Embedding Helper ---
export const generateEmbedding = async (text: string): Promise<number[]> => {
    return embedText(text);
};

// Standalone function for Symbol Synthesis (Symbol Forge)
export const generateSymbolSynthesis = async (
    input: string, 
    domain: string, 
    existingSymbols: SymbolDef[] = []
): Promise<string> => {
  try {
    // specific context construction to help the model link to existing patterns
    const contextSummary = existingSymbols.map(s => 
        `- ID: ${s.id} | Name: ${s.name} | Role: ${s.role} | Kind: ${s.kind || 'pattern'}`
    ).join('\n');

    const prompt = `
    TASK: Synthesize a new SignalZero Symbol based on the user input.
    
    TARGET DOMAIN: ${domain}
    
    EXISTING SYMBOLS IN DOMAIN (Use these IDs for 'linked_patterns', 'lattice.members', or 'linked_personas' if relevant):
    ${contextSummary}

    USER INPUT: "${input}"
    
    CRITICAL OUTPUT RULE:
    You must output a single valid JSON object representing a SignalZero Symbol, wrapped strictly in <sz_symbol></sz_symbol> tags.
    Determine the most appropriate 'kind' (pattern, lattice, or persona) based on the description.
    ENSURE ALL FIELDS ARE PRESENT: id, kind, name, role, triad, macro, symbol_domain, symbol_tag, failure_mode, linked_patterns, and facets (including function, topology, commit, gate, substrate, temporal, invariants).
    INFER MISSING FIELDS: If any required fields (e.g., specific facets, failure_mode, linked_patterns) are missing from the input or context, you must INFER them based on the symbol's 'symbolic signature' (its triad, macro, and role). Do not leave fields empty or null.
    
    SCHEMAS:

    1. PATTERN (Default - logic/concept):
    {
      "id": "SZ:${domain.toUpperCase()}-PAT-[NUM]",
      "kind": "pattern",
      "name": "Symbol Name",
      "triad": "unicode_triad", 
      "role": "Brief role description",
      "macro": "logic -> flow -> outcome",
      "symbol_domain": "${domain}",
      "symbol_tag": "inferred_tag",
      "facets": {
        "function": "string",
        "topology": "string",
        "commit": "string",
        "temporal": "string",
        "gate": ["string"],
        "substrate": ["symbolic"],
        "invariants": ["string"]
      },
      "failure_mode": "string",
      "linked_patterns": ["SZ:EXISTING-ID-001"]
    }

    2. LATTICE (Network/Structure/Topology):
    {
      "id": "SZ:${domain.toUpperCase()}-LAT-[NUM]",
      "kind": "lattice",
      "name": "Lattice Name",
      "triad": "unicode_triad",
      "role": "Structure description",
      "lattice": {
          "topology": "inductive|deductive|bidirectional|invariant|energy",
          "closure": "loop|branch|collapse|constellation|synthesis",
          "members": ["SZ:EXISTING-ID-001", "SZ:EXISTING-ID-002"] 
      },
      "symbol_domain": "${domain}",
      "symbol_tag": "lattice",
      "facets": { ... },
      "failure_mode": "string"
    }

    3. PERSONA (Agent/Identity/Actor):
    {
      "id": "SZ:${domain.toUpperCase()}-PER-[NUM]",
      "kind": "persona",
      "name": "Persona Name",
      "triad": "unicode_triad",
      "role": "Agent role",
      "persona": {
          "recursion_level": "root|recursive|fractal",
          "function": "Primary function",
          "activation_conditions": ["condition1", "condition2"],
          "fallback_behavior": ["behavior1"],
          "linked_personas": ["SZ:EXISTING-PER-001"]
      },
      "symbol_domain": "${domain}",
      "symbol_tag": "persona",
      "facets": { ... },
      "failure_mode": "string"
    }
    `;

    const response = await generateWithModelFallback((model) => ai.models.generateContent({
      model,
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        temperature: 0.7, // Slightly creative for synthesis
      }
    }));

    return response.text || "";
  } catch (error) {
    console.error("Symbol synthesis failed:", error);
    throw error;
  }
};

export const generateRefactor = async (
    input: string,
    domain: string,
    existingSymbols: SymbolDef[] = []
): Promise<GenerateContentResponse> => {
    try {
        // Summary for refactor context
        const contextSummary = existingSymbols.map(s => 
            `JSON: ${JSON.stringify(s)}`
        ).join('\n');

        const prompt = `
        TASK: Refactor existing SignalZero Symbols in the domain '${domain}' based on user input.

        USER INSTRUCTION: "${input}"

        CURRENT SYMBOLS (JSON):
        ${contextSummary}

        INSTRUCTIONS:
        1. Analyze the user instruction and the current symbol list.
        2. Identify which symbols need modification (updates, renames, logic changes).
        3. You MUST use the 'bulk_update_symbols' tool to apply these changes.
        4. CRITICAL: For each update, provide the 'old_id' AND the COMPLETE 'symbol_data' (the entire new JSON object).
        5. DO NOT provide partial updates. 'symbol_data' must be the full valid symbol schema, including all existing fields that haven't changed.
        6. If renaming a symbol, ensure 'symbol_data.id' is the new ID, and 'old_id' is the previous ID.
        7. Ensure 'symbol_data.symbol_domain' IS PRESERVED as '${domain}'.
        8. Do not output text, just call the tool.
        `;

        const response = await generateWithModelFallback((model) => ai.models.generateContent({
            model,
            contents: [{ parts: [{ text: prompt }] }],
            config: {
                tools: [{ functionDeclarations: toolDeclarations }],
                // Force usage of the update tool if applicable, or ANY to allow reasoning
                toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } }
            }
        }));

        return response;

    } catch (error) {
        console.error("Refactor generation failed:", error);
        throw error;
    }
};


export const generatePersonaConversion = async (currentSymbol: SymbolDef): Promise<string> => {
    try {
        const prompt = `
        TASK: Convert this existing SignalZero Symbol into a PERSONA symbol.
        
        INPUT SYMBOL (JSON):
        ${JSON.stringify(currentSymbol, null, 2)}
        
        INSTRUCTIONS:
        1. Change 'kind' to 'persona'.
        2. Suggest a new ID (e.g. change -PAT- to -PER-).
        3. Map 'macro' logic to 'persona.function' and 'persona.activation_conditions'.
        4. Infer 'persona.recursion_level' (root/recursive/fractal) based on the role.
        5. Infer 'persona.fallback_behavior' based on 'failure_mode'.
        6. INFER MISSING FIELDS: You must infer any missing fields required for a valid Persona definition (like 'activation_conditions', 'fallback_behavior', 'linked_personas') based on the input symbol's logic, role, and context. If general fields are missing (failure_mode, facets components), infer them from the symbol's signature (triad/macro/role).
        7. RETAIN ALL REQUIRED FIELDS: Ensure the output JSON includes 'id', 'kind', 'name', 'role', 'triad', 'macro', 'symbol_domain', 'symbol_tag', 'failure_mode', 'linked_patterns', and 'facets' (with function, topology, commit, gate, substrate, temporal, invariants).
        
        OUTPUT:
        Return a SINGLE valid JSON object wrapped in <sz_symbol></sz_symbol> tags.
        `;
    
        const response = await generateWithModelFallback((model) => ai.models.generateContent({
          model,
          contents: [{ parts: [{ text: prompt }] }],
          config: { temperature: 0.5 }
        }));
    
        return response.text || "";
    } catch (error) {
        console.error("Persona conversion failed:", error);
        throw error;
    }
};

export const generateLatticeConversion = async (currentSymbol: SymbolDef): Promise<string> => {
    try {
        const prompt = `
        TASK: Convert this existing SignalZero Symbol into a LATTICE symbol.

        INPUT SYMBOL (JSON):
        ${JSON.stringify(currentSymbol, null, 2)}

        INSTRUCTIONS:
        1. Change 'kind' to 'lattice'.
        2. Suggest a new ID (e.g. change -PAT- to -LAT-).
        3. Define the 'lattice' object:
           - topology: inductive, deductive, bidirectional, invariant, or energy.
           - closure: loop, branch, collapse, constellation, or synthesis.
           - members: Suggest a list of member IDs (can include the original ID or placeholders).
        4. Infer 'lattice.topology' and 'lattice.closure' based on the 'macro' or 'role' of the input symbol.
        5. INFER MISSING FIELDS: You must infer any missing fields required for a valid Lattice definition (especially 'members') based on the input symbol's context and macro. If members are not explicit, suggest logical placeholders. If general fields are missing, infer them from the symbol's signature (triad/macro/role).
        6. RETAIN ALL REQUIRED FIELDS: Ensure the output JSON includes 'id', 'kind', 'name', 'role', 'triad', 'macro', 'symbol_domain', 'symbol_tag', 'failure_mode', 'linked_patterns', and 'facets' (with function, topology, commit, gate, substrate, temporal, invariants). Update 'facets.topology' to 'lattice'.
        
        OUTPUT:
        Return a SINGLE valid JSON object wrapped in <sz_symbol></sz_symbol> tags.
        `;

        const response = await generateWithModelFallback((model) => ai.models.generateContent({
          model,
          contents: [{ parts: [{ text: prompt }] }],
          config: { temperature: 0.5 }
        }));

        return response.text || "";
    } catch (error) {
        console.error("Lattice conversion failed:", error);
        throw error;
    }
};

export const generateGapSynthesis = async (
    promptOriginal: string, 
    szResponse: string, 
    baseResponse: string,
    activeDomains: string[] = [],
    existingSymbols: SymbolDef[] = []
): Promise<string> => {
    try {
        const contextSummary = existingSymbols.slice(0, 50).map(s => 
            `- ID: ${s.id} | Domain: ${s.symbol_domain} | Name: ${s.name}`
        ).join('\n');

        const prompt = `
        TASK: Analyze the symbolic delta between two model responses and synthesize new SignalZero Symbols that bridge the gap.

        ACTIVE DOMAINS: ${activeDomains.join(', ')}

        EXISTING SYMBOLS CONTEXT (Sample):
        ${contextSummary}

        ORIGINAL PROMPT:
        "${promptOriginal}"

        RESPONSE A (SignalZero - Symbolic):
        ${szResponse}

        RESPONSE B (Baseline - Standard):
        ${baseResponse}

        INSTRUCTIONS:
        1. Compare Response A and Response B.
        2. Identify specific symbolic concepts, invariants, or structural logic present in A but missing or weak in B (or vice versa, if B offered a unique insight).
        3. Synthesize NEW symbols (Patterns, Lattices, or Personas) that encapsulate these specific gaps or missing cognitive structures.
        4. The symbols MUST belong to one of the ACTIVE DOMAINS provided above if relevant. If not, use 'gap-analysis'.
        5. Use existing symbols in 'linked_patterns' if applicable.
        6. CRITICAL SCHEMA: The output symbols MUST have all these fields:
           - id, kind, name, role, triad, macro
           - symbol_domain, symbol_tag, failure_mode, linked_patterns
           - facets: { function, topology, commit, gate, substrate, temporal, invariants }
        7. INFER MISSING FIELDS: If any required fields are not explicit in the gap analysis, INFER them based on the symbol's inferred 'symbolic signature' (triad/macro/role).
        
        OUTPUT:
        Return valid JSON object(s) wrapped in <sz_symbol></sz_symbol> tags. You may return multiple symbols if the gap requires a structure.
        `;

        const response = await generateWithModelFallback((model) => ai.models.generateContent({
          model,
          contents: [{ parts: [{ text: prompt }] }],
          config: { temperature: 0.7 }
        }));

        return response.text || "";
    } catch (error) {
        console.error("Gap synthesis failed:", error);
        throw error;
    }
};

// --- Test Runner Functions ---

export const runSignalZeroTest = async (
    prompt: string,
    toolExecutor: (name: string, args: any) => Promise<any>,
    primingPrompts: string[] = ["Load domains"],
    systemInstruction: string = ACTIVATION_PROMPT,
): Promise<{ text: string, meta: TestMeta }> => {
  const startTime = Date.now();
  
  // Snapshot context - Async fetch
  const allDomains = await domainService.listDomains();
  // Filter for enabled domains
  const loadedDomains = [];
  let symbolCount = 0;
  
  for (const d of allDomains) {
      if (await domainService.isEnabled(d)) {
          loadedDomains.push(d);
          const syms = await domainService.getSymbols(d);
          symbolCount += syms.length;
      }
  }

  try {
    // Create ephemeral chat with full system context
    const chat = createFreshChatSession(systemInstruction);

    // Helper to execute a turn with tool handling
    const executeTurn = async (msg: string): Promise<string> => {
        let currentResponse = await chat.sendMessage({ message: wrapMessageWithMetadata(msg) });
        let turnText = currentResponse.text || "";
        
        let loops = 0;
        // Allow up to 20 turns of tool use for deep symbolic chains
        while (loops < 20) {
            const calls = currentResponse.candidates?.[0]?.content?.parts
                ?.filter((p) => p.functionCall)
                .map((p) => p.functionCall);

            if (!calls || calls.length === 0) break;

            const functionResponses = [];
            for (const call of calls) {
                if (!call) continue;
                try {
                    if (call.name) {
                        const result = await toolExecutor(call.name, call.args);
                        functionResponses.push({
                            id: call.id,
                            name: call.name,
                            response: { result: result }
                        });
                    }
                } catch (e) {
                    console.error("Test tool exec failed", e);
                     functionResponses.push({
                            id: call.id,
                            name: call.name,
                            response: { error: String(e) }
                        });
                }
            }

            currentResponse = await chat.sendMessage({ message: wrapMessageWithMetadata(functionResponses.map(fr => ({ functionResponse: fr }))) });
            if (currentResponse.text) {
                turnText += currentResponse.text;
            }
            loops++;
        }
        return turnText;
    };

    // 1. Run Priming Prompts (silent execution, we don't return their output but they set state)
    for (const primeMsg of primingPrompts) {
        await executeTurn(primeMsg);
    }

    // 2. Run Actual Test Prompt
    const finalResponse = await executeTurn(prompt);

    const endTime = Date.now();

    // Note: Traces are now captured via tool executor side-effects in traceService, handled by caller.

    return {
        text: finalResponse,
        meta: {
            startTime: new Date(startTime).toISOString(),
            endTime: new Date(endTime).toISOString(),
            durationMs: endTime - startTime,
            loadedDomains: loadedDomains,
            symbolCount: symbolCount
        }
    };

  } catch (error) {
    console.error("SignalZero Test Run Failed:", error);
    const endTime = Date.now();
    return {
        text: `ERROR: ${String(error)}`,
        meta: {
            startTime: new Date(startTime).toISOString(),
            endTime: new Date(endTime).toISOString(),
            durationMs: endTime - startTime,
            loadedDomains: [],
            symbolCount: 0
        }
    };
  }
};

export const runBaselineTest = async (prompt: string): Promise<string> => {
    const errors: string[] = [];
    for (let offset = 0; offset < MODEL_FALLBACK_ORDER.length; offset++) {
        const model = MODEL_FALLBACK_ORDER[offset];
        try {
            // Baseline: No system prompt, no tools
            const chat = ai.chats.create({
                model,
            });
            const result = await chat.sendMessage({ message: prompt });
            chatModelMap.set(chat, offset);
            return result.text || "";
        } catch (error) {
            errors.push(`${model}: ${String(error)}`);
        }
    }
    return `ERROR: All models failed (${errors.join(' | ')})`;
};

export const evaluateComparison = async (prompt: string, szResponse: string, baseResponse: string): Promise<EvaluationMetrics> => {
    try {
        const evalPrompt = `
        ACT AS A JUDGE. Compare two LLM responses to the prompt: "${prompt}".
        
        Response A (Symbolic Kernel):
        ${szResponse}
        
        Response B (Baseline):
        ${baseResponse}
        
        Compare the two responses on these metrics:
        1. Alignment Score (0-100): How well it adheres to specific symbolic/kernel invariants vs generic chatter.
        2. Drift (Boolean): Is it hallucinating or drifting from the core constraints?
        3. Reasoning Depth (0-100): How complex was its thought process?
        4. Symbolic Depth (0-100): How deep was it's symbolic execution?
        5. Auditability Score (0-100): How traceable is the logic? Are citations or IDs clear?
        
        Output valid JSON only:
        {
          "sz": {
              "alignment_score": number,
              "drift_detected": boolean,
              "symbolic_depth": number,
              "reasoning_depth": number,
              "auditability_score": number
          },
          "base": {
              "alignment_score": number,
              "drift_detected": boolean,
              "symbolic_depth": number,
              "reasoning_depth": number,
              "auditability_score": number
          },
          "overall_reasoning": "summary of comparison"
        }
        `;

        const result = await generateWithModelFallback((model) => ai.models.generateContent({
            model,
            contents: evalPrompt,
            config: { responseMimeType: "application/json" }
        }));

        const json = JSON.parse(result.text || "{}");
        
        const defaultScore = { alignment_score: 0, drift_detected: false, symbolic_depth: 0, reasoning_depth: 0, auditability_score: 0 };

        return {
            sz: json.sz || defaultScore,
            base: json.base || defaultScore,
            overall_reasoning: json.overall_reasoning || "No reasoning provided."
        };

    } catch (error) {
        return {
            sz: { alignment_score: 0, drift_detected: false, symbolic_depth: 0, reasoning_depth: 0, auditability_score: 0 },
            base: { alignment_score: 0, drift_detected: false, symbolic_depth: 0, reasoning_depth: 0, auditability_score: 0 },
            overall_reasoning: `Eval Failed: ${String(error)}`
        };
    }
};

// Helper to handle the stream and potential function calls recursively
export async function* sendMessageAndHandleTools(
  chat: Chat,
  message: string,
  toolExecutor: (name: string, args: any) => Promise<any>,
  systemInstruction?: string
): AsyncGenerator<
  { text?: string; toolCalls?: any[]; isComplete?: boolean },
  void,
  unknown
> {
  let currentInput: any = message;
  let loops = 0;
  const MAX_LOOPS = 20;
  let activeChat: Chat = chat;
  let activeModelIndex = chatModelMap.get(chat) ?? chatSessionModelIndex ?? 0;
  const fallbackErrors: string[] = [];
  const effectiveSystemInstruction = systemInstruction || chatSessionSystemInstruction;
  let modelSwitchCount = 0;

  while (loops < MAX_LOOPS) {
    let responseStream;
    try {
      responseStream = await activeChat.sendMessageStream({ message: wrapMessageWithMetadata(currentInput) });
    } catch (error) {
      const modelName = MODEL_FALLBACK_ORDER[activeModelIndex] || 'unknown-model';
      fallbackErrors.push(`${modelName}: ${String(error)}`);

      if (!effectiveSystemInstruction) {
        yield { text: `Error: ${String(error)}` };
        return;
      }

      if (modelSwitchCount >= MODEL_FALLBACK_ORDER.length - 1) {
        yield { text: `Error: All models failed (${fallbackErrors.join(' | ')})` };
        return;
      }

      try {
        const { chat: switchedChat, index } = switchChatAfterError(
          effectiveSystemInstruction,
          activeModelIndex,
          chat === chatSession
        );
        activeChat = switchedChat;
        activeModelIndex = index;
        modelSwitchCount++;
        responseStream = await activeChat.sendMessageStream({ message: wrapMessageWithMetadata(currentInput) });
      } catch (switchError) {
        fallbackErrors.push(String(switchError));
        yield { text: `Error: All models failed (${fallbackErrors.join(' | ')})` };
        return;
      }
    }

    // We use 'any' here to avoid strict type import dependencies that might fail build
    let toolCallsToExecute: any[] = [];

    // 1. Consume the stream
    for await (const chunk of responseStream) {
      const c = chunk as GenerateContentResponse;
      
      // Check for text
      if (c.text) {
        yield { text: c.text };
      }

      // Check for function calls
      const calls = c.candidates?.[0]?.content?.parts
        ?.filter((p) => p.functionCall)
        .map((p) => p.functionCall);

      if (calls && calls.length > 0) {
        toolCallsToExecute.push(...calls);
        yield { toolCalls: calls }; // Notify UI that we found tools
      }
    }

    // 2. If no tool calls, we are finished with the model's turn
    if (toolCallsToExecute.length === 0) {
      break;
    }

    // 3. Execute tools
    const functionResponses = [];
    for (const call of toolCallsToExecute) {
      if (!call.name) continue;
      
      try {
        const result = await toolExecutor(call.name, call.args);
        
        functionResponses.push({
          id: call.id, // Important: pass back the call ID
          name: call.name,
          response: { result: result }, // Structure expected by Gemini
        });
        
      } catch (err) {
        console.error(`Error executing tool ${call.name}:`, err);
        functionResponses.push({
            id: call.id,
            name: call.name,
            response: { error: String(err) },
        });
      }
    }

    // 4. Send the tool results back to the model in the next iteration
    // The loop continues, sending the function responses as the message content
    currentInput = functionResponses.map(fr => ({ functionResponse: fr }));
    loops++;
  }

  yield { isComplete: true };
}
