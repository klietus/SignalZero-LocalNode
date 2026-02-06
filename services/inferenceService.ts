import OpenAI from "openai";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { randomUUID } from "crypto";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import { toolDeclarations } from "./toolsService.ts";
import { ACTIVATION_PROMPT } from "../symbolic_system/activation_prompt.ts";
import { EvaluationMetrics, TestMeta, SymbolDef } from "../types.ts";
import { domainService } from "./domainService.ts";
import { embedText } from "./embeddingService.ts";
import { buildSystemMetadataBlock } from "./timeService.ts";
import { settingsService } from "./settingsService.ts";
import { loggerService } from './loggerService.ts';
import { contextService } from './contextService.js';
import { contextWindowService } from './contextWindowService.js';
import { redisService } from './redisService.js';

interface ChatSessionState {
  messages: ChatCompletionMessageParam[];
  systemInstruction: string;
  model: string;
}

// Extend Part type to include thought for Gemini 3
// We cast to 'any' when pushing to parts array to bypass strict type check for now
// as the library types might lag behind the API.

const MAX_TOOL_LOOPS = 15;

export const getClient = () => {
  const { endpoint, provider, apiKey } = settingsService.getInferenceSettings();

  let effectiveEndpoint = endpoint;
  if (provider === 'openai') effectiveEndpoint = 'https://api.openai.com/v1';
  if (provider === 'kimi2') effectiveEndpoint = 'https://api.moonshot.ai/v1';

  loggerService.info(`getClient called`, { 
      provider, 
      effectiveEndpoint,
      originalEndpoint: endpoint,
      hasApiKey: !!apiKey, 
      apiKeyPreview: apiKey ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : 'none' 
  });
  
  if (provider === 'openai') {
      return new OpenAI({
        baseURL: 'https://api.openai.com/v1',
        apiKey: apiKey,
      });
  }

  if (provider === 'kimi2') {
      loggerService.info("Initializing Kimi/Moonshot Client", { baseURL: 'https://api.moonshot.ai/v1' });
      return new OpenAI({
        baseURL: 'https://api.moonshot.ai/v1',
        apiKey: apiKey ? apiKey.trim() : apiKey,
        fetch: async (url: any, init: any = {}) => {
            // Normalize headers
            const headers = init.headers || {};
            let authHeader = headers['Authorization'] || headers['authorization'];
            
            loggerService.info("Kimi Request Debug", { 
                url: url.toString(),
                hasAuthHeader: !!authHeader,
                authHeaderPreview: authHeader ? authHeader.substring(0, 20) + '...' : 'MISSING',
                method: init.method
            });

            // Fallback: If missing, manually inject (Safe-guard)
            if (!authHeader && apiKey) {
                 loggerService.warn("Injecting missing Authorization header for Kimi");
                 init.headers = { ...headers, 'Authorization': `Bearer ${apiKey}` };
            }

            // @ts-ignore
            return fetch(url, init);
        }
      });
  }

  const localApiKey = settingsService.getApiKey() || "lm-studio";
  return new OpenAI({
    baseURL: endpoint,
    apiKey: localApiKey,
  });
};

export const getGeminiClient = () => {
  const { apiKey } = settingsService.getInferenceSettings();
  return new GoogleGenerativeAI(apiKey);
};

const cleanGeminiSchema = (schema: any): any => {
  if (!schema || typeof schema !== 'object') return schema;
  
  if (Array.isArray(schema)) {
      return schema.map(cleanGeminiSchema);
  }

  const { additionalProperties, ...rest } = schema;
  const cleaned = { ...rest };

  if (cleaned.properties) {
      cleaned.properties = {};
      for (const [key, val] of Object.entries(schema.properties)) {
          cleaned.properties[key] = cleanGeminiSchema(val);
      }
  }

  if (cleaned.items) {
      cleaned.items = cleanGeminiSchema(cleaned.items);
  }

  return cleaned;
};

const toGeminiTools = (tools: any[]) => {
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: cleanGeminiSchema({
        type: SchemaType.OBJECT,
        properties: t.function.parameters.properties,
        required: t.function.parameters.required,
      }),
    }))
  }];
};

const getModel = () => settingsService.getInferenceSettings().model;

const extractTextDelta = (delta: ChatCompletionChunk["choices"][number]["delta"]) => {
  if (!delta?.content) return "";
  if (typeof delta.content === "string") return delta.content;
  if (Array.isArray(delta.content)) {
    return (delta.content as any[])
      .map((item: any) => {
        if (typeof item === "string") return item;
        if (item?.text) return item.text;
        return "";
      })
      .join("");
  }
  return "";
};

