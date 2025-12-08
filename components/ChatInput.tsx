import React, { useState, useRef, useEffect } from 'react';
import { SendHorizontal, Loader2 } from 'lucide-react';

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export const ChatInput: React.FC<ChatInputProps> = ({ onSend, disabled }) => {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [text]);

  // Maintain focus when re-enabled
  useEffect(() => {
    if (!disabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [disabled]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (text.trim() && !disabled) {
      onSend(text.trim());
      setText('');
      // Reset height and keep focus
      if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
          textareaRef.current.focus();
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="w-full bg-white/90 dark:bg-gray-950/90 backdrop-blur-md border-t border-gray-200 dark:border-gray-800 p-4 sticky bottom-0 z-10 transition-colors duration-300">
      <div className="max-w-full mx-auto relative px-4">
        <form onSubmit={handleSubmit} className="relative flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter symbolic input or natural language..."
            rows={1}
            disabled={disabled}
            className="w-full bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100 rounded-lg py-3 pl-4 pr-12 resize-none focus:outline-none focus:ring-1 focus:ring-emerald-500/50 border border-transparent dark:border-gray-800 transition-all max-h-32 disabled:opacity-50 disabled:cursor-not-allowed font-sans text-base"
          />
          
          <button
            type="submit"
            disabled={!text.trim() || disabled}
            className="absolute right-2 bottom-2 p-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-md transition-all disabled:opacity-0 disabled:scale-75 shadow-sm"
            aria-label="Send message"
          >
            {disabled ? <Loader2 className="animate-spin" size={18} /> : <SendHorizontal size={18} />}
          </button>
        </form>
        <div className="text-center mt-2 text-[10px] text-gray-400 dark:text-gray-600 font-mono">
            SignalZero Kernel • Symbolic Recursion Active
        </div>
      </div>
    </div>
  );
};