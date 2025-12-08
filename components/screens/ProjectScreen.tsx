
import React, { useState, useRef } from 'react';
import { Package, Download, Upload, Save, AlertTriangle, FileText, Loader2, Plus } from 'lucide-react';
import { projectService } from '../../services/projectService';
import { ProjectMeta } from '../../types';
import { Header, HeaderProps } from '../Header';

interface ProjectScreenProps {
  // onBack removed as global nav handles it
  headerProps: Omit<HeaderProps, 'children'>;
  projectMeta: ProjectMeta;
  setProjectMeta: (meta: ProjectMeta) => void;
  systemPrompt: string;
  onSystemPromptChange: (newPrompt: string) => void;
  onClearChat: () => void;
  onImportProject: (file: File) => Promise<void>;
  onNewProject: () => void;
}

export const ProjectScreen: React.FC<ProjectScreenProps> = ({ 
    headerProps,
    projectMeta,
    setProjectMeta,
    systemPrompt, 
    onSystemPromptChange,
    onClearChat,
    onImportProject,
    onNewProject
}) => {
  const [promptText, setPromptText] = useState(systemPrompt);
  
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  
  // New Project Modal State
  const [isNewProjectModalOpen, setIsNewProjectModalOpen] = useState(false);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSavePrompt = () => {
      onSystemPromptChange(promptText);
      alert("System Prompt updated active context.");
  };

  const handleExportProject = async () => {
      setIsExporting(true);
      try {
          const blob = await projectService.export(projectMeta, promptText);
          
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = `${projectMeta.name.toLowerCase().replace(/\s+/g, '-')}.szproject`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(url);

      } catch (e) {
          console.error("Export failed", e);
          alert("Failed to export project: " + String(e));
      } finally {
          setIsExporting(false);
      }
  };

  const handleImportClick = () => {
      if (fileInputRef.current) {
          console.log("[ProjectScreen] Triggering file input click");
          fileInputRef.current.click();
      } else {
          console.error("[ProjectScreen] File input ref is null");
      }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
      console.log("[ProjectScreen] File input change event triggered");
      const file = e.target.files?.[0];
      if (!file) {
          console.warn("[ProjectScreen] No file selected in input");
          return;
      }

      console.log(`[ProjectScreen] File selected: ${file.name} (${file.size} bytes, type: ${file.type})`);

      // NOTE: Removed native confirm() dialog as it was causing issues with cancellation logging in some environments.
      // Importing is an explicit action via file selector, so we proceed directly.
      
      console.log("[ProjectScreen] Starting import process...");
      setIsImporting(true);
      try {
          console.log("[ProjectScreen] Calling onImportProject...");
          await onImportProject(file);
          console.log("[ProjectScreen] onImportProject returned successfully");
      } catch (err) {
          console.error("[ProjectScreen] Import failed in screen:", err);
          alert(`Import Failed: ${String(err)}`);
      } finally {
          setIsImporting(false);
          if (fileInputRef.current) fileInputRef.current.value = '';
          console.log("[ProjectScreen] Import process cleanup complete");
      }
  };

  const handleChangeMeta = (field: keyof ProjectMeta, value: string) => {
      setProjectMeta({ ...projectMeta, [field]: value });
  };

  // --- New Project Handlers ---
  const handleNewProjectClick = () => {
      setIsNewProjectModalOpen(true);
  };

  const confirmNewProject = (shouldExport: boolean) => {
      if (shouldExport) {
          handleExportProject().then(() => {
              onNewProject();
              setIsNewProjectModalOpen(false);
          });
      } else {
          onNewProject();
          setIsNewProjectModalOpen(false);
      }
  };

  return (
    <div className="flex flex-col h-full bg-gray-50 dark:bg-gray-950 font-sans text-gray-800 dark:text-gray-200">
      {/* Input hidden with style to prevent layout issues but ensure presence */}
      <input 
          type="file" 
          ref={fileInputRef} 
          onChange={handleFileChange} 
          accept=".szproject,.zip" 
          style={{ display: 'none' }}
      />

      <Header {...headerProps}>
         <div className="flex items-center gap-2">
             <button 
                onClick={handleNewProjectClick}
                className="flex items-center gap-2 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-md text-xs font-mono font-bold transition-colors"
             >
                 <Plus size={14} /> New Project
             </button>
             <button 
                onClick={handleImportClick}
                disabled={isImporting}
                className="flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-md text-xs font-mono font-bold transition-colors border border-gray-200 dark:border-gray-700"
             >
                 {isImporting ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                 Import
             </button>
             <button 
                onClick={handleExportProject}
                disabled={isExporting}
                className="flex items-center gap-2 px-3 py-1.5 bg-orange-600 hover:bg-orange-700 text-white rounded-md text-xs font-mono font-bold transition-colors shadow-sm"
             >
                 {isExporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                 Export
             </button>
         </div>
      </Header>

      <div className="flex-1 overflow-y-auto p-8">
          <div className="max-w-4xl mx-auto space-y-8">
              
              {/* Meta Section */}
              <section className="bg-white dark:bg-gray-900 rounded-xl p-6 border border-gray-200 dark:border-gray-800 shadow-sm space-y-4">
                  <h2 className="text-sm font-bold uppercase tracking-widest text-gray-400 font-mono border-b border-gray-100 dark:border-gray-800 pb-2 mb-4 flex items-center gap-2">
                      <Package size={16} /> Project Metadata
                  </h2>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                      <div className="space-y-1">
                          <label className="text-xs font-bold uppercase tracking-wider text-gray-500 font-mono">Project Name</label>
                          <input 
                              value={projectMeta.name}
                              onChange={(e) => handleChangeMeta('name', e.target.value)}
                              className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                          />
                      </div>
                      <div className="space-y-1">
                          <label className="text-xs font-bold uppercase tracking-wider text-gray-500 font-mono">Version</label>
                          <input 
                              value={projectMeta.version}
                              onChange={(e) => handleChangeMeta('version', e.target.value)}
                              className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                          />
                      </div>
                      <div className="space-y-1">
                          <label className="text-xs font-bold uppercase tracking-wider text-gray-500 font-mono">Author</label>
                          <input 
                              value={projectMeta.author}
                              onChange={(e) => handleChangeMeta('author', e.target.value)}
                              className="w-full bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                          />
                      </div>
                  </div>
              </section>

              {/* System Prompt Editor */}
              <section className="bg-white dark:bg-gray-900 rounded-xl p-6 border border-gray-200 dark:border-gray-800 shadow-sm space-y-4">
                  <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-800 pb-2 mb-4">
                      <h2 className="text-sm font-bold uppercase tracking-widest text-gray-400 font-mono flex items-center gap-2">
                          <FileText size={16} /> Active System Context
                      </h2>
                      <button 
                          onClick={handleSavePrompt}
                          className="flex items-center gap-1.5 px-3 py-1 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 rounded text-xs font-mono font-bold transition-colors"
                      >
                          <Save size={12} /> Apply Changes
                      </button>
                  </div>
                  
                  <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-900/30 p-3 rounded-lg text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2 mb-4">
                      <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                      <span>
                          <strong>Kernel Warning:</strong> Modifying the system prompt fundamentally alters the behavior of SignalZero. 
                          Changes here persist for this project environment.
                      </span>
                  </div>

                  <textarea 
                      value={promptText}
                      onChange={(e) => setPromptText(e.target.value)}
                      className="w-full h-96 bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded p-4 font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-orange-500 resize-none"
                      spellCheck={false}
                  />
              </section>

          </div>
      </div>

      {/* New Project Modal */}
      {isNewProjectModalOpen && (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
              <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl max-w-sm w-full p-6 border border-gray-200 dark:border-gray-800">
                  <h3 className="font-bold font-mono text-gray-900 dark:text-white mb-2 text-lg">Start New Project?</h3>
                  <p className="text-sm text-gray-600 dark:text-gray-300 mb-6">
                      This will reset the current environment. You can export the current project first.
                  </p>
                  <div className="flex flex-col gap-2">
                      <button 
                          onClick={() => confirmNewProject(true)} 
                          className="w-full py-2 bg-orange-600 hover:bg-orange-700 text-white rounded text-xs font-mono font-bold flex items-center justify-center gap-2"
                      >
                          <Download size={14} /> Export & New
                      </button>
                      <button 
                          onClick={() => confirmNewProject(false)} 
                          className="w-full py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-mono font-bold"
                      >
                          Discard & New
                      </button>
                      <button 
                          onClick={() => setIsNewProjectModalOpen(false)} 
                          className="w-full py-2 border border-gray-300 dark:border-gray-700 rounded text-xs font-mono hover:bg-gray-50 dark:hover:bg-gray-800"
                      >
                          Cancel
                      </button>
                  </div>
              </div>
          </div>
      )}

    </div>
  );
};
