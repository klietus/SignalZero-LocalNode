
import React, { useRef } from 'react';
import { Plus, Upload, HelpCircle, ShieldCheck } from 'lucide-react';

interface ContextScreenProps {
  onNewProject: () => void;
  onImportProject: (file: File) => void;
  onHelp: () => void;
}

export const ContextScreen: React.FC<ContextScreenProps> = ({ onNewProject, onImportProject, onHelp }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onImportProject(file);
    }
    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="flex flex-col items-center justify-center h-full bg-gray-50 dark:bg-gray-900 font-sans p-6">
      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={handleFileChange} 
        accept=".szproject,.zip" 
        className="hidden" 
      />
      
      <div className="max-w-3xl w-full text-center space-y-12">
        
        <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-700">
          <div className="inline-flex p-6 rounded-full bg-white dark:bg-gray-900 shadow-xl border border-gray-100 dark:border-gray-800 mb-4">
             <ShieldCheck size={64} className="text-emerald-500" />
          </div>
          <h1 className="text-4xl md:text-5xl font-bold font-mono tracking-tighter text-gray-900 dark:text-white">
            SignalZero <span className="text-emerald-500">Kernel</span>
          </h1>
          <p className="text-gray-500 dark:text-gray-400 font-mono text-sm max-w-md mx-auto leading-relaxed">
            Recursive Symbolic Execution Environment<br/>
            v2.0.1 [ΣTR-ACTIVE]
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full animate-in fade-in slide-in-from-bottom-8 duration-1000 delay-200">
          
          <button 
            onClick={onNewProject}
            className="flex flex-col items-center justify-center p-8 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl hover:border-emerald-500 dark:hover:border-emerald-500 hover:shadow-xl transition-all group gap-4 transform hover:-translate-y-1"
          >
            <div className="p-4 rounded-full bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 group-hover:scale-110 transition-transform">
              <Plus size={32} />
            </div>
            <div className="text-center">
              <h3 className="font-bold text-gray-900 dark:text-white font-mono mb-1 text-lg">New Project</h3>
              <p className="text-xs text-gray-500 font-mono">Initialize fresh kernel state</p>
            </div>
          </button>

          <button 
            onClick={() => fileInputRef.current?.click()}
            className="flex flex-col items-center justify-center p-8 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl hover:border-indigo-500 dark:hover:border-indigo-500 hover:shadow-xl transition-all group gap-4 transform hover:-translate-y-1"
          >
            <div className="p-4 rounded-full bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 group-hover:scale-110 transition-transform">
              <Upload size={32} />
            </div>
            <div className="text-center">
              <h3 className="font-bold text-gray-900 dark:text-white font-mono mb-1 text-lg">Load Project</h3>
              <p className="text-xs text-gray-500 font-mono">Import .szproject archive</p>
            </div>
          </button>

          <button 
            onClick={onHelp}
            className="flex flex-col items-center justify-center p-8 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-2xl hover:border-amber-500 dark:hover:border-amber-500 hover:shadow-xl transition-all group gap-4 transform hover:-translate-y-1"
          >
            <div className="p-4 rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 group-hover:scale-110 transition-transform">
              <HelpCircle size={32} />
            </div>
            <div className="text-center">
              <h3 className="font-bold text-gray-900 dark:text-white font-mono mb-1 text-lg">System Help</h3>
              <p className="text-xs text-gray-500 font-mono">Documentation & Tools</p>
            </div>
          </button>

        </div>

        <div className="text-[10px] text-gray-400 font-mono animate-in fade-in duration-1000 delay-500 pt-8 opacity-60">
          Secure Environment • Local Storage Only • No External Logging
        </div>

      </div>
    </div>
  );
};
