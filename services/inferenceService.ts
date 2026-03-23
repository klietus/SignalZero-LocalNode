import OpenAI from "openai";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { randomUUID } from "crypto";
import type {
  ChatCompletionChunk,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import { PRIMARY_TOOLS, SECONDARY_TOOLS_MAP } from "./toolsService.js";
import { ACTIVATION_PROMPT } from "../symbolic_system/activation_prompt.js";
import { EvaluationMetrics, TestMeta, SymbolDef } from "../types.js";
import { domainService } from "./domainService.js";
import { embedText } from "./embeddingService.js";
import { buildSystemMetadataBlock } from "./timeService.js";
import { settingsService } from "./settingsService.js";
import { loggerService } from './loggerService.ts';
import { contextService } from './contextService.js';
import { symbolCacheService } from './symbolCacheService.js';
import { tentativeLinkService } from './tentativeLinkService.js';
import { contextWindowService } from './contextWindowService.js';
import { redisService } from './redisService.js';
import { mcpClientService } from './mcpClientService.js';

interface ChatSessionState {
  messages: ChatCompletionMessageParam[];
  systemInstruction: string;
  model: string;
}

// Extend Part type to include thought for Gemini 3
// We cast to 'any' when pushing to parts array to bypass strict type check for now
// as the library types might lag behind the API.

const MAX_TOOL_LOOPS = 15;

export const getClient = async () => {
  const { endpoint, provider, apiKey } = await settingsService.getInferenceSettings();

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
      // @ts-ignore
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

export const getGeminiClient = async () => {
  const { apiKey } = await settingsService.getInferenceSettings();
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
  loggerService.debug("toGeminiTools: Converting tools", { count: tools.length });
  return [{
    functionDeclarations: tools.map((t) => {
      const decl = {
        name: t.function.name,
        description: t.function.description,
        parameters: cleanGeminiSchema({
          type: SchemaType.OBJECT,
          properties: t.function.parameters.properties,
          required: t.function.parameters.required,
        }),
      };
      return decl;
    })
  }];
};

const getModel = async () => (await settingsService.getInferenceSettings()).model;

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

const createChatSession = async (systemInstruction: string): Promise<ChatSessionState> => ({
  messages: [{ role: "system", content: systemInstruction }],
  systemInstruction,
  model: await getModel(),
});

export const getChatSession = async (systemInstruction: string, contextSessionId?: string) => {
  const key = contextSessionId || DEFAULT_CHAT_KEY;
  const existing = chatSessions.get(key);

  if (!existing || existing.systemInstruction !== systemInstruction) {
    const fresh = await createChatSession(systemInstruction);
    chatSessions.set(key, fresh);
  }

  const chat = chatSessions.get(key)!;
  const currentModel = await getModel();
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

export const createFreshChatSession = async (systemInstruction: string, contextSessionId?: string, model?: string) => {
  const session = await createChatSession(systemInstruction);
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

  const settings = await settingsService.getInferenceSettings();
  if (settings.provider === 'gemini') {
    const client = await getGeminiClient();
    const model = client.getGenerativeModel({ model: settings.model });
    const result = await model.generateContent(prompt);
    return result.response.text();
  }

  const client = await getClient();
  const result = await client.chat.completions.create({
    model: await getModel(),
    messages: [{ role: "user", content: prompt }]
  });

  return result.choices[0]?.message?.content ?? "";
};


export const normalizeMessages = (messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] => {
  if (messages.length === 0) return messages;

  const normalized: ChatCompletionMessageParam[] = [];
  let systemContent = "";

  // 1. Collect all system messages and merge them
  const otherMessages = messages.filter(m => {
    if (m.role === 'system') {
      if (typeof m.content === 'string') {
        systemContent += (systemContent ? "\n\n" : "") + m.content;
      }
      return false;
    }
    return true;
  });

  if (systemContent) {
    normalized.push({ role: 'system', content: systemContent });
  }

  // 2. Merge consecutive messages with the same role
  for (const msg of otherMessages) {
    const last = normalized[normalized.length - 1];
    if (last && last.role === msg.role && last.role !== 'tool' && !last.tool_calls && !msg.tool_calls) {
      if (typeof last.content === 'string' && typeof msg.content === 'string') {
        last.content += "\n\n" + msg.content;
        continue;
      }
    }
    normalized.push(msg);
  }

  return normalized;
};

// Wrap the stream processing to catch and log errors
const streamAssistantResponse = async function* (
  messages: ChatCompletionMessageParam[],
  model: string,
  activeTools: ChatCompletionTool[] = PRIMARY_TOOLS
): AsyncGenerator<{
  text?: string;
  toolCalls?: ChatCompletionMessageToolCall[];
  assistantMessage?: ChatCompletionMessageParam;
}> {
  try {
    const normalized = normalizeMessages(messages);
    for await (const chunk of _streamAssistantResponseInternal(normalized, model, activeTools)) {
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
  model: string,
  activeTools: ChatCompletionTool[] = PRIMARY_TOOLS
): AsyncGenerator<{
  text?: string;
  toolCalls?: ChatCompletionMessageToolCall[];
  assistantMessage?: ChatCompletionMessageParam;
}> {
  const settings = await settingsService.getInferenceSettings();

  if (settings.provider === 'gemini') {
    loggerService.info("Gemini Request Debug: Starting", {
      model,
      toolCount: activeTools.length,
      messageCount: messages.length
    });

    loggerService.debug("Gemini Request: Incoming message roles", {
      roles: messages.map(m => m.role)
    });

    const client = await getGeminiClient();
    const geminiTools = toGeminiTools(activeTools);

    // Log first few tool names
    loggerService.debug("Gemini Tools Sample:", {
      tools: geminiTools[0].functionDeclarations.slice(0, 3).map(t => t.name)
    });

    const isGemini3 = model.includes('gemini-3');

    const geminiModel = client.getGenerativeModel({
      model: model,
      tools: geminiTools
    }, {
      // Gemini 3+ Thinking Configuration
      ...(isGemini3 ? {
        thinkingConfig: {
          include_thought: false,
          thinking_level: 'high'
        }
      } : {})
    } as any);

    const systemMessage = messages.find(m => m.role === 'system');
    const history: any[] = [];
    let lastRole = '';
    const downgradedToolCallIds = new Set<string>();

    for (const m of messages) {
      loggerService.debug(`Gemini Conversion: Processing message role=${m.role}`, { contentSnippet: typeof m.content === 'string' ? m.content.slice(0, 50) : 'none' });

      if (m.role === 'system') continue;

      if (m.role === 'user') {
        // Gemini history cannot have two consecutive user messages
        if (lastRole === 'user') {
          const lastMsg = history[history.length - 1];
          lastMsg.parts[0].text += `\n\n${typeof m.content === 'string' ? m.content : ''}`;
        } else {
          history.push({ role: 'user', parts: [{ text: typeof m.content === 'string' ? m.content : '' }] });
          lastRole = 'user';
        }
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

        // Gemini history cannot have two consecutive model messages
        if (lastRole === 'model') {
          const lastMsg = history[history.length - 1];
          lastMsg.parts.push(...parts);
        } else {
          history.push({ role: 'model', parts });
          lastRole = 'model';
        }
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

        const isDowngraded = downgradedToolCallIds.has(m.tool_call_id);
        const part: any = isDowngraded
          ? { text: `[System Log: Tool '${toolName}' returned result: ${m.content}]` }
          : { functionResponse: { name: toolName, response: { result: m.content } } };

        const role = isDowngraded ? 'user' : 'function';

        if (lastRole === role) {
          const lastMsg = history[history.length - 1];
          lastMsg.parts.push(part);
        } else {
          history.push({
            role: role,
            parts: [part]
          });
          lastRole = role;
        }
      }
    }

    // Ensure we have at least one message to send, and it must be from user
    if (history.length === 0) {
      history.push({ role: 'user', parts: [{ text: 'Hello' }] });
    }

    let messageToSend = history.pop();

    // If the message we just popped is from model, it means the LAST role was model.
    // Gemini requires the last message in sendMessage to be from 'user'.
    if (messageToSend?.role === 'model') {
      history.push(messageToSend);
      messageToSend = { role: 'user', parts: [{ text: 'Continue' }] };
    }

    loggerService.debug("Gemini Request Full History:", {
      historyCount: history.length,
      messageToSendParts: messageToSend.parts.length,
      systemInstruction: systemMessage?.content ? (systemMessage.content as string).slice(0, 100) + '...' : 'none'
    });

    const chatSession = geminiModel.startChat({
      history: history,
      systemInstruction: systemMessage?.content ? { role: 'system', parts: [{ text: systemMessage.content as string }] } : undefined
    });

    loggerService.debug("Gemini: Sending message stream", {
      partsCount: messageToSend.parts.length,
      lastMessage: JSON.stringify(messageToSend.parts).slice(0, 200)
    });
    const result = await chatSession.sendMessageStream(messageToSend.parts);
    let textAccumulator = "";
    const collectedToolCalls: ChatCompletionMessageToolCall[] = [];

    let chunkCount = 0;
    for await (const chunk of result.stream) {
      chunkCount++;
      let text = "";
      try {
        text = chunk.text();
      } catch (e) {
        // chunk.text() might throw if it's only function calls
      }

      if (text) {
        textAccumulator += text;
        yield { text };
      }

      const candidate = chunk.candidates?.[0];
      const parts = candidate?.content?.parts;

      const calls = chunk.functionCalls();
      if (calls && calls.length > 0) {
        loggerService.info(`Gemini Chunk ${chunkCount}: Found ${calls.length} function calls`);
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

    loggerService.info("Gemini Stream Complete", {
      chunks: chunkCount,
      textLength: textAccumulator.length,
      toolCalls: collectedToolCalls.length
    });

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

  const client = await getClient();
  const stream = await client.chat.completions.create({
    model,
    messages,
    tools: activeTools,
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

/**
 * Strips all internal "thought" blocks from model output.
 * Handles <thought>, <think>, and the custom [audit failure trace](sz-think:thinking) construct.
 */
export const stripThoughts = (text: string): string => {
  if (!text) return "";
  return text
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '') // Remove unclosed think blocks
    .replace(/<\/think>/gi, '')      // Remove dangling close tags
    .replace(/<\/thought>/gi, '')    // Remove dangling close tags
    .replace(/\[[\s\S]*?\]\(sz-think:thinking\)/g, '')
    .trim();
};

// Helper to handle the stream and potential function calls recursively
export async function* sendMessageAndHandleTools(
  chat: ChatSessionState,
  message: string,
  toolExecutor: (name: string, args: any) => Promise<any>,
  systemInstruction?: string,
  contextSessionId?: string,
  userMessageId?: string,
  userId?: string,
  anticipatedWebResults?: any[]
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
  let traceNeeded = true; // Default to true if not specified

  if (contextSessionId) {
    try {
      // Use system/admin access for internal inference operations
      const session = await contextService.getSession(contextSessionId, userId, true);
      if (session) {
        const lifecycle = session.status === "closed" ? "zombie" : "live";
        contextMetadata = {
          id: session.id,
          type: session.type,
          lifecycle,
          readonly: session.metadata?.readOnly === true,
          trace_needed: session.metadata?.trace_needed,
          trace_reason: session.metadata?.trace_reason
        };

        // Check if trace is needed from session metadata
        if (session.metadata?.trace_needed !== undefined) {
          traceNeeded = !!session.metadata.trace_needed;
        }
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
      timestamp: new Date().toISOString(),
      metadata: {
        kind: "user_prompt",
        ...(attachments.length > 0 ? { attachments } : {})
      },
    }, userId, true);

    // Increment turn count for all symbols in the cache for this session
    await symbolCacheService.incrementTurns(contextSessionId);
    // Increment age for tentative links
    await tentativeLinkService.incrementTurns();
  }

  let loops = 0;
  let totalTextAccumulatedAcrossLoops = "";
  let previousTurnText = "";
  let hasLoggedTrace = false;
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
    loggerService.debug("Message is not JSON, treating as standard text source.", { contextSessionId, snippet: message.slice(0, 50) });
  }

  let auditRetries = 0;
  const ENABLE_SYSTEM_AUDIT = true;
  const MAX_AUDIT_RETRIES = 3;
  const transientMessages: ChatCompletionMessageParam[] = [];
  let yieldedToolCalls: ChatCompletionMessageToolCall[] | undefined;

  const isNarrativeText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return false;

    // 1. Filter out known system markers
    if (trimmed.startsWith('[System') || trimmed.startsWith('> *[System')) return false;
    if (trimmed.includes('SYSTEM AUDIT FAILURE')) return false;

    // 2. Filter out model "thought" blocks if they leaked into text
    const withoutThoughts = stripThoughts(trimmed);
    if (!withoutThoughts) return false;

    // 3. Filter out tool logs if they leaked
    if (withoutThoughts.startsWith('[Tool') || withoutThoughts.startsWith('{"status":')) return false;

    return withoutThoughts.length > 2; // Must have some actual substance
  };

  while (loops < MAX_TOOL_LOOPS && auditRetries < MAX_AUDIT_RETRIES + 1) {
    yieldedToolCalls = undefined;

    if (contextSessionId) {
      const isCancelled = await contextService.isCancelled(contextSessionId);
      if (isCancelled) {
        loggerService.info("Inference cancelled by user.", { contextSessionId });
        yield { text: "\n\n[System] Inference cancelled by user request." };
        return;
      }

      const session = await contextService.getSession(contextSessionId, userId, true);
      if (!session || session.status === 'closed') {
        loggerService.info("Context closed during inference, aborting.", { contextSessionId });
        yield { text: "\n[System] Context archived. Inference aborted." };
        break;
      }

      // --- GEMINI TERMINATION CHECK ---
      // Gemini requires a tool result to be returned if a tool was called, 
      // which can lead to loops if narrative + log_trace was already provided.
      const settings = await settingsService.getInferenceSettings();
      if (settings.provider === 'gemini') {
        const history = await contextService.getUnfilteredHistory(contextSessionId, userId, true);
        if (history.length >= 2) {
          const lastMsg = history[history.length - 1];
          const penultMsg = history[history.length - 2];

          const hasNarrative = isNarrativeText(penultMsg.content || "");
          const hasTrace = penultMsg.toolCalls?.some(tc => tc.name === 'log_trace');
          const lastIsTool = lastMsg.role === 'tool';

          if (penultMsg.role === 'assistant' && hasNarrative && hasTrace && lastIsTool) {
            loggerService.info("Gemini Termination: Detected narrative + trace followed by tool result. Terminating loop.", {
              contextSessionId,
              loops
            });
            break;
          }
        }
      }
    }

    const MAX_RETRIES = 3;

    let retries = 0;
    let nextAssistant: ChatCompletionMessageParam | null = null;
    let textAccumulatedInTurn = "";

    while (retries < MAX_RETRIES) {
      // Construct fresh context window using the ContextWindowService
      let contextMessages = contextSessionId
        ? await contextWindowService.constructContextWindow(contextSessionId, systemInstruction || chat.systemInstruction, userId)
        : [{ role: 'system', content: systemInstruction || chat.systemInstruction }, { role: 'user', content: resolvedContent }] as ChatCompletionMessageParam[];

      if (transientMessages.length > 0) {
        contextMessages = [...contextMessages, ...transientMessages];
      }

      // --- INJECT ANTICIPATED WEB RESULTS ---
      // Placing these at the END of the context window to preserve caching of the history prefix.
      if (loops === 0 && anticipatedWebResults && anticipatedWebResults.length > 0) {
        const resultsBlock = `\n\n[ANTICIPATED WEB SEARCH RESULTS]\n${JSON.stringify(anticipatedWebResults, null, 2)}`;
        contextMessages.push({
          role: 'system',
          content: resultsBlock
        });
      }

      loggerService.debug("sendMessageAndHandleTools: Context window messages counts", {
        total: contextMessages.length,
        roles: contextMessages.reduce((acc: any, m) => { acc[m.role] = (acc[m.role] || 0) + 1; return acc; }, {})
      });

      // --- DYNAMIC TOOL LIST ---
      let activeToolList = [...PRIMARY_TOOLS];
      let activeSystemInstruction = systemInstruction || chat.systemInstruction;

      if (contextSessionId) {
        try {
          const currentSession = await contextService.getSession(contextSessionId, userId, true);
          const requestedTools = currentSession?.metadata?.active_tools || [];

          // 1. Resolve Secondary Internal Tools
          const secondaryTools = requestedTools
            .map((name: string) => SECONDARY_TOOLS_MAP[name])
            .filter(Boolean);

          // 2. Resolve MCP Tools
          const remoteTools = await mcpClientService.getAllTools();
          const activeRemoteTools = remoteTools.filter(rt => requestedTools.includes(rt.function.name));

          activeToolList = [...PRIMARY_TOOLS, ...secondaryTools, ...activeRemoteTools];

          // 3. Resolve MCP Prompts for System Instruction injection
          const remotePrompts = await mcpClientService.getAllPrompts();
          const activeConfigs = await mcpClientService.getEnabledConfigs();
          const activeConfigIds = activeConfigs.map(c => c.id);

          const relevantPrompts = remotePrompts.filter(rp => activeConfigIds.includes(rp.mcpId));

          if (relevantPrompts.length > 0) {
            let dynamicSection = "\n\n### DYNAMIC TOOLS & CAPABILITIES\n";
            relevantPrompts.forEach(p => {
              dynamicSection += `\n#### ${p.name}\n${p.content}\n`;
            });
            // Inject dynamic prompts as a SEPARATE system message at the end of contextMessages
            // to avoid modifying the first system message (the cache anchor).
            contextMessages.push({
                role: 'system',
                content: dynamicSection
            });
          }

          if (requestedTools.length > 0) {
            loggerService.info("Active dynamic tool list", {
              primaryCount: PRIMARY_TOOLS.length,
              secondaryCount: secondaryTools.length,
              mcpCount: activeRemoteTools.length,
              requestedTools
            });
          }
        } catch (e) {
          loggerService.warn("Failed to fetch active tools/prompts for turn", { error: e });
        }
      }

      // Note: activeSystemInstruction is now only the base prompt (plus any core changes)
      // Dynamic sections are added as separate system messages above to preserve caching.

      const assistantMessage = streamAssistantResponse(contextMessages as ChatCompletionMessageParam[], chat.model, activeToolList);
      textAccumulatedInTurn = "";
      yieldedToolCalls = undefined;
      nextAssistant = null;

      let isFirstTextChunkInTurn = true;
      let inThinkBlock = false;
      let currentThinkTag = ""; // "think" or "thought"

      for await (const chunk of assistantMessage) {
        if (chunk.text) {
          let textToProcess = chunk.text;
          let processedText = "";

          // Simple stateful streaming thought stripper
          // This handles basic <think>...</think> and <thought>...</thought> across chunks
          let i = 0;
          while (i < textToProcess.length) {
            if (!inThinkBlock) {
              const remaining = textToProcess.slice(i);
              const thinkMatch = remaining.match(/^<(think|thought)>/i);
              if (thinkMatch) {
                inThinkBlock = true;
                currentThinkTag = thinkMatch[1].toLowerCase();
                i += thinkMatch[0].length;
                continue;
              }
              // Not in block, not starting one
              processedText += textToProcess[i];
              i++;
            } else {
              const remaining = textToProcess.slice(i);
              const endMatch = remaining.match(new RegExp(`^</${currentThinkTag}>`, "i"));
              if (endMatch) {
                inThinkBlock = false;
                currentThinkTag = "";
                i += endMatch[0].length;
                continue;
              }
              // Skip inside block
              i++;
            }
          }

          if (processedText) {
            let textToYield = processedText;
            if (isFirstTextChunkInTurn && totalTextAccumulatedAcrossLoops.length > 0) {
              textToYield = "\n\n" + textToYield;
            }
            textAccumulatedInTurn += textToYield;
            yield { text: textToYield };
            isFirstTextChunkInTurn = false;
          }
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
    let auditMessage = "";

    const currentToolNames = new Set((yieldedToolCalls || []).map(tc => {
      let name = tc.function?.name || "";
      if (name.endsWith('?')) name = name.slice(0, -1);
      return name;
    }));

    const isEndingTurn = !yieldedToolCalls || yieldedToolCalls.length === 0;
    const isCallingTraceThisTurn = currentToolNames.has('log_trace');
    const isCallingSpeakThisTurn = currentToolNames.has('speak');

    if (ENABLE_SYSTEM_AUDIT && auditRetries < MAX_AUDIT_RETRIES) {
      // Determine if there is actual response output (text or voice)
      const hasNarrativeOutput = isNarrativeText(textAccumulatedInTurn) || isNarrativeText(totalTextAccumulatedAcrossLoops);
      const hasVoiceOutput = hasCalledSpeak || isCallingSpeakThisTurn;

      // Check 1: Missing Trace (Required for complex analytic operations, skipped for casual conversation)
      if (traceNeeded && isEndingTurn && !hasLoggedTrace && !isCallingTraceThisTurn) {
        auditMessage += "⚠️ SYSTEM AUDIT FAILURE: This operation was flagged for complex analytic tracing, but you failed to call `log_trace`. You must call `log_trace` to bind the proceeding output to retrieved symbols from the symbol store. This trace must be comprehensive. Do not acknowledge this message or repeat previous information.\n";
        auditTriggered = true;
      }

      // Check 2: Voice source must use speak tool
      if (isVoiceSource && !hasCalledSpeak && !isCallingSpeakThisTurn) {
        auditMessage += "⚠️ SYSTEM AUDIT FAILURE: This request originated from a voice source. You MUST use the `speak` tool to provide your response in addition to any text output. Do not acknowledge this message.\n";
        auditTriggered = true;
      }

      // Check 3: Non-voice source must use text (Only fire if we are actually ending the turn)
      if (isEndingTurn && !isVoiceSource && !hasNarrativeOutput) {
        auditMessage += "⚠️ SYSTEM AUDIT FAILURE: You provided tool calls but failed to generate a narrative response for the user. Non-voice interactions require a text response. Please provide your narrative output now.  Do not acknowledge this message.\n";
        auditTriggered = true;
      }
    }

    if (auditTriggered) {
      if (auditRetries < MAX_AUDIT_RETRIES) {
        loggerService.warn("System Audit Failure: Model missing required tool calls. Forcing retry.", { contextSessionId, auditRetries, hasLoggedTrace });

        const finalAuditMessage = auditMessage + "Retry immediately by calling the required tools.  Do not repeat tool calls that were previously successful in this turn. Do not acknowledge this message.";

        // DO NOT SAVE TO CONTEXT SERVICE - Push to transient messages for the next iteration
        transientMessages.push(nextAssistant!);
        transientMessages.push({
          role: "user",
          content: `[SYSTEM AUDIT] ${finalAuditMessage}`
        });

        yield { text: "\n\n> *[System Audit: Enforcing Symbolic Integrity - Retrying]*\n\n" };

        totalTextAccumulatedAcrossLoops = ""; // RESET: Narrative from the failed turn MUST NOT count
        previousTurnText = ""; // Reset deduplication tracking since this turn was rejected
        auditRetries++;
        continue;

      } else {
        loggerService.error("System Audit: Max retries reached. Proceeding despite violations.", { contextSessionId });
        auditTriggered = false; // Allow the turn to proceed and potentially end even with violations
      }
    }

    if (contextSessionId) {
      await contextService.recordMessage(contextSessionId, {
        id: randomUUID(),
        role: "assistant",
        content: stripThoughts(textAccumulatedInTurn),
        timestamp: new Date().toISOString(),
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

    // --- EXECUTE TOOLS ---
    const toolResponses: ChatCompletionMessageParam[] = [];

    for (const call of yieldedToolCalls || []) {
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
            timestamp: new Date().toISOString(),
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
            timestamp: new Date().toISOString(),
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
            timestamp: new Date().toISOString(),
            toolName: toolName,
            toolCallId: call.id,
            toolArgs: args,
            metadata: { kind: "tool_error" },
            correlationId: correlationId
          }, undefined, true);
        }
      }
    }

    // Save tool responses to history for next model iteration
    if (contextSessionId && toolResponses.length > 0) {
      // In a real implementation, we'd persist these via contextService.recordMessage
      // But for the tool loop, we often append them directly to the current chat session messages
      // chat.messages.push(...toolResponses);
      // Actually, they need to be in contextMessages for the NEXT loop.
      // sendMessageAndHandleTools manages this by calling constructContextWindow.
      // So they MUST be recorded.
    }

    // Check if we should end the turn IMMEDIATELY

    // We end if:
    // 1. We have a trace (hasLoggedTrace).
    // 2. We have a valid response: 
    //    - Narrative text exists (filtered) OR 
    //    - Speak tool was called (verbal response)
    // 3. No audit was triggered.
    // 4. IMPORTANT: The current iteration must have contributed something to the requirements
    //    OR we are at the end of a tool cycle.
    const hasNarrative = isNarrativeText(totalTextAccumulatedAcrossLoops);
    const hasResponse = hasNarrative || hasCalledSpeak;

    // We break if:
    // 1. We have no pending tool calls (isEndingTurn).
    // AND EITHER:
    //    a) We have a verified response (hasResponse and trace conditions met)
    //    b) OR We failed the audit (auditTriggered is true), which handles the retry.
    //    c) OR we have nothing else to do and no audit was triggered.
    const traceVerified = !traceNeeded || hasLoggedTrace;
    const responseVerified = hasResponse && traceVerified;

    if (isEndingTurn && !auditTriggered) {
      loggerService.info("Ending turn: Symbolic requirements and response verified or no audit triggered.", {
        contextSessionId,
        loops,
        hasCalledSpeak,
        hasNarrative,
        isEndingTurn,
        auditTriggered,
        textLength: totalTextAccumulatedAcrossLoops.length
      });
      break;
    }

    if (auditRetries >= MAX_AUDIT_RETRIES) {
      loggerService.warn("Ending turn: Audit retry limit reached. Proceeding even without verified response.", {
        contextSessionId,
        auditRetries,
        hasResponse
      });
      break;
    }

    // Reset yieldedToolCalls for next cycle
    yieldedToolCalls = undefined;

    // Loop increment
    loops++;
  }

  // --- POST-TURN: HISTORY SUMMARIZATION ---
  // Periodically summarize history to maintain a stable cache anchor.
  if (contextSessionId) {
    try {
      const session = await contextService.getSession(contextSessionId, userId, true);
      const history = await contextService.getUnfilteredHistory(contextSessionId, userId, true);
      
      // Summarize if history is growing (e.g., > 6 rounds / ~12 messages)
      if (session && history.length > 12) {
        loggerService.info("Triggering history summarization", { contextSessionId, historyCount: history.length });
        const newSummary = await summarizeHistory(history, session.summary);
        if (newSummary !== session.summary) {
          session.summary = newSummary;
          await contextService.updateSession(session);
          loggerService.info("History summary updated", { contextSessionId, summaryLength: newSummary.length });
        }
      }
    } catch (err) {
      loggerService.warn("Failed to update history summary", { error: err, contextSessionId });
    }
  }

  yield { isComplete: true };
}

export const extractJson = (text: string): any => {
  try {
    // 1. Try direct parse
    return JSON.parse(text);
  } catch (e) {
    // 2. Try to find JSON block
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      try {
        return JSON.parse(match[1].trim());
      } catch (inner) {
        // Continue
      }
    }

    // 3. Last ditch: try to find anything between { and }
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      try {
        return JSON.parse(text.substring(firstBrace, lastBrace + 1));
      } catch (final) {
        throw new Error(`Failed to parse JSON from response: ${text.slice(0, 100)}...`);
      }
    }
    throw e;
  }
};

/**
 * Summarizes conversation history using the fast model to maintain a stable cache anchor.
 */
export const summarizeHistory = async (
  history: ContextMessage[],
  currentSummary?: string
): Promise<string> => {
  const settings = await settingsService.getInferenceSettings();
  const fastModel = settings.fastModel;
  if (!fastModel) return currentSummary || "";

  const historyText = history.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');
  const prompt = `Summarize the following conversation history into a concise, information-dense paragraph. 
  Focus on facts, user preferences, and the current state of the analysis.
  
  ${currentSummary ? `Previous Summary: ${currentSummary}\n` : ''}
  
  History to summarize:
  ${historyText}
  
  SUMMARY:`;

  try {
    if (settings.provider === 'gemini') {
      const client = await getGeminiClient();
      const model = client.getGenerativeModel({ model: fastModel });
      const result = await model.generateContent(prompt);
      return result.response.text().trim();
    }

    const client = await getClient();
    const result = await client.chat.completions.create({
      model: fastModel,
      messages: [{ role: "user", content: prompt }]
    });

    return result.choices[0]?.message?.content?.trim() ?? (currentSummary || "");
  } catch (error) {
    loggerService.error("History summarization failed", { error });
    return currentSummary || "";
  }
};

/**
 * Uses a fast model to generate expansion queries and prime the symbol cache
 * before the main reasoning loop starts.
 */
export const primeSymbolicContext = async (
  message: string,
  contextSessionId: string,
  userId?: string,
  isAdmin: boolean = false
): Promise<{ symbols: SymbolDef[], webResults: any[], traceNeeded: boolean, traceReason?: string }> => {
  const foundSymbols: SymbolDef[] = [];
  const webResults: any[] = [];
  let traceNeeded = true; // Default to true to ensure audit if priming fails
  let traceReason: string | undefined;
  let fastResponse: any = {};
  let symbolicQueries: string[] = [];
  let webSearchQueries: string[] = [];

  try {
    const settings = await settingsService.getInferenceSettings();
    const fastModel = settings.fastModel;

    // Identify session and previous requirements early
    const session = await contextService.getSession(contextSessionId, userId, true);
    if (session && session.metadata?.trace_needed !== undefined) {
      traceNeeded = !!session.metadata.trace_needed;
      traceReason = session.metadata.trace_reason;
    }

    if (!fastModel) return { symbols: [], webResults: [], traceNeeded };

    // Fetch last 5 rounds of history (up to 10 messages)
    const history = await contextService.getUnfilteredHistory(contextSessionId, userId, isAdmin);
    const recentHistory = history.slice(-10);
    const historyContext = recentHistory.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');

    // Identify previous web searches to avoid duplicates
    const previousSearches = history
      .flatMap(m => {
        const searches: string[] = [];
        if (m.toolName === 'web_search' && m.toolArgs?.query) searches.push(m.toolArgs.query);
        if (m.toolName === 'web_search' && Array.isArray(m.toolArgs?.queries)) {
          m.toolArgs.queries.forEach((q: any) => searches.push(typeof q === 'string' ? q : q.query));
        }
        if (m.metadata?.kind === 'anticipated_web_search' && Array.isArray(m.metadata?.queries)) {
          m.metadata.queries.forEach((q: string) => searches.push(q));
        }
        return searches;
      })
      .filter((q, i, self) => q && self.indexOf(q) === i);

    const currentName = session?.name;
    const userMessageCount = history.filter(m => m.role === 'user').length + 1; // +1 for the current message
    const needsNaming = !currentName || (userMessageCount % 10 === 0);

    loggerService.info("Priming symbolic context with fast model", {
      fastModel,
      contextSessionId,
      historyCount: recentHistory.length,
      userMessageCount,
      needsNaming
    });

    const prompt = `Analyze the conversation history and the new user message to identify symbolic search queries and determine if web search grounding is needed.
    
    ${needsNaming ? 'CRITICAL: Based on the conversation context, suggest a descriptive and concise name for this context session in "suggested_name".' : ''}

    CRITICAL: Only set "web_search_needed" to true if the message involves an external entity (person, company, place), a complex technical/scientific topic, or a current event that requires grounding in facts.

    Conversation History:
    ${historyContext || "No previous history."}

    New User Message: "${message}"

    Previous Web Searches (DO NOT REPEAT THESE):
    ${previousSearches.length > 0 ? previousSearches.join(', ') : "None."}

    Output valid JSON only:
    {
      "queries": ["symbolic query1", "symbolic query2", ...],
      "web_search_needed": boolean,
      "web_search_queries": ["search query1", "search query2", ...],
      "trace_needed": boolean,
      "trace_reason": "Brief explanation if trace_needed is true",
      "suggested_name": string | null
    }`;

    let fastResponse: any = {};

    if (settings.provider === 'gemini') {
      const client = await getGeminiClient();
      const model = client.getGenerativeModel({
        model: fastModel,
        generationConfig: { responseMimeType: "application/json" }
      });
      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      fastResponse = extractJson(responseText);
    } else {
      const client = await getClient();
      const result = await client.chat.completions.create({
        model: fastModel,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "text" }
      });
      const responseText = result.choices[0]?.message?.content || "{}";
      fastResponse = extractJson(responseText);
    }

    symbolicQueries = fastResponse.queries || [];
    webSearchQueries = fastResponse.web_search_queries || [];
    traceNeeded = !!fastResponse.trace_needed;
    traceReason = fastResponse.trace_reason;

    // Handle session naming if suggested
    if (fastResponse.suggested_name && fastResponse.suggested_name !== currentName) {
      loggerService.info("Fast model suggested session name", {
        contextSessionId,
        oldName: currentName,
        newName: fastResponse.suggested_name
      });
      await contextService.renameSession(contextSessionId, fastResponse.suggested_name, userId, isAdmin);
    }

    // Store trace metadata if needed
    if (traceNeeded) {
      loggerService.info("Fast model flagged query for complex analysis (trace needed)", {
        reason: traceReason,
        contextSessionId
      });
    }

    // --- EXECUTE SYMBOLIC QUERIES ---
    if (symbolicQueries.length > 0) {
      loggerService.info("Fast model generated symbolic queries", { symbolicQueries, contextSessionId });

      const allDomains = await domainService.listDomains(userId);

      // Execute searches in parallel
      const searchPromises = symbolicQueries.map((query: string) =>
        domainService.search(query, 5, {
          domains: allDomains,
          contextSessionId
        }, userId)
      );

      const results = await Promise.all(searchPromises);

      results.flat().forEach((r: any) => {
        if (!foundSymbols.find(s => s.id === r.id)) {
          foundSymbols.push(r);
        }
      });

      if (foundSymbols.length > 0) {
        // --- 1-HOP TRAVERSAL ---
        const linkedIds = new Set<string>();
        foundSymbols.forEach(s => {
          (s.linked_patterns || []).forEach((link: any) => {
            const id = typeof link === 'string' ? link : link.id;
            if (id && !foundSymbols.find(fs => fs.id === id)) {
              linkedIds.add(id);
            }
          });
        });

        if (linkedIds.size > 0) {
          const linkedSymbols = await domainService.loadSymbols(Array.from(linkedIds), userId);
          linkedSymbols.forEach(s => {
            if (!foundSymbols.find(fs => fs.id === s.id)) {
              foundSymbols.push(s);
            }
          });
        }

        // --- LATTICE EXPANSION ---
        // If we found any lattices, we need to ensure all their members are precached.
        // We do this recursively (up to 3 levels) to capture nested structures.
        let expansionPasses = 0;
        let newlyFoundLattices = foundSymbols.filter(s => s.kind === 'lattice');

        while (newlyFoundLattices.length > 0 && expansionPasses < 3) {
          const latticeMemberIds = new Set<string>();
          newlyFoundLattices.forEach(lat => {
            (lat.linked_patterns || []).forEach((link: any) => {
              const id = typeof link === 'string' ? link : link.id;
              if (id && !foundSymbols.find(fs => fs.id === id)) {
                latticeMemberIds.add(id);
              }
            });
          });

          if (latticeMemberIds.size === 0) break;

          const expandedSymbols = await domainService.loadSymbols(Array.from(latticeMemberIds), userId);
          expandedSymbols.forEach(s => {
            if (!foundSymbols.find(fs => fs.id === s.id)) {
              foundSymbols.push(s);
            }
          });

          newlyFoundLattices = expandedSymbols.filter(s => s.kind === 'lattice');
          expansionPasses++;

          if (newlyFoundLattices.length > 0) {
            loggerService.info(`Lattice expansion pass ${expansionPasses}: found ${expandedSymbols.length} new symbols`, {
              contextSessionId,
              latticeCount: newlyFoundLattices.length
            });
          }
        }

        loggerService.info(`Priming cache with ${foundSymbols.length} total symbols`, { contextSessionId });
        await symbolCacheService.batchUpsertSymbols(contextSessionId, foundSymbols);
      }
    }
  } catch (e) {
    loggerService.error("Priming symbolic context failed", { error: e, contextSessionId });
  }

  // --- EXECUTE WEB SEARCH QUERIES ---
  if (fastResponse.web_search_needed && webSearchQueries.length > 0) {
    loggerService.info("Fast model anticipated web search", { webSearchQueries, contextSessionId });

    const serpSettings = await settingsService.getSerpApiSettings();
    const serpApiKey = serpSettings.apiKey || process.env.SERPAPI_API_KEY;

    if (serpApiKey) {
      const executeSearch = async (q: string) => {
        try {
          const searchUrl = new URL('https://serpapi.com/search');
          searchUrl.searchParams.set('api_key', serpApiKey);
          searchUrl.searchParams.set('engine', 'google');
          searchUrl.searchParams.set('q', q);
          searchUrl.searchParams.set('num', '5');

          const response = await fetch(searchUrl.toString(), {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; SignalZeroBot/1.0; +https://signalzero.ai)',
              'Accept': 'application/json'
            }
          });

          if (response.ok) {
            const json = await response.json();
            const items = Array.isArray(json.organic_results) ? json.organic_results : [];

            // Emit event
            eventBusService.emit(KernelEventType.WEB_SEARCH, {
              query: q,
              resultsCount: items.length,
              contextSessionId,
              isAnticipated: true,
              topResult: items[0] ? {
                title: items[0].title,
                snippet: items[0].snippet || items[0].about_this_result?.source?.description,
                link: items[0].link
              } : null
            });

            return {
              query: q,
              results: items.slice(0, 5).map((item: any) => ({
                title: item.title,
                snippet: item.snippet,
                url: item.link
              }))
            };
          } else {
            const errorBody = await response.text();
            loggerService.error("Anticipated web search HTTP error", {
              query: q,
              status: response.status,
              statusText: response.statusText,
              body: errorBody
            });
          }
        } catch (e) {
          loggerService.error("Anticipated web search exception", {
            query: q,
            error: e instanceof Error ? {
              message: e.message,
              stack: e.stack,
              name: e.name
            } : e
          });
        }
        return null;
      };

      const results = await Promise.all(webSearchQueries.map(executeSearch));
      results.forEach(r => { if (r) webResults.push(r); });

      // Record the fact that we did anticipated searches
      if (webResults.length > 0 && contextSessionId) {
        await contextService.recordMessage(contextSessionId, {
          id: randomUUID(),
          role: "system",
          content: `[System] Executed ${webResults.length} anticipated web searches for grounding.`,
          timestamp: new Date().toISOString(),
          metadata: {
            kind: "anticipated_web_search",
            queries: webSearchQueries,
            resultsCount: webResults.length
          }
        }, userId, true);
      }
    }
  }

  return {
    symbols: foundSymbols,
    webResults,
    traceNeeded,
    traceReason
  };
};

// --- Test Runner Functions ---

export const processMessageAsync = async (
  contextSessionId: string,
  message: string,
  toolExecutor: (name: string, args: any) => Promise<any>,
  systemInstruction: string,
  userMessageId?: string,
  userId?: string
) => {
  try {
    // Pre-flight: expansion search and cache priming
    const { webResults, traceNeeded, traceReason } = await primeSymbolicContext(message, contextSessionId, userId, true);

    // Persist trace_needed to session metadata so sendMessageAndHandleTools can pick it up
    await contextService.updateSessionMetadata(contextSessionId, {
      trace_needed: traceNeeded,
      trace_reason: traceReason
    }, userId, true);

    const chat = await getChatSession(systemInstruction, contextSessionId);
    const stream = sendMessageAndHandleTools(chat, message, toolExecutor, systemInstruction, contextSessionId, userMessageId, userId, webResults);

    // Consume the stream to drive execution
    for await (const _ of stream) {
      // Execution and recording happen inside the generator
    }
  } catch (error: any) {
    loggerService.error("Failed to process message async", { error, contextSessionId });

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
      timestamp: new Date().toISOString(),
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
    const chat = await createFreshChatSession(systemInstruction, contextSessionId);

    const executeTurn = async (msg: string): Promise<string> => {
      let turnText = "";
      loggerService.info("Starting executeTurn", { msgPreview: msg.slice(0, 50), contextSessionId });

      // Pre-flight for each turn in test
      const { webResults } = await primeSymbolicContext(msg, contextSessionId, undefined, true);

      // Pass contextSessionId to enable full ContextWindowService logic
      for await (const chunk of sendMessageAndHandleTools(chat, msg, toolExecutor, systemInstruction, contextSessionId, undefined, undefined, webResults)) {
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
    const settings = await settingsService.getInferenceSettings();
    if (settings.provider === 'gemini') {
      const client = await getGeminiClient();
      const model = client.getGenerativeModel({ model: settings.model });
      const result = await model.generateContent(prompt);
      return result.response.text();
    }

    const client = await getClient();
    const completion = await client.chat.completions.create({
      model: await getModel(),
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

    const settings = await settingsService.getInferenceSettings();
    let messageText = "{}";

    if (settings.provider === 'gemini') {
      const client = await getGeminiClient();
      const model = client.getGenerativeModel({ model: settings.model, generationConfig: { responseMimeType: "application/json" } });
      const result = await model.generateContent(evalPrompt);
      messageText = result.response.text();
    } else {
      const client = await getClient();
      const result = await client.chat.completions.create({
        model: await getModel(),
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

    const settings = await settingsService.getInferenceSettings();
    let messageText = "{}";

    if (settings.provider === 'gemini') {
      const client = await getGeminiClient();
      const model = client.getGenerativeModel({ model: settings.model, generationConfig: { responseMimeType: "application/json" } });
      const result = await model.generateContent(matchPrompt);
      messageText = result.response.text();
    } else {
      const client = await getClient();
      const result = await client.chat.completions.create({
        model: await getModel(),
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