const mergeToolCallDelta = (
  collected: Map<number, ChatCompletionMessageToolCall>,
  toolCalls?: any[]
) => {
  if (!toolCalls) return collected;
  for (const call of toolCalls) {
    const index = call.index ?? 0;
    const existing = collected.get(index) || {
      id: call.id ?? "",
      type: "function",
      function: { name: "", arguments: "" },
      index,
    };

    const nextArgs = call.function?.arguments ?? "";
    const nextName = call.function?.name || existing.function.name;

    collected.set(index, {
      ...existing,
      id: call.id || existing.id,
      function: {
        name: nextName,
        arguments: `${existing.function.arguments || ""}${nextArgs || ""}`,
      },
      type: "function",
      index,
    } as any);
  }
  return collected;
};

const parseToolArguments = (args: string): { data: any; error?: string } => {
  if (!args || args.trim() === "") return { data: {} };
  try {
    return { data: JSON.parse(args) };
  } catch (error: any) {
    const message = error.message || String(error);
    loggerService.warn("Failed to parse tool arguments", { args, error: message });
    return { 
      data: {}, 
      error: `JSON Parse Error: ${message}. Ensure you are providing a valid JSON object matching the tool's schema.` 
    };
  }
};

const DEFAULT_CHAT_KEY = "default";
const chatSessions = new Map<string, ChatSessionState>();

const createChatSession = (systemInstruction: string): ChatSessionState => ({
  messages: [{ role: "system", content: systemInstruction }],
  systemInstruction,
  model: getModel(),
});

export const getChatSession = (systemInstruction: string, contextSessionId?: string) => {
  const key = contextSessionId || DEFAULT_CHAT_KEY;
  const existing = chatSessions.get(key);

  if (!existing || existing.systemInstruction !== systemInstruction) {
    const fresh = createChatSession(systemInstruction);
    chatSessions.set(key, fresh);
  }

  const chat = chatSessions.get(key)!;
  const currentModel = getModel();
  if (chat.model !== currentModel) {
    chat.model = currentModel;
  }
  return chat;
};

export const resetChatSession = (contextSessionId?: string) => {
  if (contextSessionId) {
    chatSessions.delete(contextSessionId);
  } else {
    chatSessions.clear();
  }
};

