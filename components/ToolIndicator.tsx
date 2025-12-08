import React from 'react';
import { Terminal, CheckCircle2, CircleDashed } from 'lucide-react';
import { ToolCallDetails } from '../types';

interface ToolIndicatorProps {
  toolCalls: ToolCallDetails[];
  isFinished?: boolean;
}

export const ToolIndicator: React.FC<ToolIndicatorProps> = ({ toolCalls, isFinished = false }) => {
  if (!toolCalls || toolCalls.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 my-2">
      {toolCalls.map((call, idx) => (
        <div 
          key={call.id || idx}
          className="flex items-center gap-3 p-3 text-sm rounded-lg bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 max-w-full md:max-w-md animate-in fade-in slide-in-from-bottom-2 duration-300"
        >
          <div className="flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
            {isFinished ? (
              <CheckCircle2 size={16} />
            ) : (
              <Terminal size={16} />
            )}
          </div>
          
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
                <span className="font-semibold text-gray-700 dark:text-gray-200 truncate">
                    {call.name.replace(/_/g, ' ')}
                </span>
                {!isFinished && <CircleDashed size={14} className="animate-spin text-gray-400"/>}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate mt-0.5">
              Arguments: {JSON.stringify(call.args)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};