
import React from 'react';
import { User, Terminal, Globe } from 'lucide-react';
// @ts-ignore
import ReactMarkdown from 'react-markdown';
// @ts-ignore
import remarkGfm from 'remark-gfm';
import { Message, Sender } from '../types';
import { ToolIndicator } from './ToolIndicator';

interface ChatMessageProps {
  message: Message;
  onSymbolClick?: (id: string, data?: any) => void;
  onDomainClick?: (domain: string) => void;
  onTraceClick?: (id: string) => void;
}

// --- Helper for Unicode Decoding ---
const decodeUnicode = (str: string) => {
  if (!str) return str;
  return str.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
};

// --- Shared UI Components ---

interface SymbolTagProps {
  id: string;
  name?: string;
  onClick?: (id: string) => void;
}

const SymbolTag: React.FC<SymbolTagProps> = ({ id, name, onClick }) => {
  const displayId = typeof id === 'object' ? JSON.stringify(id) : String(id);
  return (
    <button 
        onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (onClick) onClick(displayId);
        }}
        className="inline-flex items-center gap-1.5 px-1.5 py-0.5 mx-0.5 rounded-md text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800/50 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors font-mono text-[10px] md:text-xs cursor-pointer select-none align-middle shadow-sm"
        title={name ? `Symbol: ${name} (${displayId})` : `Symbol: ${displayId}`}
    >
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse flex-shrink-0"></span>
        <span className="font-semibold">{displayId}</span>
        {name && (
            <span className="opacity-75 hidden sm:inline-block border-l border-emerald-500/30 pl-1.5 ml-0.5 max-w-[200px] truncate">
                {name}
            </span>
        )}
    </button>
  );
};

interface DomainTagProps {
  id: string;
  name?: string;
  onClick?: (id: string) => void;
}

const DomainTag: React.FC<DomainTagProps> = ({ id, name, onClick }) => {
  const displayName = name && name !== id ? `${name} (${id})` : id;
  return (
    <button 
        onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (onClick) onClick(id);
        }}
        className="inline-flex items-center gap-1.5 px-1.5 py-0.5 mx-0.5 rounded-md text-indigo-700 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800/50 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 transition-colors font-mono text-[10px] md:text-xs cursor-pointer select-none align-middle shadow-sm"
        title={`Domain: ${displayName}`}
    >
        <Globe size={10} className="text-indigo-500 flex-shrink-0" />
        <span className="font-semibold">{displayName}</span>
    </button>
  );
};