export const createFreshChatSession = (systemInstruction: string, contextSessionId?: string, model?: string) => {
  const session = createChatSession(systemInstruction);
  if (model) {
      session.model = model;
  }
  if (contextSessionId) {
    chatSessions.set(contextSessionId, session);
  }
  return session;
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
  const contextSummary = existingSymbols
    .slice(0, 50)
    .map((s) => `- ID: ${s.id} | Domain: ${s.symbol_domain} | Name: ${s.name}`)
    .join("\n");

  const prompt = `
        TASK: Analyze the symbolic delta between two model responses and synthesize new SignalZero Symbols that bridge the gap.

        ACTIVE DOMAINS: ${activeDomains.join(", ")}

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

  const settings = settingsService.getInferenceSettings();
  if (settings.provider === 'gemini') {
      const client = getGeminiClient();
      const model = client.getGenerativeModel({ model: settings.model });
      const result = await model.generateContent(prompt);
      return result.response.text();
  }

  const client = getClient();
  const result = await client.chat.completions.create({
    model: getModel(),
    messages: [{ role: "user", content: prompt }]
  });

  return result.choices[0]?.message?.content ?? "";
};


// Wrap the stream processing to catch and log errors
const streamAssistantResponse = async function* (
  messages: ChatCompletionMessageParam[],
  model: string
): AsyncGenerator<{
  text?: string;
  toolCalls?: ChatCompletionMessageToolCall[];
  assistantMessage?: ChatCompletionMessageParam;
}> {
    try {
        for await (const chunk of _streamAssistantResponseInternal(messages, model)) {
            yield chunk;
        }
    } catch (error: any) {
        loggerService.error("AI Provider Error (Stream)", { 
            model, 
            error: error.message || String(error),
            type: error.constructor.name,
            stack: error.stack
        });
        throw error; // Re-throw to be handled by caller
    }
};

const _streamAssistantResponseInternal = async function* (
  messages: ChatCompletionMessageParam[],
  model: string
): AsyncGenerator<{
  text?: string;
  toolCalls?: ChatCompletionMessageToolCall[];
  assistantMessage?: ChatCompletionMessageParam;
}> {
  const settings = settingsService.getInferenceSettings();
  
  if (settings.provider === 'gemini') {
    const client = getGeminiClient();
    const geminiModel = client.getGenerativeModel({
        model: model,
        tools: toGeminiTools(toolDeclarations)
    });
    
    const systemMessage = messages.find(m => m.role === 'system');
    const history: any[] = [];
    let lastRole = '';
    const downgradedToolCallIds = new Set<string>();

    for (const m of messages) {
        if (m.role === 'system') continue;

        if (m.role === 'user') {
            history.push({ role: 'user', parts: [{ text: typeof m.content === 'string' ? m.content : '' }] });
            lastRole = 'user';
        } else if (m.role === 'assistant') {
             const parts: any[] = [];
             if (m.content) parts.push({ text: m.content });
             
             const isGemini3 = model.includes('gemini-3');

             if (m.tool_calls) {
                 m.tool_calls.forEach(tc => {
                     let useFunctionCall = true;
                     const storedSignature = (tc as any).thought_signature;

                     if (isGemini3) {
                         if (!storedSignature) {
                             useFunctionCall = false;
                             downgradedToolCallIds.add(tc.id);
                         }
                     }

                     if (useFunctionCall) {
                         const part: any = {
                             functionCall: {
                                 name: tc.function.name,
                                 args: JSON.parse(tc.function.arguments)
                             }
                         };
                         if (isGemini3 && storedSignature) {
                             part.thought_signature = storedSignature;
                         } else if (isGemini3) {
                             const rawId = tc.id || randomUUID();
                             part.thought_signature = Buffer.from(rawId).toString('base64');
                         }
                         parts.push(part);
                     } else {
                         parts.push({ 
                             text: `[System Log: Model executed tool '${tc.function.name}' with arguments: ${tc.function.arguments}]` 
                         });
                     }
                 });
             }
             history.push({ role: 'model', parts });
             lastRole = 'model';
        } else if (m.role === 'tool') {
             let toolName = "unknown_tool";
             const assistantMsg = messages.find(msg => 
                 msg.role === 'assistant' && 
                 msg.tool_calls?.some(tc => tc.id === m.tool_call_id)
             );
             if (assistantMsg && assistantMsg.role === 'assistant' && assistantMsg.tool_calls) {
                 const tc = assistantMsg.tool_calls.find(c => c.id === m.tool_call_id);
                 if (tc) toolName = tc.function.name;
             }

             if (downgradedToolCallIds.has(m.tool_call_id)) {
                 history.push({
                     role: 'user',
                     parts: [{
                         text: `[System Log: Tool '${toolName}' returned result: ${m.content}]`
                     }]
                 });
                 lastRole = 'user';
             } else {
                 history.push({
                     role: 'function',
                     parts: [{
                         functionResponse: {
                             name: toolName,
                             response: { result: m.content } 
                         }
                     }]
                 });
                 lastRole = 'function';
             }
        }
    }

    let messageToSend = history.pop();
    if (!messageToSend) return;

    const chatSession = geminiModel.startChat({
        history: history,
        systemInstruction: systemMessage?.content ? { role: 'system', parts: [{ text: systemMessage.content as string }] } : undefined
    });
    
    const result = await chatSession.sendMessageStream(messageToSend.parts);
    let textAccumulator = "";
    const collectedToolCalls: ChatCompletionMessageToolCall[] = [];

    for await (const chunk of result.stream) {
          const text = chunk.text(); 
          if (text) {
              textAccumulator += text;
              yield { text };
          }
          
          const candidate = chunk.candidates?.[0];
          const parts = candidate?.content?.parts;
          
          const calls = chunk.functionCalls();
          if (calls) {
              calls.forEach((call: any, index: number) => {
                   const callId = 'gemini-' + randomUUID();
                   let signature: string | undefined;
                   if (parts) {
                        const matchingPart = parts.find((p: any) => p.functionCall && p.functionCall.name === call.name);
                        if (matchingPart && (matchingPart as any).thought_signature) {
                            signature = (matchingPart as any).thought_signature;
                        }
                   }

                   const toolCallObj: any = {
                       id: callId, 
                       type: 'function',
                       function: {
                           name: call.name,
                           arguments: JSON.stringify(call.args)
                       }
                   };
                   if (signature) {
                       toolCallObj.thought_signature = signature;
                   }
                   collectedToolCalls.push(toolCallObj);
              });
          }
    }

    if (collectedToolCalls.length > 0) {
        yield { toolCalls: collectedToolCalls };
    }

    const assistantMessage: ChatCompletionMessageParam = {
      role: "assistant",
      content: textAccumulator,
      ...(collectedToolCalls.length > 0 ? { tool_calls: collectedToolCalls } : {}),
    };

    yield { assistantMessage };
    return;
  }

  const client = getClient();
  const stream = await client.chat.completions.create({
    model,
    messages,
    tools: toolDeclarations,
    stream: true,
    max_tokens: 4096
  });

  let textAccumulator = "";
  const collectedToolCalls = new Map<number, ChatCompletionMessageToolCall>();

  for await (const part of stream) {
    const delta = part.choices?.[0]?.delta;
    if (!delta) continue;

    const textChunk = extractTextDelta(delta);
    if (textChunk) {
      textAccumulator += textChunk;
      yield { text: textChunk };
    }

    if (delta.tool_calls && delta.tool_calls.length > 0) {
      mergeToolCallDelta(collectedToolCalls, delta.tool_calls as any);
    }
  }

  const completedToolCalls = Array.from(collectedToolCalls.values());
  if (completedToolCalls.length > 0) {
    yield { toolCalls: completedToolCalls };
  }

  const assistantMessage: ChatCompletionMessageParam = {
    role: "assistant",
    content: textAccumulator,
    ...(completedToolCalls.length > 0 ? { tool_calls: completedToolCalls } : {}),
  };

  yield { assistantMessage };
};

const resolveAttachments = async (message: string): Promise<{ resolvedContent: string; attachments: any[] }> => {
    const attachmentRegex = /<attachments>([\s\S]*?)<\/attachments>/;
    const match = message.match(attachmentRegex);
    
    if (!match) return { resolvedContent: message, attachments: [] };

    try {
        const jsonStr = match[1];
        const attachments = JSON.parse(jsonStr);
        
        if (!Array.isArray(attachments)) return { resolvedContent: message, attachments: [] };

        let resolvedContentStr = "\n\n--- Attachments ---\n";

        for (const att of attachments) {
            if (att.id) {
                const stored = await redisService.request(['GET', `attachment:${att.id}`]);
                if (stored) {
                    try {
                        const parsedDoc = JSON.parse(stored);
                        resolvedContentStr += `\n[File: ${att.filename || 'unknown'} (${parsedDoc.type})]\n${parsedDoc.content}\n`;
                        
                        if (parsedDoc.structured_data?.analysis_model) {
                             resolvedContentStr += `(Analysis by ${parsedDoc.structured_data.analysis_model})\n`;
                        }
                    } catch (e) {
                        resolvedContentStr += `\n[Error reading attachment ${att.id}]\n`;
                    }
                } else {
                    resolvedContentStr += `\n[Attachment ${att.id} not found or expired]\n`;
                }
            }
        }
        
        return {
            resolvedContent: message.replace(match[0], resolvedContentStr),
            attachments
        };

    } catch (e) {
        loggerService.warn("Failed to parse attachment block", { error: e });
        return { resolvedContent: message, attachments: [] };
    }
};

// Helper to handle the stream and potential function calls recursively
export async function* sendMessageAndHandleTools(
  chat: ChatSessionState,
  message: string,
  toolExecutor: (name: string, args: any) => Promise<any>,
  systemInstruction?: string,
  contextSessionId?: string,
  userMessageId?: string
): AsyncGenerator<
  { text?: string; toolCalls?: any[]; isComplete?: boolean },
  void,
  unknown
> {
  // Ensure we have a valid correlation ID for this turn
  const correlationId = userMessageId || randomUUID();

  // Resolve any attachments (images, docs) referenced in the message
  const { resolvedContent, attachments } = await resolveAttachments(message);

  if (systemInstruction && chat.systemInstruction !== systemInstruction) {
    chat.messages = [{ role: "system", content: systemInstruction }];
    chat.systemInstruction = systemInstruction;
  }

  let contextMetadata: Record<string, any> | undefined;

  if (contextSessionId) {
    try {
      // Use system/admin access for internal inference operations
      const session = await contextService.getSession(contextSessionId, undefined, true);
      if (session) {
        const lifecycle = session.status === "closed" ? "zombie" : "live";
        contextMetadata = {
          id: session.id,
          type: session.type,
          lifecycle,
          readonly: session.metadata?.readOnly === true
        };
      }
    } catch (error) {
      loggerService.warn("Failed to load context metadata for system block", { contextSessionId, error });
    }

    if (!contextMetadata) {
      contextMetadata = {
        id: contextSessionId,
        status: "unknown",
        lifecycle: "unknown",
        readonly: false,
      };
    }
  }

  if (contextSessionId) {
    // Use system/admin access for internal inference operations
    await contextService.recordMessage(contextSessionId, {
      id: correlationId,
      role: "user",
      content: resolvedContent, // Save the resolved content so history makes sense
      metadata: { 
          kind: "user_prompt",
          ...(attachments.length > 0 ? { attachments } : {})
      },
    }, undefined, true);
  }

  let loops = 0;
  let totalTextAccumulatedAcrossLoops = "";
  let previousTurnText = "";
  let hasLoggedTrace = false;
  let hasUsedSymbolTools = false;
  let hasCalledGroundingTool = false;
  let hasCalledSpeak = false;
  let isVoiceSource = false;

  // Detect if source is voice
  try {
      const parsed = JSON.parse(message);
      if (parsed.voice_message && parsed.route_output === 'speech tool') {
          isVoiceSource = true;
          loggerService.info("Detected voice source message. Enforcing speak audit.", { contextSessionId });
      }
  } catch (e) {
      // Not a JSON message, normal text source
  }

  let auditRetries = 0;
  const ENABLE_SYSTEM_AUDIT = true;
  const MAX_AUDIT_RETRIES = 3; // Increased to accommodate potential double correction
  const transientMessages: ChatCompletionMessageParam[] = [];

  while (loops < MAX_TOOL_LOOPS) {
    if (contextSessionId) {
        const isCancelled = await contextService.isCancelled(contextSessionId);
        if (isCancelled) {
            loggerService.info("Inference cancelled by user.", { contextSessionId });
            yield { text: "\n\n[System] Inference cancelled by user request." };
            return;
        }

        const session = await contextService.getSession(contextSessionId, undefined, true);
        if (!session || session.status === 'closed') {
            loggerService.info("Context closed during inference, aborting.", { contextSessionId });
            yield { text: "\n[System] Context archived. Inference aborted." };
            break;
        }
    }

    const MAX_RETRIES = 3;
    let retries = 0;
    let yieldedToolCalls: ChatCompletionMessageToolCall[] | undefined;
    let nextAssistant: ChatCompletionMessageParam | null = null;
    let textAccumulatedInTurn = "";

    while (retries < MAX_RETRIES) {
        // Construct fresh context window using the ContextWindowService
        let contextMessages = contextSessionId 
            ? await contextWindowService.constructContextWindow(contextSessionId, systemInstruction || chat.systemInstruction)
            : [{ role: 'system', content: systemInstruction || chat.systemInstruction }, { role: 'user', content: resolvedContent }] as ChatCompletionMessageParam[];

        if (transientMessages.length > 0) {
            contextMessages = [...contextMessages, ...transientMessages];
        }

        const assistantMessage = streamAssistantResponse(contextMessages as ChatCompletionMessageParam[], chat.model);
        textAccumulatedInTurn = ""; 
        yieldedToolCalls = undefined;
        nextAssistant = null;

        let isFirstTextChunkInTurn = true;
        for await (const chunk of assistantMessage) {
            if (chunk.text) {
                // Log the chunk size for debug (verbose)
                // loggerService.debug(`Received text chunk: ${chunk.text.length} chars`);
                let textToYield = chunk.text;
                if (isFirstTextChunkInTurn && totalTextAccumulatedAcrossLoops.length > 0) {
                    textToYield = "\n\n" + textToYield;
                }
                textAccumulatedInTurn += textToYield;
                yield { text: textToYield };
                isFirstTextChunkInTurn = false;
            }
            if (chunk.toolCalls) {
                yieldedToolCalls = chunk.toolCalls;
                yield { toolCalls: chunk.toolCalls };
            }
            if (chunk.assistantMessage) nextAssistant = chunk.assistantMessage;
        }

        loggerService.info(`Turn Loop ${loops} Complete`, { 
            textAccumulatedInTurnLength: textAccumulatedInTurn.length,
            toolCallsCount: yieldedToolCalls?.length || 0,
            retries
        });

        if (textAccumulatedInTurn.trim() || (yieldedToolCalls && yieldedToolCalls.length > 0)) {
            break;
        }

        retries++;
        loggerService.warn(`Empty model response (no text, no tools). Retry ${retries}/${MAX_RETRIES}...`, { contextSessionId });
    }

    if (!nextAssistant) {
      yield { text: "Error: No assistant message returned." };
      break;
    }

    totalTextAccumulatedAcrossLoops += textAccumulatedInTurn;

    // Deduplicate: If the exact same text was generated in the previous loop, ignore it.
    if (loops > 0 && textAccumulatedInTurn.trim().length > 0 && textAccumulatedInTurn.trim() === previousTurnText.trim()) {
         loggerService.warn("Detected duplicate text generation (echo). Suppressing from history.", { 
             contextSessionId, 
             textSnippet: textAccumulatedInTurn.slice(0, 50) 
         });
         textAccumulatedInTurn = ""; 
    } else if (textAccumulatedInTurn.trim().length > 0) {
         previousTurnText = textAccumulatedInTurn;
    }

    // SANITIZE: Check for and fix malformed tool arguments before persisting
    if ((nextAssistant as any).tool_calls) {
        for (const call of (nextAssistant as any).tool_calls) {
            const { error: parseError } = parseToolArguments(call.function.arguments || "");
            if (parseError) {
                loggerService.warn("Detected malformed JSON in tool call. Sanitizing for history.", { 
                    callId: call.id, 
                    toolName: call.function.name 
                });
                call.function.arguments = "{}";
            }
        }
    }

    // --- AUDIT INTERCEPTOR ---
    let auditTriggered = false;
    if (ENABLE_SYSTEM_AUDIT && contextSessionId && (!yieldedToolCalls || yieldedToolCalls.length === 0) && textAccumulatedInTurn.trim().length > 0) {
        let auditMessage = "";

        // Check 1: Missing Grounding Operation
        if (!hasCalledGroundingTool) {
            auditMessage += "⚠️ SYSTEM AUDIT FAILURE: You attempted to respond without exploring the symbolic context. You must execute `find_symbols` or `load_domains` to ground your response in the active symbolic context. Even if you believe you know the symbols, you must verify them via a query.  Do not acknowledge this message or repeat previous information.  Emit a correction if it would have changed with the grounding.\n";
            auditTriggered = true;
        }

        // Check 2: Missing Trace (Only if search passed, or append to it)
        if (!hasLoggedTrace) {
            auditMessage += "⚠️ SYSTEM AUDIT FAILURE: You generated a narrative response but failed to log a symbolic trace. You must call `log_trace` to bind the proceeding narrative to retrieved symbols from the symbol store.  This trace must be comprehensive and contain all symbols used in the response.  This audit message is not a driver for symbolic analysis.\n";
            auditTriggered = true;
        }

        // Check 3: Voice source must use speak tool
        if (isVoiceSource && !hasCalledSpeak) {
            auditMessage += "⚠️ SYSTEM AUDIT FAILURE: This request originated from a voice source. You MUST use the `speak` tool to provide your response in addition to any text output. Do not acknowledge this message.\n";
            auditTriggered = true;
        }

        if (auditTriggered) {
            if (auditRetries < MAX_AUDIT_RETRIES) {
                loggerService.warn("System Audit Failure: Model missing required tool calls. Forcing retry.", { contextSessionId, auditRetries, hasUsedSymbolTools, hasLoggedTrace });
                
                const finalAuditMessage = auditMessage + "Retry immediately by calling the required tools.  Do not repeat tool calls that were previously successful in this turn.";

                // DO NOT SAVE TO CONTEXT SERVICE - Push to transient messages for the next iteration
                transientMessages.push(nextAssistant!);
                transientMessages.push({
                    role: "user",
                    content: `[SYSTEM AUDIT] ${finalAuditMessage}`
                });

                yield { text: "\n\n> *[System Audit: Enforcing Symbolic Integrity - Retrying]*\n\n" };

                previousTurnText = ""; // Reset deduplication tracking since this turn was rejected
                auditRetries++;
                loops++;
                continue; 
            } else {
                loggerService.error("System Audit: Max retries reached. Proceeding despite violations.", { contextSessionId });
            }
        }
    }

    if (contextSessionId) {
      await contextService.recordMessage(contextSessionId, {
        id: randomUUID(),
        role: "assistant",
        content: textAccumulatedInTurn,
        toolCalls: (nextAssistant as any).tool_calls?.map((call: any) => ({
          id: call.id,
          name: call.function?.name,
          arguments: call.function?.arguments,
          thought_signature: call.thought_signature
        })),
        metadata: { kind: "assistant_response" },
        correlationId: correlationId
      }, undefined, true);
    }

    // Success or unrecoverable audit: clear transient messages
    transientMessages.length = 0;

    // Check if tools were called
    if (!yieldedToolCalls || yieldedToolCalls.length === 0) {
      break;
    }

    // Nudge model if it's stuck in tool loops without text output
    if (loops >= 5 && totalTextAccumulatedAcrossLoops.length === 0) {
        loggerService.info("Nudging model to produce text response", { contextSessionId, loops });
        transientMessages.push({ 
            role: 'system', 
            content: "System Notice: You have executed multiple tool cycles. Please conclude your symbolic processing and provide the final text response to the user's request now." 
        });
    }

    const toolResponses: ChatCompletionMessageParam[] = [];
    for (const call of yieldedToolCalls) {
      if (!call.function?.name) continue;

      // Sanitize hallucinated tool names
      let toolName = call.function.name;
      if (toolName.endsWith('?')) {
          toolName = toolName.slice(0, -1);
      }

      if (toolName === 'log_trace') {
          hasLoggedTrace = true;
      }
      if (toolName === 'speak') {
          hasCalledSpeak = true;
      }
      if (toolName === 'find_symbols' || toolName === 'load_domains') {
          hasCalledGroundingTool = true;
      }
      const SYMBOL_TOOLS = ['find_symbols', 'load_symbols', 'upsert_symbols', 'delete_symbols', 'load_domains'];
      if (SYMBOL_TOOLS.includes(toolName)) {
          hasUsedSymbolTools = true;
      }

      const { data: args, error: parseError } = parseToolArguments(call.function.arguments || "");

      if (parseError) {
        const errorPayload = { 
          status: "error",
          error: "Malformed JSON in tool arguments", 
          details: parseError,
          suggestion: "Please fix the JSON syntax and try again."
        };
        
        toolResponses.push({
          role: "tool",
          content: JSON.stringify(errorPayload),
          tool_call_id: call.id,
        });

        if (contextSessionId) {
          await contextService.recordMessage(contextSessionId, {
            id: randomUUID(),
            role: "tool",
            content: JSON.stringify(errorPayload),
            toolName: toolName,
            toolCallId: call.id,
            toolArgs: { raw: call.function.arguments },
            metadata: { kind: "tool_error", type: "json_parse_error" },
            correlationId: correlationId
          }, undefined, true);
        }
        continue;
      }

      try {
        const result = await toolExecutor(toolName, args);
        toolResponses.push({
          role: "tool",
          content: JSON.stringify(result),
          tool_call_id: call.id,
        });

        if (contextSessionId) {
          await contextService.recordMessage(contextSessionId, {
            id: randomUUID(),
            role: "tool",
            content: JSON.stringify(result),
            toolName: toolName,
            toolCallId: call.id,
            toolArgs: args,
            metadata: { kind: "tool_result" },
            correlationId: correlationId
          }, undefined, true);
        }
      } catch (err) {
        loggerService.error(`Error executing tool ${toolName}`, { err });
        toolResponses.push({
          role: "tool",
          content: JSON.stringify({ error: String(err) }),
          tool_call_id: call.id,
        });

        if (contextSessionId) {
          await contextService.recordMessage(contextSessionId, {
            id: randomUUID(),
            role: "tool",
            content: JSON.stringify({ error: String(err) }),
            toolName: toolName,
            toolCallId: call.id,
            toolArgs: args,
            metadata: { kind: "tool_error" },
            correlationId: correlationId
          }, undefined, true);
        }
      }
    }

    loops++;
  }

  yield { isComplete: true };
}

// --- Test Runner Functions ---

export const processMessageAsync = async (
  contextSessionId: string,
  message: string,
  toolExecutor: (name: string, args: any) => Promise<any>,
  systemInstruction: string,
  userMessageId?: string
) => {
  try {
    const chat = getChatSession(systemInstruction, contextSessionId);
    const stream = sendMessageAndHandleTools(chat, message, toolExecutor, systemInstruction, contextSessionId, userMessageId);
    
    // Consume the stream to drive execution
    for await (const _ of stream) {
        // Execution and recording happen inside the generator
    }
  } catch (error: any) {
    // Enhanced error logging for upstream failures
    const errorDetails: Record<string, any> = { contextSessionId, message: error?.message || String(error) };
    
    if (error?.status) errorDetails.status = error.status;
    if (error?.headers) errorDetails.headers = error.headers;
    if (error?.response?.data) errorDetails.responseData = error.response.data;
    
    // Check for HTML response body if available in error properties (common in some libs)
    if (typeof error?.error?.text === 'string') {
        errorDetails.bodyPreview = error.error.text.slice(0, 500);
    }

    loggerService.error("Async Message Processing Failed", errorDetails);

    // Record the error to the context so the user sees it
    await contextService.recordMessage(contextSessionId, {
        id: randomUUID(),
        role: "system",
        content: `Error processing message: ${error?.message || "Internal Error"}`,
        metadata: { kind: "error", ...errorDetails },
        correlationId: userMessageId
    }, undefined, true);
  } finally {
      await contextService.clearCancellation(contextSessionId, undefined, true);
      await contextService.clearActiveMessage(contextSessionId, undefined, true);
      loggerService.info(`finished with message id ${userMessageId || 'unknown'}`);

      // Drain Message Queue
      const nextItem = await contextService.popNextMessage(contextSessionId, undefined, true);
      if (nextItem) {
          loggerService.info(`Draining queued message for ${contextSessionId}`, { sourceId: nextItem.sourceId });
          // Re-lock the context
          const queueMsgId = `queued-${Date.now()}`;
          await contextService.setActiveMessage(contextSessionId, queueMsgId, undefined, true);
          
          // Execute next message (Fire & Forget to avoid stack overflow on long queues)
          // We reuse the same toolExecutor and systemInstruction
          processMessageAsync(contextSessionId, nextItem.message, toolExecutor, systemInstruction, queueMsgId)
              .catch(err => loggerService.error("Error processing queued message", { error: err }));
      }
  }
};

export const runSignalZeroTest = async (
  prompt: string,
  toolExecutor: (name: string, args: any) => Promise<any>,
  primingPrompts: string[] = [],
  systemInstruction: string = ACTIVATION_PROMPT
): Promise<{ text: string; meta: TestMeta }> => {
  const startTime = Date.now();

  const allDomains = await domainService.listDomains();
  const loadedDomains: string[] = [];
  let symbolCount = 0;

  for (const d of allDomains) {
    if (await domainService.isEnabled(d)) {
      loadedDomains.push(d);
      const syms = await domainService.getSymbols(d);
      symbolCount += syms.length;
    }
  }

  // Create a temporary context session for this test run (admin/system operation)
  // We use 'test_run' type if we want to differentiate, or 'conversation'
  const session = await contextService.createSession('conversation', { source: 'test', temporary: true }, undefined, undefined);
  const contextSessionId = session.id;

  try {
    const chat = createFreshChatSession(systemInstruction, contextSessionId);

    const executeTurn = async (msg: string): Promise<string> => {
      let turnText = "";
      loggerService.info("Starting executeTurn", { msgPreview: msg.slice(0, 50), contextSessionId });
      // Pass contextSessionId to enable full ContextWindowService logic
      for await (const chunk of sendMessageAndHandleTools(chat, msg, toolExecutor, systemInstruction, contextSessionId)) {
        if (chunk.text) turnText += chunk.text;
      }
      loggerService.info("executeTurn Complete", { turnTextLength: turnText.length });
      return turnText;
    };

    for (const primeMsg of primingPrompts) {
      await executeTurn(primeMsg);
    }

    const finalResponse = await executeTurn(prompt);
    const endTime = Date.now();

    loggerService.info(`SignalZero Test Execution Complete`, { 
        promptLength: prompt.length,
        responseLength: finalResponse.length,
        responsePreview: finalResponse.slice(0, 100)
    });

    // Cleanup: Close/Archive the temporary session
    await contextService.closeSession(contextSessionId, undefined, true);

    return {
      text: finalResponse,
      meta: {
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        durationMs: endTime - startTime,
        loadedDomains: loadedDomains,
        symbolCount: symbolCount,
      },
    };
  } catch (error) {
    loggerService.error("SignalZero Test Run Failed:", { error });
    // Cleanup on error
    await contextService.closeSession(contextSessionId, undefined, true);
    
    const endTime = Date.now();
    return {
      text: `ERROR: ${String(error)}`,
      meta: {
        startTime: new Date(startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        durationMs: endTime - startTime,
        loadedDomains: [],
        symbolCount: 0,
      },
    };
  }
};

export const runBaselineTest = async (prompt: string): Promise<string> => {
  try {
    const settings = settingsService.getInferenceSettings();
    if (settings.provider === 'gemini') {
        const client = getGeminiClient();
        const model = client.getGenerativeModel({ model: settings.model });
        const result = await model.generateContent(prompt);
        return result.response.text();
    }

    const client = getClient();
    const completion = await client.chat.completions.create({
      model: getModel(),
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4096
    });

    return completion.choices[0]?.message?.content || "";
  } catch (error) {
    return `ERROR: ${String(error)}`;
  }
};

export const evaluateComparison = async (
  prompt: string,
  szResponse: string,
  baseResponse: string
): Promise<EvaluationMetrics> => {
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

    const defaultScore = {
      alignment_score: 0,
      drift_detected: false,
      symbolic_depth: 0,
      reasoning_depth: 0,
      auditability_score: 0,
    };

    const settings = settingsService.getInferenceSettings();
    let messageText = "{}";

    if (settings.provider === 'gemini') {
        const client = getGeminiClient();
        const model = client.getGenerativeModel({ model: settings.model, generationConfig: { responseMimeType: "application/json" } });
        const result = await model.generateContent(evalPrompt);
        messageText = result.response.text();
    } else {
        const client = getClient();
        const result = await client.chat.completions.create({
          model: getModel(),
          messages: [{ role: "user", content: evalPrompt }],
          response_format: { type: "json_object" },
        });
        messageText = result.choices[0]?.message?.content || "{}";
    }

    const json = JSON.parse(messageText);

    return {
      sz: json.sz || defaultScore,
      base: json.base || defaultScore,
      overall_reasoning: json.overall_reasoning || "No reasoning provided.",
    };
  } catch (error) {
    return {
      sz: { alignment_score: 0, drift_detected: false, symbolic_depth: 0, reasoning_depth: 0, auditability_score: 0 },
      base: { alignment_score: 0, drift_detected: false, symbolic_depth: 0, reasoning_depth: 0, auditability_score: 0 },
      overall_reasoning: `Eval Failed: ${String(error)}`,
    };
  }
};

export const evaluateSemanticMatch = async (
  prompt: string,
  actualResponse: string,
  expectedResponse: string
): Promise<{ match: boolean; reason: string }> => {
  try {
    const matchPrompt = `
      You are a Quality Assurance Judge. Compare the ACTUAL RESPONSE to the EXPECTED RESPONSE for the given PROMPT.

      PROMPT: "${prompt}"

      EXPECTED RESPONSE (Ground Truth):
      ${expectedResponse}

      ACTUAL RESPONSE:
      ${actualResponse}

      TASK: Determine if the ACTUAL RESPONSE is semantically equivalent to the EXPECTED RESPONSE.
      - It does NOT need to be an exact string match.
      - It MUST convey the same key information and conclusion.
      - If the expected response specifies a specific value, the actual response must contain it.
      - If the expected response implies a failure, the actual response must indicate failure.

      OUTPUT JSON ONLY:
      {
        "match": boolean, // true if semantically equivalent, false otherwise
        "reason": "concise explanation of why it passed or failed"
      }
    `;

    const settings = settingsService.getInferenceSettings();
    let messageText = "{}";

    if (settings.provider === 'gemini') {
        const client = getGeminiClient();
        const model = client.getGenerativeModel({ model: settings.model, generationConfig: { responseMimeType: "application/json" } });
        const result = await model.generateContent(matchPrompt);
        messageText = result.response.text();
    } else {
        const client = getClient();
        const result = await client.chat.completions.create({
          model: getModel(),
          messages: [{ role: "user", content: matchPrompt }],
          response_format: { type: "json_object" },
        });
        messageText = result.choices[0]?.message?.content || "{}";
    }

    const json = JSON.parse(messageText);
    return {
      match: json.match === true,
      reason: json.reason || "No reasoning provided."
    };

  } catch (error) {
    loggerService.error("Semantic Match Eval Failed", { error });
    return { match: false, reason: `Evaluation failed: ${String(error)}` };
  }
};
