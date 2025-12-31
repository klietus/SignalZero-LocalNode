import OpenAI from "openai";
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
import { loggerService } from "./loggerService.ts";
import { contextService } from "./contextService.js";

interface ChatSessionState {
  messages: ChatCompletionMessageParam[];
  systemInstruction: string;
  model: string;
}

const MAX_TOOL_LOOPS = 20;

const getClient = () => {
  const { endpoint } = settingsService.getInferenceSettings();
  const apiKey = settingsService.getApiKey() || "lm-studio";
  return new OpenAI({
    baseURL: endpoint,
    apiKey,
  });
};

const getModel = () => settingsService.getInferenceSettings().model;

const buildMetadataWrappedContent = (message: string, context?: Record<string, any>) =>
  `${message}\n\n[SYSTEM_METADATA] ${JSON.stringify(buildSystemMetadataBlock(context))}`;

const extractTextDelta = (delta: ChatCompletionChunk["choices"][number]["delta"]) => {
  if (!delta?.content) return "";
  if (typeof delta.content === "string") return delta.content;
  if (Array.isArray(delta.content)) {
    return delta.content
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
  toolCalls?: ChatCompletionMessageToolCall[]
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
    });
  }
  return collected;
};

const parseToolArguments = (args: string) => {
  if (!args) return {};
  try {
    return JSON.parse(args);
  } catch (error) {
    loggerService.warn("Failed to parse tool arguments, passing raw string", { args, error });
    return {};
  }
};

let chatSession: ChatSessionState | null = null;

const createChatSession = (systemInstruction: string): ChatSessionState => ({
  messages: [{ role: "system", content: systemInstruction }],
  systemInstruction,
  model: getModel(),
});

export const getChatSession = (systemInstruction: string) => {
  if (!chatSession || chatSession.systemInstruction !== systemInstruction) {
    chatSession = createChatSession(systemInstruction);
  }
  const currentModel = getModel();
  if (chatSession.model !== currentModel) {
    chatSession.model = currentModel;
  }
  return chatSession;
};

export const resetChatSession = () => {
  chatSession = null;
};

export const createFreshChatSession = (systemInstruction: string) => {
  return createChatSession(systemInstruction);
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

  const client = getClient();
  const result = await client.chat.completions.create({
    model: getModel(),
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
  });

  return result.choices[0]?.message?.content ?? "";
};

