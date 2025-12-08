
import React from 'react';
import {
  FolderOpen, Database, Hammer, FlaskConical, MessageSquare,
  Network, Settings, HelpCircle, ShieldCheck
} from 'lucide-react';

export interface HeaderProps {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  children?: React.ReactNode; // For screen-specific actions (Right side before nav)
  
  // Global Navigation Props
  currentView: string;
  onNavigate: (view: any) => void;
  
  // Global Tools
  onToggleTrace?: () => void;
  isTraceOpen?: boolean;
  onOpenSettings?: () => void;
  
  projectName?: string;
}

export const Header: React.FC<HeaderProps> = ({
  title,
  subtitle,
  icon,
  children,
  currentView,
  onNavigate,
  onToggleTrace,
  isTraceOpen,
  onOpenSettings,
  projectName
}) => {
  const NavButton = ({ view, icon: Icon, label }: any) => (
    <button
      onClick={() => onNavigate(view)}
      className={`p-2 rounded-lg transition-colors ${
        currentView === view 
          ? 'text-indigo-600 bg-indigo-50 dark:bg-indigo-900/20 dark:text-indigo-400 font-bold' 
          : 'text-gray-500 hover:text-indigo-500 hover:bg-gray-100 dark:hover:bg-gray-800'
      }`}
      title={label}
    >
      <Icon size={18} />
    </button>
  );

  return (
    <header className="h-14 bg-white/50 dark:bg-gray-900/50 backdrop-blur border-b border-gray-200 dark:border-gray-800 flex items-center justify-between px-6 z-20 shrink-0">
      
      {/* Left: Identity / Screen Title */}
      <div className="flex items-center gap-4 min-w-0">
        <div className="flex items-center gap-3 min-w-0">
            {icon && <div className="text-gray-500 dark:text-gray-400 shrink-0">{icon}</div>}
            <div className="min-w-0">
                <h1 className="text-lg font-bold font-mono text-gray-900 dark:text-white flex items-center gap-2 truncate">
                    {title}
                </h1>
                {subtitle && <p className="text-xs text-gray-500 font-mono truncate">{subtitle}</p>}
            </div>
        </div>
        
        {/* Project Name Badge */}
        {projectName && (
             <span className="hidden lg:inline-flex items-center gap-1 text-[10px] text-gray-400 font-mono px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 ml-4 truncate max-w-[200px]">
                <ShieldCheck size={10} /> {projectName}
            </span>
        )}
      </div>

      {/* Center/Right: Navigation & Actions */}
      <div className="flex items-center gap-4 shrink-0">
        
        {/* Screen Specific Actions (passed as children) */}
        {children && (
            <div className="flex items-center gap-2 border-r border-gray-200 dark:border-gray-700 pr-4 mr-2">
                {children}
            </div>
        )}

        {/* Global Navigation */}
        <div className="flex items-center gap-1">
            <NavButton view="project" icon={FolderOpen} label="Project Manager" />
            <NavButton view="store" icon={Database} label="Symbol Store" />
            <NavButton view="dev" icon={Hammer} label="Symbol Forge" />
            <NavButton view="test" icon={FlaskConical} label="Test Runner" />
            
            <div className="h-4 w-px bg-gray-300 dark:bg-gray-700 mx-2"></div>

            {onToggleTrace && (
                <button 
                    onClick={onToggleTrace} 
                    className={`p-2 rounded-lg transition-colors ${isTraceOpen ? 'text-amber-500 bg-amber-50 dark:bg-amber-900/20' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'}`} 
                    title="Toggle Reasoning Trace"
                >
                    <Network size={18} />
                </button>
            )}
            
            {onOpenSettings && (
                <button onClick={onOpenSettings} className="p-2 text-gray-500 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors" title="Settings">
                    <Settings size={18} />
                </button>
            )}

            <NavButton view="help" icon={HelpCircle} label="Help" />

            <div className="h-4 w-px bg-gray-300 dark:bg-gray-700 mx-2"></div>

            <NavButton view="chat" icon={MessageSquare} label="Kernel Chat" />
        </div>
      </div>
    </header>
  );
};
