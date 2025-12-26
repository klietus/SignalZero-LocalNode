
import { GoogleGenAI, Chat, GenerateContentResponse } from "@google/genai";
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

type ModelName = 'gemini-3-pro-preview' | 'gemini-2.5-pro' | 'gemini-2.5-flash';

const MODEL_FALLBACK_ORDER: ModelName[] = ['gemini-3-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'];

const chatModelMap = new WeakMap<Chat, number>();
let chatSessionModelIndex: number | null = null;
let chatSessionSystemInstruction: string | null = null;

// Create a persistent chat session
let chatSession: Chat | null = null;

const createChatInstance = (model: ModelName, systemInstruction: string) => {
  const config: Parameters<typeof ai.chats.create>[0]["config"] = {
    systemInstruction,
    tools: [{ functionDeclarations: toolDeclarations }],
  };

  if (!model.includes('flash')) {
    config.thinkingConfig = { thinkingBudget: 16000 };
  }

  const chat = ai.chats.create({
    model,
    config,
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
           - id, kind, name, role, triad, macro, activation_conditions
           - symbol_domain, symbol_tag, failure_mode, linked_patterns
           - facets: { function, topology, commit, gate, substrate, temporal, invariants }
        7. ACTIVATION CONDITIONS: activation_conditions belong at the root of every symbol object (patterns, lattices, personas). Do not nest activation_conditions under persona or lattice nodes.
        8. INFER MISSING FIELDS: If any required fields are not explicit in the gap analysis, INFER them based on the symbol's inferred 'symbolic signature' (triad/macro/role).
        
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