const streamAssistantResponse = async function* (
  messages: ChatCompletionMessageParam[],
  model: string
): AsyncGenerator<{
  text?: string;
  toolCalls?: ChatCompletionMessageToolCall[];
  assistantMessage?: ChatCompletionMessageParam;
}> {
  const client = getClient();
  const stream = await client.chat.completions.create({
    model,
    messages,
    tools: toolDeclarations,
    stream: true,
    temperature: 0.3,
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

// Helper to handle the stream and potential function calls recursively
export async function* sendMessageAndHandleTools(
  chat: ChatSessionState,
  message: string,
  toolExecutor: (name: string, args: any) => Promise<any>,
  systemInstruction?: string,
  contextSessionId?: string
): AsyncGenerator<
  { text?: string; toolCalls?: any[]; isComplete?: boolean },
  void,
  unknown
> {
  if (systemInstruction && chat.systemInstruction !== systemInstruction) {
    chat.messages = [{ role: "system", content: systemInstruction }];
    chat.systemInstruction = systemInstruction;
  }

  const currentModel = getModel();
  if (chat.model !== currentModel) {
    chat.model = currentModel;
  }

  let contextMetadata: Record<string, any> | undefined;

  if (contextSessionId) {
    try {
      const session = await contextService.getSession(contextSessionId);
      if (session) {
        const lifecycle = session.status === "closed" ? "zombie" : "live";
        contextMetadata = {
          id: session.id,
          type: session.type,
          status: session.status,
          lifecycle,
          readonly: session.metadata?.readOnly === true,
          created_at: session.createdAt,
          updated_at: session.updatedAt,
          closed_at: session.closedAt,
          metadata: session.metadata,
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

  const userMessage: ChatCompletionMessageParam = {
    role: "user",
    content: buildMetadataWrappedContent(message, contextMetadata),
  };
  chat.messages.push(userMessage);

  if (contextSessionId) {
    await contextService.recordMessage(contextSessionId, {
      role: "user",
      content: message,
      metadata: { kind: "user_prompt" },
    });
  }

  let loops = 0;
  while (loops < MAX_TOOL_LOOPS) {
    const assistantMessage = streamAssistantResponse(chat.messages, chat.model);
    let yieldedToolCalls: ChatCompletionMessageToolCall[] | undefined;

    let nextAssistant: ChatCompletionMessageParam | null = null;
    for await (const chunk of assistantMessage) {
      if (chunk.text) yield { text: chunk.text };
      if (chunk.toolCalls) yieldedToolCalls = chunk.toolCalls;
      if (chunk.assistantMessage) nextAssistant = chunk.assistantMessage;
    }

    if (!nextAssistant) {
      yield { text: "Error: No assistant message returned." };
      break;
    }

    chat.messages.push(nextAssistant);

    if (contextSessionId) {
      await contextService.recordMessage(contextSessionId, {
        role: "assistant",
        content: typeof nextAssistant.content === "string" ? nextAssistant.content : JSON.stringify(nextAssistant.content),
        toolCalls: nextAssistant.tool_calls?.map((call) => ({
          id: call.id,
          name: call.function?.name,
          arguments: call.function?.arguments,
        })),
        metadata: { kind: "assistant_response" },
      });
    }

    if (!yieldedToolCalls || yieldedToolCalls.length === 0) {
      break;
    }

    const toolResponses: ChatCompletionMessageParam[] = [];
    for (const call of yieldedToolCalls) {
      if (!call.function?.name) continue;
      try {
        const args = parseToolArguments(call.function.arguments || "");
        const result = await toolExecutor(call.function.name, args);
        toolResponses.push({
          role: "tool",
          content: JSON.stringify(result),
          tool_call_id: call.id,
        });

        if (contextSessionId) {
          await contextService.recordMessage(contextSessionId, {
            role: "tool",
            content: JSON.stringify(result),
            toolName: call.function.name,
            toolCallId: call.id,
            toolArgs: args,
            metadata: { kind: "tool_result" },
          });
        }
      } catch (err) {
        loggerService.error(`Error executing tool ${call.function.name}`, { err });
        toolResponses.push({
          role: "tool",
          content: JSON.stringify({ error: String(err) }),
          tool_call_id: call.id,
        });

        if (contextSessionId) {
          await contextService.recordMessage(contextSessionId, {
            role: "tool",
            content: JSON.stringify({ error: String(err) }),
            toolName: call.function.name,
            toolCallId: call.id,
            toolArgs: parseToolArguments(call.function.arguments || ""),
            metadata: { kind: "tool_error" },
          });
        }
      }
    }

    chat.messages.push(...toolResponses);
    loops++;
  }

  yield { isComplete: true };
}

// --- Test Runner Functions ---

export const runSignalZeroTest = async (
  prompt: string,
  toolExecutor: (name: string, args: any) => Promise<any>,
  primingPrompts: string[] = ["Load domains"],
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

  try {
    const chat = createFreshChatSession(systemInstruction);

    const executeTurn = async (msg: string): Promise<string> => {
      let turnText = "";
      for await (const chunk of sendMessageAndHandleTools(chat, msg, toolExecutor, systemInstruction)) {
        if (chunk.text) turnText += chunk.text;
      }
      return turnText;
    };

    for (const primeMsg of primingPrompts) {
      await executeTurn(primeMsg);
    }

    const finalResponse = await executeTurn(prompt);
    const endTime = Date.now();

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
    const client = getClient();
    const completion = await client.chat.completions.create({
      model: getModel(),
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
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

    const client = getClient();
    const result = await client.chat.completions.create({
      model: getModel(),
      messages: [{ role: "user", content: evalPrompt }],
      temperature: 0,
      response_format: { type: "json_object" },
    });

    const messageText = result.choices[0]?.message?.content || "{}";
    const json = JSON.parse(messageText);

    const defaultScore = {
      alignment_score: 0,
      drift_detected: false,
      symbolic_depth: 0,
      reasoning_depth: 0,
      auditability_score: 0,
    };

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
