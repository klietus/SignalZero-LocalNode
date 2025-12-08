
import React, { useState, useEffect, useRef } from 'react';
import { Terminal, ShieldCheck, MessageSquare, Database } from 'lucide-react';
import { Message, Sender, UserProfile, TraceData, SymbolDef, TestResult, ProjectMeta, ProjectImportStats } from './types';
import { ChatMessage } from './components/ChatMessage';
import { ChatInput } from './components/ChatInput';
import { SettingsDialog } from './components/SettingsDialog';
import { Header, HeaderProps } from './components/Header';
// Panels
import { SymbolDetailPanel } from './components/panels/SymbolDetailPanel';
import { DomainPanel } from './components/panels/DomainPanel';
import { TracePanel } from './components/panels/TracePanel';
// Screens
import { SymbolDevScreen } from './components/screens/SymbolDevScreen';
import { SymbolStoreScreen } from './components/screens/SymbolStoreScreen';
import { TestRunnerScreen } from './components/screens/TestRunnerScreen';
import { ProjectScreen } from './components/screens/ProjectScreen';
import { ContextScreen } from './components/screens/ContextScreen';
import { HelpScreen } from './components/screens/HelpScreen';

import { getChatSession, resetChatSession, sendMessageAndHandleTools, runSignalZeroTest, runBaselineTest, evaluateComparison } from './services/gemini';
import { createToolExecutor } from './services/toolsService';
import { domainService } from './services/domainService';
import { projectService } from './services/projectService';
import { testService } from './services/testService';
import { settingsService } from './services/settingsService';
import { traceService } from './services/traceService';

// Import Symbolic System Files
import { ACTIVATION_PROMPT } from './symbolic_system/activation_prompt';

// Placeholder Client ID - Replace with your actual Google Cloud Console Client ID
const GOOGLE_CLIENT_ID = "242339309688-hk26i9tbv5jei62s2p1bcqsacvk8stga.apps.googleusercontent.com";

// Simple JWT Decode helper
function parseJwt(token: string) {
  var base64Url = token.split('.')[1];
  var base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  var jsonPayload = decodeURIComponent(window.atob(base64).split('').map(function(c) {
      return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
  }).join(''));
  return JSON.parse(jsonPayload);
}

// --- Components ---

interface LoginScreenProps {
  onGoogleLogin: (response: any) => void;
  onGuestLogin: () => void;
}

const LoginScreen: React.FC<LoginScreenProps> = ({ onGoogleLogin, onGuestLogin }) => {
  useEffect(() => {
    // Check if google is available or wait for it
    const initGoogle = () => {
      // @ts-ignore
      if (window.google) {
        // @ts-ignore
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: onGoogleLogin
        });
        // @ts-ignore
        window.google.accounts.id.renderButton(
          document.getElementById("googleSignInDiv"),
          { theme: "outline", size: "large", width: 280, shape: "rectangular" }
        );
      }
    };
    
    // Attempt initialization
    const timer = setInterval(() => {
        // @ts-ignore
        if (window.google) {
            initGoogle();
            clearInterval(timer);
        }
    }, 100);
    return () => clearInterval(timer);
  }, [onGoogleLogin]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-950 text-gray-200 p-4 font-mono">
        <div className="max-w-md w-full bg-gray-900 border border-gray-800 rounded-lg shadow-2xl p-8 relative overflow-hidden">
             <div className="absolute top-0 left-0 w-full h-1 bg-emerald-500/50"></div>
             
             <div className="flex justify-center mb-6">
                 <div className="p-4 bg-gray-950 rounded-full border border-gray-800 text-emerald-500">
                     <ShieldCheck size={48} />
                 </div>
             </div>

             <h1 className="text-xl font-bold text-center mb-2 tracking-tight">SignalZero Kernel</h1>
             <p className="text-center text-gray-500 text-xs mb-8 uppercase tracking-widest">Identity Gate Active [ΣTR]</p>

             <div className="space-y-6">
                 <div className="flex justify-center">
                    <div id="googleSignInDiv" className="min-h-[40px]"></div>
                 </div>

                 <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                        <span className="w-full border-t border-gray-800"></span>
                    </div>
                    <div className="relative flex justify-center text-[10px] uppercase">
                        <span className="bg-gray-900 px-2 text-gray-600 tracking-widest">Development</span>
                    </div>
                 </div>

                 <button 
                    onClick={onGuestLogin}
                    className="w-full py-2.5 bg-gray-800/50 hover:bg-gray-800 border border-gray-700/50 hover:border-emerald-500/30 text-gray-400 hover:text-emerald-400 rounded transition-all duration-300 text-xs font-mono uppercase tracking-wider flex items-center justify-center gap-2 group"
                 >
                    <span className="w-1.5 h-1.5 rounded-full bg-gray-600 group-hover:bg-emerald-500 transition-colors"></span>
                    Initialize Guest Session
                 </button>
             </div>

             <div className="mt-8 text-center text-[10px] text-gray-600">
                 Secure Symbolic Environment v2.0
             </div>
        </div>
    </div>
  );
};