export const ChatMessage: React.FC<ChatMessageProps> = ({ message, onSymbolClick, onDomainClick }) => {
  const isUser = message.role === Sender.USER;

  // Formatter to handle code blocks, <sz_symbol> blocks, <sz_domain> blocks, and Markdown text
  const formatText = (text: string) => {
    // Split by Code Blocks OR Symbol Blocks OR Domain Blocks to isolate them from normal Markdown processing
    const parts = text.split(/(`{3}[\s\S]*?`{3}|<sz_symbol>[\s\S]*?<\/sz_symbol>|<sz_domain>[\s\S]*?<\/sz_domain>)/g);
    
    return parts.map((part, i) => {
      // 1. Handle Code Blocks
      if (part.startsWith('```') && part.endsWith('```')) {
        const content = part.slice(3, -3).replace(/^[a-z]+\n/, ''); // remove lang tag
        return (
          <div key={i} className="my-3 p-3 bg-gray-950 border border-gray-800 text-gray-300 rounded text-xs md:text-sm font-mono overflow-x-auto shadow-inner">
            {content}
          </div>
        );
      }

      // 2. Handle <sz_symbol> Blocks (Full JSON Definition)
      if (part.startsWith('<sz_symbol>') && part.endsWith('</sz_symbol>')) {
         const inner = part.replace(/<\/?sz_symbol>/g, '');
         const cleanInner = inner.replace(/```json\n?|```/g, '').trim();
         
         let id = "SYNTHETIC_SYMBOL";
         let name = "";
         let json: any = null;

         try {
             json = JSON.parse(cleanInner);
             if (json.id) id = json.id;
             if (json.name) name = decodeUnicode(json.name);
         } catch (e) {
             const matchId = cleanInner.match(/"id"\s*:\s*"([^"]+)"/);
             if (matchId) id = matchId[1];
             const matchName = cleanInner.match(/"name"\s*:\s*"([^"]+)"/);
             if (matchName) name = decodeUnicode(matchName[1]);
         }

         return (
             <div key={i} className="inline-block align-middle my-1">
                 <SymbolTag 
                    id={id} 
                    name={name} 
                    onClick={(clickId) => onSymbolClick && onSymbolClick(clickId, json)} 
                 />
             </div>
         );
      }

      // 3. Handle <sz_domain> Blocks (Full JSON Definition)
      if (part.startsWith('<sz_domain>') && part.endsWith('</sz_domain>')) {
         const inner = part.replace(/<\/?sz_domain>/g, '');
         const cleanInner = inner.replace(/```json\n?|```/g, '').trim();
         
         let id = "UNKNOWN_DOMAIN";
         let name = "";

         try {
             const json = JSON.parse(cleanInner);
             if (json.domain_id) id = json.domain_id;
             if (json.name) name = decodeUnicode(json.name);
         } catch (e) {
             const matchId = cleanInner.match(/"domain_id"\s*:\s*"([^"]+)"/);
             if (matchId) id = matchId[1];
             const matchName = cleanInner.match(/"name"\s*:\s*"([^"]+)"/);
             if (matchName) name = decodeUnicode(matchName[1]);
         }

         return (
             <div key={i} className="inline-block align-middle my-1">
                 <DomainTag id={id} name={name} onClick={onDomainClick} />
             </div>
         );
      }

      // 4. Handle Markdown Text (with embedded <sz_id> tags)
      // Pre-process: Replace <sz_id>ID</sz_id> with markdown links [ID](sz:ID)
      // We use a regex that captures the content non-greedily
      let markdownContent = part.replace(/<sz_id>(.*?)<\/sz_id>/g, '[$1](sz:$1)');
      
      // Decode unicode escapes in the text content
      markdownContent = decodeUnicode(markdownContent);

      return (
        <div key={i} className="prose prose-sm dark:prose-invert max-w-none prose-p:leading-relaxed prose-pre:bg-gray-950 prose-pre:border prose-pre:border-gray-800">
           <ReactMarkdown
             remarkPlugins={[remarkGfm]}
             // CRITICAL: Allow sz: protocol which might otherwise be sanitized by default
             urlTransform={(url: string) => url} 
             components={{
                a: ({href, children, ...props}: any) => {
                    // Check if this is a SignalZero symbol link
                    if (href && href.startsWith('sz:')) {
                        const id = href.replace(/^sz:/, '');
                        // If children is the same as ID, don't pass name to avoid duplication unless we want to fetch it? 
                        // Usually sz_id just contains the ID.
                        return (
                            <SymbolTag id={id} onClick={(clickId) => onSymbolClick && onSymbolClick(clickId)} />
                        );
                    }
                    // Standard external link
                    return <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline" {...props}>{children}</a>;
                },
                code: ({node, className, children, ...props}: any) => {
                    const isBlock = /language-/.test(className || '');
                    return (
                        <code className={`${isBlock ? '' : 'bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded font-mono text-sm before:content-[""] after:content-[""]'}`} {...props}>
                            {children}
                        </code>
                    );
                },
                p: ({children}: any) => <p className="mb-2 last:mb-0 inline-block">{children}</p>
             }}
           >
             {markdownContent}
           </ReactMarkdown>
        </div>
      );
    });
  };

  return (
    <div className={`flex w-full mb-6 ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`flex max-w-[90%] md:max-w-[80%] gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
        
        {/* Avatar */}
        <div className={`flex-shrink-0 w-8 h-8 rounded flex items-center justify-center shadow-sm border
          ${isUser 
            ? 'bg-indigo-600 border-indigo-500 text-white' 
            : 'bg-gray-900 border-gray-700 text-emerald-500'
          }`}>
          {isUser ? <User size={16} /> : <Terminal size={16} />}
        </div>

        {/* Bubble */}
        <div className={`flex flex-col items-start ${isUser ? 'items-end' : 'items-start'} w-full min-w-0`}>
          <div className={`relative px-4 py-3 rounded-lg shadow-sm text-base leading-relaxed w-full
            ${isUser 
              ? 'bg-indigo-600 text-white' 
              : 'bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-300 border border-gray-200 dark:border-gray-800'
            }`}>
            
            {/* Tool Indicators */}
            {message.toolCalls && message.toolCalls.length > 0 && (
               <div className="mb-3 w-full border-b border-gray-100 dark:border-gray-800 pb-2">
                 <ToolIndicator toolCalls={message.toolCalls} isFinished={!message.isStreaming || message.content.length > 0} />
               </div>
            )}

            {/* Message Content */}
            <div className={`w-full break-words`}>
              {formatText(message.content)}
            </div>

            {/* Streaming Cursor */}
            {message.isStreaming && (
              <span className="inline-block w-2 h-4 ml-1 align-middle bg-emerald-500 opacity-75 animate-pulse" />
            )}
          </div>
          
          <div className="text-[10px] text-gray-400 dark:text-gray-600 mt-1 px-1 font-mono">
            {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>

      </div>
    </div>
  );
};