interface ImportStatusModalProps {
    stats: ProjectImportStats | null;
    onClose: () => void;
}

const ImportStatusModal: React.FC<ImportStatusModalProps> = ({ stats, onClose }) => {
    if (!stats) return null;

    return (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl max-w-md w-full border border-gray-200 dark:border-gray-800 overflow-hidden flex flex-col max-h-[80vh] animate-in zoom-in-95 duration-200">
                <div className="p-4 bg-emerald-50 dark:bg-emerald-900/20 border-b border-emerald-100 dark:border-emerald-800 flex justify-between items-center">
                    <h3 className="font-bold font-mono text-emerald-700 dark:text-emerald-400 flex items-center gap-2">
                        <Database size={18} /> Project Context Loaded
                    </h3>
                </div>
                
                <div className="p-6 overflow-y-auto space-y-6">
                    
                    <div className="space-y-1">
                        <label className="text-[10px] uppercase font-bold text-gray-400 font-mono tracking-wider">Project Identity</label>
                        <div className="font-bold text-lg text-gray-900 dark:text-white">{stats.meta.name}</div>
                        <div className="text-xs font-mono text-gray-500">v{stats.meta.version} • by {stats.meta.author}</div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        <div className="bg-gray-50 dark:bg-gray-800 p-3 rounded border border-gray-200 dark:border-gray-700">
                            <label className="text-[10px] uppercase font-bold text-gray-400 font-mono block mb-1">Total Symbols</label>
                            <div className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">{stats.totalSymbols}</div>
                        </div>
                        <div className="bg-gray-50 dark:bg-gray-800 p-3 rounded border border-gray-200 dark:border-gray-700">
                            <label className="text-[10px] uppercase font-bold text-gray-400 font-mono block mb-1">Test Cases</label>
                            <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">{stats.testCaseCount}</div>
                        </div>
                    </div>

                    <div className="space-y-2">
                        <label className="text-[10px] uppercase font-bold text-gray-400 font-mono tracking-wider">Loaded Domains ({stats.domains.length})</label>
                        <div className="max-h-40 overflow-y-auto border border-gray-100 dark:border-gray-800 rounded-lg">
                            {stats.domains.map((d, i) => (
                                <div key={i} className="flex justify-between items-center p-2 text-xs border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                                    <span className="font-mono text-gray-700 dark:text-gray-300 truncate max-w-[180px]">{d.name}</span>
                                    <span className="bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 px-1.5 py-0.5 rounded font-mono font-bold text-[10px]">{d.symbolCount}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                </div>

                <div className="p-4 bg-gray-50 dark:bg-gray-950 border-t border-gray-200 dark:border-gray-800">
                    <button 
                        onClick={onClose}
                        className="w-full py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-mono font-bold transition-colors shadow-sm"
                    >
                        Proceed to Project Dashboard
                    </button>
                </div>
            </div>
        </div>
    );
};


function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  
  // Settings / User State via Service
  const [theme, setThemeState] = useState<'light' | 'dark'>(settingsService.getTheme());
  const [user, setUser] = useState<UserProfile | null>(settingsService.getUser());
  
  const [currentView, setCurrentView] = useState<'context' | 'chat' | 'dev' | 'store' | 'test' | 'project' | 'help'>('context');
  
  // System State
  const [activeSystemPrompt, setActiveSystemPrompt] = useState<string>(
      settingsService.getSystemPrompt(ACTIVATION_PROMPT)
  );
  
  // Project Metadata State
  const [projectMeta, setProjectMeta] = useState<ProjectMeta>({
      name: 'SignalZero Project',
      author: 'User',
      version: '1.0.0',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
  });

  // Import Status State
  const [importStats, setImportStats] = useState<ProjectImportStats | null>(null);

  // Dev Screen Props
  const [devInitialDomain, setDevInitialDomain] = useState<string | null>(null);
  const [devInitialSymbol, setDevInitialSymbol] = useState<SymbolDef | null>(null);
  
  // Panel States
  const [selectedSymbolId, setSelectedSymbolId] = useState<string | null>(null);
  const [selectedSymbolContext, setSelectedSymbolContext] = useState<any>(null); // Passed from Chat parsing
  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  
  // Trace Logic States
  const [traceLog, setTraceLog] = useState<TraceData[]>([]);
  const [isTracePanelOpen, setIsTracePanelOpen] = useState(false);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);

  // Test Runner State (Lifted Up)
  const [testResults, setTestResults] = useState<TestResult[]>([]);
  const [isTestRunning, setIsTestRunning] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Apply Theme to DOM
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
      document.body.classList.add('bg-gray-950');
      document.body.classList.remove('bg-gray-50');
    } else {
      document.documentElement.classList.remove('dark');
      document.body.classList.remove('bg-gray-950');
      document.body.classList.add('bg-gray-50');
    }
  }, [theme]);

  // Subscribe to Trace Service updates
  useEffect(() => {
    return traceService.subscribe((traces) => {
        setTraceLog(traces);
    });
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (currentView === 'chat') {
        scrollToBottom();
    }
  }, [messages, currentView]);

  const handleClearChat = () => {
    setMessages([]);
    traceService.clear();
    resetChatSession();
  };

  const handleThemeToggle = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setThemeState(newTheme);
    settingsService.setTheme(newTheme);
  };

  const handleGoogleLogin = (response: any) => {
      try {
          const payload = parseJwt(response.credential);
          const profile: UserProfile = {
              name: payload.name || "User",
              email: payload.email,
              picture: payload.picture
          };
          setUser(profile);
          settingsService.setUser(profile);
      } catch (e) {
          console.error("Login failed", e);
      }
  };

  const handleGuestLogin = () => {
      const guest: UserProfile = {
          name: "Guest Developer",
          email: "dev@signalzero.local",
          picture: ""
      };
      setUser(guest);
      settingsService.setUser(guest);
  };

  const handleLogout = () => {
      setUser(null);
      settingsService.setUser(null);
      handleClearChat();
      setCurrentView('context');
  };

  // --- Handlers ---

  const handleSendMessage = async (text: string) => {
    const newMessage: Message = {
      id: Date.now().toString(),
      role: Sender.USER,
      content: text,
      timestamp: new Date()
    };
    
    setMessages(prev => [...prev, newMessage]);
    setIsProcessing(true);

    try {
        const toolExecutor = createToolExecutor(() => settingsService.getApiKey());
        const chat = getChatSession(activeSystemPrompt);

        // Stream handling
        const stream = sendMessageAndHandleTools(chat, text, toolExecutor);
        
        const responseId = (Date.now() + 1).toString();
        let fullResponseText = "";
        let toolCallsAccumulator: any[] = [];

        // Initial placeholder message
        setMessages(prev => [...prev, {
            id: responseId,
            role: Sender.MODEL,
            content: "",
            timestamp: new Date(),
            isStreaming: true
        }]);

        for await (const chunk of stream) {
            if (chunk.text) {
                fullResponseText += chunk.text;
            }
            if (chunk.toolCalls) {
                toolCallsAccumulator = [...toolCallsAccumulator, ...chunk.toolCalls];
            }
            
            // Update UI
            setMessages(prev => prev.map(m => 
                m.id === responseId 
                ? { 
                    ...m, 
                    content: fullResponseText,
                    toolCalls: toolCallsAccumulator.length > 0 ? toolCallsAccumulator : undefined
                  } 
                : m
            ));
        }

        // Finalize
        setMessages(prev => prev.map(m => 
            m.id === responseId 
            ? { ...m, isStreaming: false } 
            : m
        ));

    } catch (error) {
        console.error("Message failed", error);
        setMessages(prev => [...prev, {
            id: Date.now().toString(),
            role: Sender.SYSTEM,
            content: `Error: ${String(error)}`,
            timestamp: new Date()
        }]);
    } finally {
        setIsProcessing(false);
    }
  };

  const handleSymbolClick = async (id: string, data?: any) => {
      // 1. Try Local
      const cached = await domainService.findById(id);
      if (cached) {
          setSelectedSymbolId(id);
          setSelectedSymbolContext(null); // Clear context if found in cache
      } else {
          // 2. Pass context data (Candidate)
          setSelectedSymbolId(id);
          setSelectedSymbolContext(data);
      }
  };

  const handleDomainClick = (domain: string) => {
      setSelectedDomain(domain);
  };

  const handleTraceClick = (id: string) => {
      setSelectedTraceId(id);
      setIsTracePanelOpen(true);
  };

  const handleLoadDomain = (domain: string) => {
      handleSendMessage(`Load the ${domain} domain. All pages.`);
  };

  const handleInterpretSymbol = (id: string) => {
      handleSendMessage(`Interpret this symbol: ${id}`);
  };

  const handleEditSymbol = (data: SymbolDef) => {
      setDevInitialSymbol(data);
      if (data.symbol_domain) setDevInitialDomain(data.symbol_domain);
      setCurrentView('dev');
      setSelectedSymbolId(null); // Close panel
  };

  const handleRunTests = async (prompts: string[]) => {
      if (prompts.length === 0) return;
      
      setIsTestRunning(true);
      setTestResults(prompts.map((p, i) => ({ 
          id: `test-${Date.now()}-${i}`, 
          prompt: p, 
          status: 'pending' 
      })));

      const toolExecutor = createToolExecutor(() => settingsService.getApiKey());

      try {
          for (let i = 0; i < prompts.length; i++) {
              const prompt = prompts[i];
              
              // Set status running
              setTestResults(prev => {
                  const copy = [...prev];
                  copy[i].status = 'running';
                  return copy;
              });

              // Snapshot traces count before run
              const traceSnapshotIndex = traceService.getTraces().length;

              // 1. Run SignalZero (Symbolic)
              const szResult = await runSignalZeroTest(
                  prompt, 
                  toolExecutor,
                  ["Load domains", "Load symbols for domains"] // Priming
              );

              // Capture new traces generated during test execution
              const allTraces = traceService.getTraces();
              const newTraces = allTraces.slice(traceSnapshotIndex);

              // 2. Run Baseline (Standard)
              const baseResult = await runBaselineTest(prompt);

              // 3. Evaluate
              const evalMetrics = await evaluateComparison(prompt, szResult.text, baseResult);

              // Update Result
              setTestResults(prev => {
                  const copy = [...prev];
                  copy[i] = {
                      ...copy[i],
                      status: 'completed',
                      signalZeroResponse: szResult.text,
                      baselineResponse: baseResult,
                      evaluation: evalMetrics,
                      traces: newTraces, // Use captured traces from service
                      meta: szResult.meta
                  };
                  return copy;
              });
          }
      } catch (e) {
          console.error("Test suite failed", e);
      } finally {
          setIsTestRunning(false);
      }
  };

  const handleNewProject = async (skipConfirm: boolean = false) => {
      if (!skipConfirm && !confirm("Start a new project? This will reset the current session context.")) return;
      
      handleClearChat();
      setProjectMeta({
          name: 'New SignalZero Project',
          author: user?.name || 'User',
          version: '1.0.0',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
      });
      setActiveSystemPrompt(ACTIVATION_PROMPT);
      testService.clearTests();
      await domainService.clearAll();
      settingsService.clearSystemPrompt();
      
      // Redirect to Project Manager to setup details
      setCurrentView('project');
  };

  const handleImportProject = async (file: File) => {
      console.log("[App] handleImportProject invoked with", file.name);
      try {
          const { systemPrompt, stats } = await projectService.import(file);
          console.log("[App] Import service returned stats:", stats);
          
          setActiveSystemPrompt(systemPrompt);
          settingsService.setSystemPrompt(systemPrompt);
          
          setProjectMeta(stats.meta);
          console.log("[App] Setting import stats to trigger modal");
          setImportStats(stats); // Triggers Modal
          
          handleClearChat();
          console.log("[App] Chat cleared, import sequence done");
      } catch (e) {
          console.error("[App] Import error caught in App:", e);
          alert("Project import failed: " + String(e));
          throw e;
      }
  };

  // --- Rendering ---

  if (!user) {
      return <LoginScreen onGoogleLogin={handleGoogleLogin} onGuestLogin={handleGuestLogin} />;
  }

  // Global Header Props Generator
  const getHeaderProps = (title: string, icon?: React.ReactNode): Omit<HeaderProps, 'children'> => ({
      title,
      icon,
      currentView,
      onNavigate: setCurrentView,
      onToggleTrace: () => setIsTracePanelOpen(prev => !prev),
      isTraceOpen: isTracePanelOpen,
      onOpenSettings: () => setIsSettingsOpen(true),
      projectName: projectMeta.name
  });

  const renderView = () => {
      switch (currentView) {
          case 'context':
              return (
                  <ContextScreen 
                      onNewProject={() => handleNewProject(true)} 
                      onImportProject={handleImportProject}
                      onHelp={() => setCurrentView('help')}
                  />
              );
          case 'project':
              return (
                  <ProjectScreen 
                      headerProps={getHeaderProps('Project Manager')}
                      projectMeta={projectMeta}
                      setProjectMeta={setProjectMeta}
                      systemPrompt={activeSystemPrompt}
                      onSystemPromptChange={(val) => {
                          setActiveSystemPrompt(val);
                          settingsService.setSystemPrompt(val);
                          resetChatSession(); 
                      }}
                      onClearChat={handleClearChat}
                      onImportProject={handleImportProject}
                      onNewProject={() => handleNewProject(true)}
                  />
              );
          case 'dev':
              return (
                  <SymbolDevScreen 
                      headerProps={getHeaderProps('Symbol Forge')}
                      onBack={() => {
                          setDevInitialSymbol(null);
                          setCurrentView('chat');
                      }} 
                      initialDomain={devInitialDomain}
                      initialSymbol={devInitialSymbol}
                  />
              );
          case 'store':
              return (
                  <SymbolStoreScreen 
                      headerProps={getHeaderProps('Symbol Store')}
                      onBack={() => setCurrentView('chat')} 
                      onNavigateToForge={(dom) => {
                          setDevInitialDomain(dom);
                          setCurrentView('dev');
                      }}
                  />
              );
          case 'test':
              return (
                  <TestRunnerScreen 
                      headerProps={getHeaderProps('Test Runner')}
                      onBack={() => setCurrentView('chat')}
                      results={testResults}
                      isRunning={isTestRunning}
                      onRun={handleRunTests}
                  />
              );
          case 'help':
              return (
                  <HelpScreen headerProps={getHeaderProps('Documentation')} />
              );
          case 'chat':
          default:
              return (
                <div className="flex flex-col h-full relative">
                    
                    <Header 
                        {...getHeaderProps('Kernel Chat', <MessageSquare size={18} className="text-indigo-500" />)}
                        subtitle="Recursive Symbolic Interface"
                    />

                    {/* Chat Area */}
                    <div className="flex-1 overflow-y-auto px-4 py-6 scroll-smooth">
                        <div className="max-w-full mx-auto space-y-6 pb-4">
                            {messages.length === 0 && (
                                <div className="flex flex-col items-center justify-center h-64 text-gray-400 space-y-4">
                                    <Terminal size={48} className="opacity-20" />
                                    <div className="text-center">
                                        <p className="font-mono text-sm mb-2">Kernel Ready. Recursive context loaded.</p>
                                        <div className="flex gap-2 justify-center">
                                            <button onClick={() => handleSendMessage("Boot the system")} className="px-3 py-1.5 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded text-xs font-mono transition-colors">Boot the system</button>
                                            <button onClick={() => handleSendMessage("Load domains")} className="px-3 py-1.5 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded text-xs font-mono transition-colors">Load domains</button>
                                            <button onClick={() => handleSendMessage("Test this sample")} className="px-3 py-1.5 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded text-xs font-mono transition-colors">Test this sample</button>
                                            <button onClick={() => handleSendMessage("Trace the execution")} className="px-3 py-1.5 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded text-xs font-mono transition-colors">Trace the execution</button>
                                        </div>
                                    </div>
                                </div>
                            )}
                            
                            {messages.map((msg) => (
                                <ChatMessage 
                                    key={msg.id} 
                                    message={msg} 
                                    onSymbolClick={handleSymbolClick}
                                    onDomainClick={handleDomainClick}
                                    onTraceClick={handleTraceClick}
                                />
                            ))}
                            <div ref={messagesEndRef} />
                        </div>
                    </div>

                    <ChatInput onSend={handleSendMessage} disabled={isProcessing} />

                    {/* Panels */}
                    <SymbolDetailPanel 
                        symbolId={selectedSymbolId} 
                        symbolData={selectedSymbolContext}
                        onClose={() => {
                            setSelectedSymbolId(null);
                            setSelectedSymbolContext(null);
                        }} 
                        onSymbolClick={handleSymbolClick}
                        onDomainClick={handleDomainClick}
                        onInterpret={handleInterpretSymbol}
                        onOpenInForge={handleEditSymbol}
                    />

                    <DomainPanel 
                        domain={selectedDomain} 
                        onClose={() => setSelectedDomain(null)} 
                        onSymbolClick={handleSymbolClick}
                        onLoadDomain={handleLoadDomain}
                        onDomainChange={setSelectedDomain}
                    />

                    <TracePanel 
                        isOpen={isTracePanelOpen}
                        onClose={() => setIsTracePanelOpen(false)}
                        traces={traceLog}
                        selectedTraceId={selectedTraceId}
                        onSelectTrace={setSelectedTraceId}
                        onSymbolClick={handleSymbolClick}
                    />
                </div>
              );
      }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-950 font-sans text-gray-900 dark:text-gray-100 transition-colors duration-300">
        <div className="flex-1 flex flex-col min-w-0">
            {renderView()}
        </div>

        <SettingsDialog 
            isOpen={isSettingsOpen} 
            onClose={() => setIsSettingsOpen(false)}
            user={user}
            onLogout={handleLogout}
            theme={theme}
            onThemeToggle={handleThemeToggle}
        />

        <ImportStatusModal 
            stats={importStats}
            onClose={() => {
                setImportStats(null);
                setCurrentView('project'); // Navigate to project dashboard on success
            }}
        />
    </div>
  );
}

export default App;
