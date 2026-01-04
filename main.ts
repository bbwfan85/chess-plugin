import { App, Plugin, PluginSettingTab, Setting, MarkdownPostProcessorContext, DataAdapter } from 'obsidian';

interface ChessPluginSettings {
  defaultFlipped: boolean;
  defaultBoardSize: number;
  enableEngine: boolean;
  engineDepth: number;
  animationDuration: number; // Animation duration in ms for piece movements
}

// Helper to detect mobile/touch devices
const isMobileDevice = (): boolean => {
  return window.innerWidth < 1024 || 'ontouchstart' in window || navigator.maxTouchPoints > 0;
};

// Individual board data stored inline in the code block (after <!--chess-data--> delimiter)
interface InlineBoardData {
  sizes?: { boardWidth?: number, infoWidth?: number, totalHeight?: number, moveListHeight?: number };
  annotations?: { [moveIndex: number]: { arrows: { from: [number, number], to: [number, number] }[], highlights: string[] } };
  notes?: { [moveIndex: number]: string };
  currentMove?: number; // Track current position to restore after re-render
  flipped?: boolean; // Track board orientation
}

// Individual board data stored in separate files (legacy, for migration)
interface BoardFileData {
  sizes?: { boardWidth?: number, infoWidth?: number, totalHeight?: number, moveListHeight?: number };
  annotations?: { [moveIndex: number]: { arrows: { from: [number, number], to: [number, number] }[], highlights: string[] } };
  notes?: { [moveIndex: number]: string };
  currentMove?: number; // Track current position to restore after re-render
  flipped?: boolean; // Track board orientation
}

// Legacy data structure (for migration)
interface LegacyChessBoardData {
  sizes: { [boardId: string]: { boardWidth?: number, infoWidth?: number, totalHeight?: number, moveListHeight?: number } };
  annotations: { [boardId: string]: { [moveIndex: number]: { arrows: { from: [number, number], to: [number, number] }[], highlights: string[] } } };
  notes: { [boardId: string]: { [moveIndex: number]: string } };
}
const DEFAULT_SETTINGS: ChessPluginSettings = {
  defaultFlipped: false,
  defaultBoardSize: 500,
  enableEngine: true,
  engineDepth: 16,
  animationDuration: 100 // Default 100ms animation
}

// Note: ANNOTATIONS_FOLDER will be constructed dynamically using this.app.vault.configDir

// Context info for each board to enable inline saving
interface BoardContextInfo {
  ctx: MarkdownPostProcessorContext;
  pgnSource: string;
}

// Engine state that persists across re-renders
interface EngineState {
  worker: Worker | null;
  eval: number | null;
  bestMove: { from: [number, number], to: [number, number] } | null;
  depth: number;
  loading: boolean;
  error: string | null;
  currentFen: string;
  analysisTurn: 'w' | 'b'; // Track which side's turn was being analyzed
}

export default class ChessPlugin extends Plugin {
  settings: ChessPluginSettings;
  private saveTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private boardDataCache: Map<string, BoardFileData> = new Map();
  private boardContextCache: Map<string, BoardContextInfo> = new Map();
  private currentMoveCache: Map<string, number> = new Map(); // Track current move in memory (no file save)
  private engineCache: Map<string, EngineState> = new Map(); // Persist engine across re-renders
  private documentListeners: Map<string, { type: string, handler: EventListener }[]> = new Map(); // Track document listeners for cleanup
  // NEW: Cache for custom board state when user makes manual moves (not in PGN)
  private customBoardCache: Map<string, { 
    board: (string | null)[][], 
    lastMove: { from: number[], to: number[] } | null,
    manualMoveCount: number,
    baseMove: number // The currentMove index this custom state is based on
  }> = new Map();
  // NEW: Cache for flipped state to persist across re-renders
  private flippedCache: Map<string, boolean> = new Map();
  // NEW: Cache for active notes editing state to restore after re-renders
  private activeNotesEditCache: Map<string, {
    cursorPosition: number,
    scrollTop: number,
    textValue: string,
    moveIndex: number
  } | null> = new Map();
  // NEW: Track move list scroll positions to preserve across re-renders
  private moveListScrollCache: Map<string, number> = new Map();
  // NEW: Flag to suppress blur handling during programmatic operations
  private suppressBlur: Map<string, boolean> = new Map();
  // NEW: Cache for resize state to persist across re-renders during active resize
  private resizeStateCache: Map<string, {
    boardWidth: number,
    infoWidth: number,
    totalHeight: number,
    moveListHeight: number,
    isResizingBoard: boolean,
    isResizingHeight: boolean,
    isResizingMovesNotes: boolean,
    // Store start values to continue resize after re-render
    startX?: number,
    startY?: number,
    startBoardWidth?: number,
    startInfoWidth?: number,
    startHeight?: number,
    startMoveListHeight?: number
  }> = new Map();

  async onload() {
    await this.loadSettings();
    
    this.registerMarkdownCodeBlockProcessor('chess', (source, el, ctx) => {
      this.renderChessBoard(source, el, ctx);
    });

    this.addSettingTab(new ChessSettingTab(this.app, this));
  }

  onunload() {
    // Save any pending data before unloading
    for (const [boardId, timeout] of this.saveTimeouts) {
      clearTimeout(timeout);
      // Note: Cannot await in onunload (must return void), save happens synchronously
      this.saveBoardData(boardId);
    }
    this.saveTimeouts.clear();
    this.boardContextCache.clear();

    // Remove all document event listeners
    for (const [boardId, listeners] of this.documentListeners) {
      for (const { type, handler } of listeners) {
        document.removeEventListener(type, handler);
      }
    }
    this.documentListeners.clear();

    // Terminate all engine workers
    for (const [boardId, engineState] of this.engineCache) {
      if (engineState.worker) {
        engineState.worker.postMessage('stop');
        engineState.worker.postMessage('quit');
        engineState.worker.terminate();
      }
    }
    this.engineCache.clear();
    this.activeNotesEditCache.clear();
    this.moveListScrollCache.clear();
    this.suppressBlur.clear();
    this.resizeStateCache.clear();
  }
  
  // Register a document event listener and track it for cleanup
  registerDocumentListener(boardId: string, type: string, handler: EventListener) {
    if (!this.documentListeners.has(boardId)) {
      this.documentListeners.set(boardId, []);
    }
    this.documentListeners.get(boardId)!.push({ type, handler });
    document.addEventListener(type, handler);
  }
  
  // Remove all document listeners for a specific board
  cleanupDocumentListeners(boardId: string) {
    const listeners = this.documentListeners.get(boardId);
    if (listeners) {
      for (const { type, handler } of listeners) {
        document.removeEventListener(type, handler);
      }
      this.documentListeners.delete(boardId);
    }
  }
  
  // Get the annotations folder path using configDir
  getAnnotationsFolder(): string {
    return `${this.app.vault.configDir}/plugins/chess-analysis/annotations`;
  }

  // Ensure the annotations folder exists (legacy, only used for migration fallback)
  async ensureAnnotationsFolder() {
    const adapter = this.app.vault.adapter;
    const annotationsFolder = this.getAnnotationsFolder();
    try {
      const exists = await adapter.exists(annotationsFolder);
      if (!exists) {
        await adapter.mkdir(annotationsFolder);
      }
    } catch (e) {
      console.error('Chess plugin: Error creating annotations folder:', e);
    }
  }

  // Get the file path for a board's data
  getBoardFilePath(boardId: string): string {
    // Sanitize boardId for use as filename
    const safeId = boardId.replace(/[^a-zA-Z0-9-_]/g, '_');
    return `${this.getAnnotationsFolder()}/${safeId}.json`;
  }

  renderChessBoard(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const container = el.createDiv({ cls: 'chess-plugin-container' });
    
    // Generate stable ID based on source content hash AND file context
    // This allows multiple boards in the same note (if they have different content)
    // and the same game in multiple notes to have separate annotations
    // NOTE: We intentionally don't include line number as it can change when
    // content is added/removed above the chess block
    const filePath = ctx.sourcePath || 'unknown';
    
    const { board, moveHistory, pgnData, timestamps, whiteElo, blackElo, whiteName, blackName, inlineData, pgnSource, initialTurn } = this.parseInput(source);
    
    // Use pgnSource for ID generation (without inline data) to keep IDs stable
    const baseId = `chess-${this.hashCode(filePath)}-${this.hashCode(pgnSource)}`;
    
    // For boardId, we need to handle multiple identical PGNs in the same file
    // But we need to avoid race conditions during re-renders where old and new containers coexist
    // Solution: Check if we already have a cached currentMove for this baseId - if so, use baseId directly
    // The occurrence index is only needed for truly NEW boards (not re-renders)
    let boardId: string;
    if (this.currentMoveCache.has(baseId) || this.engineCache.has(baseId) || this.boardDataCache.has(baseId)) {
      // We have cached data for this baseId, so this is likely a re-render - use the same ID
      boardId = baseId;
    } else {
      // Check for other boards with same baseId to handle multiple identical PGNs
      // Only count boards that are NOT being replaced (i.e., not in the same parent element)
      const existingBoards = Array.from(document.querySelectorAll(`[data-board-base-id="${baseId}"]`));
      let occurrenceIndex = 0;
      for (let i = 0; i < existingBoards.length; i++) {
        // Don't count boards that share our parent (they're being replaced)
        if (existingBoards[i].parentElement !== el) {
          occurrenceIndex++;
        }
      }
      boardId = occurrenceIndex > 0 ? `${baseId}-${occurrenceIndex}` : baseId;
    }
    
    container.dataset.boardId = boardId;
    container.dataset.boardBaseId = baseId; // Store base ID for counting
    
    // Store context info for inline saving IMMEDIATELY (before async operations)
    // This ensures the boardId matches what we store
    this.boardContextCache.set(boardId, { ctx, pgnSource });
    
    // Get vault adapter
    const adapter = this.app.vault.adapter;
    const pluginPath = `${this.app.vault.configDir}/plugins/chess-analysis/`;
    
    // Load board data: prefer inline data, fall back to file-based data for migration
    this.loadBoardDataWithInline(boardId, inlineData).then((boardData) => {
      this.renderChessBoardWithData(
        container, boardId, board, moveHistory, pgnData, timestamps,
        whiteElo, blackElo, whiteName, blackName, adapter, pluginPath, boardData,
        ctx, pgnSource, initialTurn
      );
    }).catch((e) => {
      console.error('Chess plugin: Error loading board data:', e);
    });
  }
  
  // Load board data with inline data taking precedence
  async loadBoardDataWithInline(boardId: string, inlineData: InlineBoardData): Promise<BoardFileData> {
    // If we have inline data, use it (and potentially migrate file-based data)
    if (inlineData && (inlineData.sizes || inlineData.annotations || inlineData.notes)) {
      // Update the cache with inline data
      this.boardDataCache.set(boardId, inlineData);
      return inlineData;
    }
    
    // Fall back to loading from file (for migration purposes)
    return await this.loadBoardData(boardId);
  }
  
  renderChessBoardWithData(
    container: HTMLElement,
    boardId: string,
    board: (string | null)[][],
    moveHistory: string[],
    pgnData: { [key: string]: string },
    timestamps: { white: string, black: string }[],
    whiteElo: string,
    blackElo: string,
    whiteName: string,
    blackName: string,
    adapter: any,
    pluginPath: string,
    boardData: BoardFileData,
    ctx: MarkdownPostProcessorContext,
    pgnSource: string,
    initialTurn: 'w' | 'b' = 'w' // Initial turn from FEN or 'w' for standard start
  ) {
    // Clean up any existing document listeners for this board (from previous render)
    this.cleanupDocumentListeners(boardId);
    
    // Context is already stored in renderChessBoard before this async call
    
    // Load saved sizes and annotations for this board
    const savedSizes = boardData.sizes || {};
    const savedAnnotations = this.loadBoardAnnotations(boardId);
    const savedNotes = boardData.notes || {};
    
    // Initialize currentMove:
    // 1. First check in-memory cache (for same-session navigation)
    // 2. Then check file data (for restored sessions/synced data)
    // 3. Default to -1 (starting position)
    const cachedCurrentMove = this.currentMoveCache.get(boardId);
    const savedCurrentMove = boardData.currentMove;
    
    let currentMove: number;
    if (cachedCurrentMove !== undefined && cachedCurrentMove >= -1 && cachedCurrentMove < moveHistory.length) {
      // Use in-memory cache (highest priority - same session)
      currentMove = cachedCurrentMove;
    } else if (savedCurrentMove !== undefined && savedCurrentMove >= -1 && savedCurrentMove < moveHistory.length) {
      // Use file-saved position (for restored/synced sessions)
      currentMove = savedCurrentMove;
    } else {
      // Default to starting position
      currentMove = -1;
    }
    
    // Compute the board state for the current move
    let currentBoard = board;
    let lastMove: { from: number[], to: number[] } | null = null;
    
    // Check if we have a cached custom board state (from manual moves)
    const cachedCustomBoard = this.customBoardCache.get(boardId);
    let manualMoveCount = 0; // Track number of manual moves made from current position (for turn calculation)
    
    if (cachedCustomBoard && cachedCustomBoard.baseMove === currentMove) {
      // Restore the custom board state from manual moves
      currentBoard = cachedCustomBoard.board.map(row => [...row]); // Deep copy
      lastMove = cachedCustomBoard.lastMove;
      manualMoveCount = cachedCustomBoard.manualMoveCount;
    } else if (currentMove >= 0) {
      // No custom state or base move changed - replay from PGN
      // Clear any stale custom board cache
      this.customBoardCache.delete(boardId);
      
      currentBoard = this.getInitialBoard();
      for (let i = 0; i <= currentMove; i++) {
        const result = this.applyMove(currentBoard, moveHistory[i], i === currentMove, moveHistory, i);
        currentBoard = result.board;
        if (i === currentMove && result.moveSquares) {
          lastMove = result.moveSquares;
        }
      }
    } else {
      // At starting position (-1), clear any custom state
      this.customBoardCache.delete(boardId);
    }
    
    // Initialize flipped state: 
    // 1. First check in-memory cache (for same-session)
    // 2. Then check saved board data (for restored sessions)
    // 3. Default to plugin setting
    const cachedFlipped = this.flippedCache.get(boardId);
    const savedFlipped = boardData.flipped;
    let flipped: boolean;
    if (cachedFlipped !== undefined) {
      flipped = cachedFlipped;
    } else if (savedFlipped !== undefined) {
      flipped = savedFlipped;
      // Update cache with loaded value
      this.flippedCache.set(boardId, flipped);
    } else {
      flipped = this.settings.defaultFlipped;
    }
    
    let arrows: { from: [number, number], to: [number, number] }[] = [];
    let highlightedSquares: Set<string> = new Set();
    let moveAnnotations: { [key: number]: { arrows: { from: [number, number], to: [number, number] }[], highlights: Set<string> } } = savedAnnotations;
    let notes: { [key: number]: string } = savedNotes;
    let selectedSquare: number[] | null = null;
    let draggedPiece: { piece: string, fromRow: number, fromCol: number, element: HTMLElement, originalElement: HTMLElement } | null = null;
    let legalMoves: number[][] = [];
    let movesNotesResizeHandler: ((e: MouseEvent) => void) | null = null;
    let movesNotesResizeEndHandler: (() => void) | null = null;
    
    // Check if there's an active resize operation - if so, use those values
    // This allows resize operations to survive re-renders
    const cachedResizeState = this.resizeStateCache.get(boardId);
    let boardWidth = cachedResizeState?.boardWidth ?? savedSizes.boardWidth ?? this.settings.defaultBoardSize;
    let infoWidth = cachedResizeState?.infoWidth ?? savedSizes.infoWidth ?? 350;
    let totalHeight = cachedResizeState?.totalHeight ?? savedSizes.totalHeight ?? 700;
    let moveListHeight = cachedResizeState?.moveListHeight ?? savedSizes.moveListHeight ?? 200; // Default to ~5-6 moves tall on desktop
    
    let isInCheck = false;
    let isCheckmate = false;
    let isEditingNotes = false; // Track notes editing state across renders
    let isManualMove = false; // Track if current move is manual (drag/click) - no animation
    // manualMoveCount is now initialized above from cache or set to 0

    // Engine state - use cached state to persist across re-renders
    let cachedEngine = this.engineCache.get(boardId);
    if (!cachedEngine) {
      cachedEngine = {
        worker: null,
        eval: null,
        bestMove: null,
        depth: 0,
        loading: false,
        error: null,
        currentFen: '',
        analysisTurn: 'w'
      };
      this.engineCache.set(boardId, cachedEngine);
    }
    
    // Local references to cached engine state (for easier access)
    const getEngineWorker = () => cachedEngine!.worker;
    const setEngineWorker = (w: Worker | null) => { cachedEngine!.worker = w; };
    const getEngineEval = () => cachedEngine!.eval;
    const setEngineEval = (e: number | null) => { cachedEngine!.eval = e; };
    const getEngineBestMove = () => cachedEngine!.bestMove;
    const setEngineBestMove = (m: { from: [number, number], to: [number, number] } | null) => { cachedEngine!.bestMove = m; };
    const getEngineDepth = () => cachedEngine!.depth;
    const setEngineDepth = (d: number) => { cachedEngine!.depth = d; };
    const setEngineLoading = (l: boolean) => { cachedEngine!.loading = l; };
    const setEngineError = (e: string | null) => { cachedEngine!.error = e; };
    const getCurrentAnalysisFen = () => cachedEngine!.currentFen;
    const setCurrentAnalysisFen = (f: string) => { cachedEngine!.currentFen = f; };
    const getAnalysisTurn = () => cachedEngine!.analysisTurn;
    const setAnalysisTurn = (t: 'w' | 'b') => { cachedEngine!.analysisTurn = t; };

    // Clock state for timed games
    let whiteTime = timestamps.length > 0 ? this.parseClockTime(timestamps[0]?.white || '0:10:00') : 0;
    let blackTime = timestamps.length > 0 ? this.parseClockTime(timestamps[0]?.black || '0:10:00') : 0;
    
    // Helper function to get the current turn considering manual moves AND initialTurn (for FEN boards)
    const getCurrentTurn = (): 'w' | 'b' => {
      // For FEN-based boards (no move history), use initialTurn as the base
      // For PGN-based boards, calculate from the move index
      let baseTurnIsWhite: boolean;
      
      if (moveHistory.length === 0) {
        // FEN-based board - use the turn specified in the FEN
        baseTurnIsWhite = initialTurn === 'w';
      } else {
        // PGN-based board - calculate from move index
        // currentMove = -1: starting position, white to move
        // currentMove = 0: after white's first move, black to move  
        // currentMove = 1: after black's first move, white to move
        baseTurnIsWhite = currentMove < 0 || currentMove % 2 === 1;
      }
      
      // Each manual move flips the turn
      const turnAfterManualMoves = (manualMoveCount % 2 === 0) ? baseTurnIsWhite : !baseTurnIsWhite;
      
      return turnAfterManualMoves ? 'w' : 'b';
    };

    // Load annotations for current move
    const loadAnnotations = () => {
      const saved = moveAnnotations[currentMove];
      if (saved) {
        arrows = saved.arrows.map(a => ({ from: [...a.from] as [number, number], to: [...a.to] as [number, number] }));
        highlightedSquares = new Set(saved.highlights);
      } else {
        arrows = [];
        highlightedSquares = new Set();
      }
    };

    // Save annotations for current move to memory (does NOT trigger file save)
    const saveAnnotationsToMemory = () => {
      moveAnnotations[currentMove] = {
        arrows: arrows.map(a => ({ from: [...a.from] as [number, number], to: [...a.to] as [number, number] })),
        highlights: new Set(highlightedSquares)
      };
    };

    // Save annotations for current move AND persist to file (triggers file save)
    const saveAnnotationsToFile = () => {
      saveAnnotationsToMemory();
      this.saveBoardAnnotations(boardId, moveAnnotations);
    };

    // Clear all annotations for current move (used by mobile clear button)
    const clearAnnotations = () => {
      arrows = [];
      highlightedSquares = new Set();
      saveAnnotationsToFile(); // This is an explicit user action, so save to file
      render();
    };

    // Save custom board state (for manual moves) to persist across re-renders
    const saveCustomBoardState = () => {
      this.customBoardCache.set(boardId, {
        board: currentBoard.map(row => [...row]), // Deep copy
        lastMove: lastMove ? { from: [...lastMove.from], to: [...lastMove.to] } : null,
        manualMoveCount,
        baseMove: currentMove
      });
    };
    
    // Clear custom board state (when navigating to a new position)
    const clearCustomBoardState = () => {
      this.customBoardCache.delete(boardId);
    };

    // Load annotations for initial position (move -1)
    loadAnnotations();

    // Engine functions
    const initEngine = () => {
      if (!this.settings.enableEngine || getEngineWorker()) return;
      
      try {
        setEngineLoading(true);
        
        // Use the stockfish.js from the plugin folder or CDN
        // Check if we can use the local stockfish, otherwise fall back to a basic eval
        let worker: Worker;
        try {
          const workerCode = `
            importScripts('https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js');
          `;
          const blob = new Blob([workerCode], { type: 'application/javascript' });
          worker = new Worker(URL.createObjectURL(blob));
        } catch (e) {
          // If CDN doesn't work, try creating worker differently
          worker = new Worker('https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js');
        }
        
        setEngineWorker(worker);
        
        worker.onmessage = (e) => {
          const line = e.data;
          
          // Parse UCI output
          if (typeof line === 'string') {
            // Parse depth and score from "info" lines
            if (line.startsWith('info') && line.includes('score')) {
              // IMPORTANT: Verify we're still analyzing the same position
              // If the current FEN has been cleared (navigation in progress), ignore this result
              const currentFen = getCurrentAnalysisFen();
              if (!currentFen) {
                // Analysis FEN was cleared, we're in transition - ignore this result
                return;
              }
              
              const depthMatch = line.match(/depth (\d+)/);
              const scoreMatch = line.match(/score (cp|mate) (-?\d+)/);
              const pvMatch = line.match(/pv ([a-h][1-8][a-h][1-8])/);

              let scoreChanged = false;
              let bestMoveChanged = false;

              if (depthMatch) {
                const newDepth = parseInt(depthMatch[1]);
                if (newDepth !== getEngineDepth()) {
                  setEngineDepth(newDepth);
                }
              }
              
              if (scoreMatch) {
                const scoreType = scoreMatch[1];
                let scoreValue = parseInt(scoreMatch[2]);
                
                // Engine returns score from side-to-move's perspective
                // We want it always from White's perspective
                // Use the cached analysisTurn (set when analysis started)
                if (getAnalysisTurn() === 'b') {
                  // It's Black's turn, so flip the score
                  scoreValue = -scoreValue;
                }
                
                let newEval: number;
                if (scoreType === 'cp') {
                  newEval = scoreValue;
                } else if (scoreType === 'mate') {
                  // Mate in X moves - represent as large value
                  newEval = scoreValue > 0 ? 10000 - Math.abs(parseInt(scoreMatch[2])) * 10 : -10000 + Math.abs(parseInt(scoreMatch[2])) * 10;
                } else {
                  newEval = getEngineEval() || 0;
                }
                
                // Only update if score changed significantly (more than 5 centipawns) or was null
                const currentEval = getEngineEval();
                if (currentEval === null || Math.abs(newEval - currentEval) > 5) {
                  setEngineEval(newEval);
                  scoreChanged = true;
                }
              }
              
              if (pvMatch) {
                const move = pvMatch[1];
                const from = this.algebraicToCoords(move.substring(0, 2));
                const to = this.algebraicToCoords(move.substring(2, 4));
                if (from && to) {
                  const currentBestMove = getEngineBestMove();
                  // Only update if best move actually changed
                  if (!currentBestMove || 
                      currentBestMove.from[0] !== from[0] || 
                      currentBestMove.from[1] !== from[1] ||
                      currentBestMove.to[0] !== to[0] || 
                      currentBestMove.to[1] !== to[1]) {
                    setEngineBestMove({ from, to });
                    bestMoveChanged = true;
                  }
                }
              }
              
              // Only update display when something meaningful changed
              if (scoreChanged) {
                updateEvalBar();
              }
              if (bestMoveChanged) {
                updateBestMoveArrow();
              }
            }
            
            // Engine is ready
            if (line === 'uciok') {
              setEngineLoading(false);
              getEngineWorker()?.postMessage('isready');
            }
            
            if (line === 'readyok') {
              // Engine is ready, analyze current position
              analyzePosition();
            }
          }
        };
        
        worker.onerror = (e) => {
          console.error('Stockfish worker error:', e);
          setEngineError('Failed to load engine');
          setEngineLoading(false);
          setEngineWorker(null);
        };
        
        // Initialize UCI
        worker.postMessage('uci');
        
      } catch (e) {
        console.error('Failed to initialize engine:', e);
        setEngineError('Engine not available');
        setEngineLoading(false);
      }
    };

    const analyzePosition = () => {
      const worker = getEngineWorker();
      if (!worker || !this.settings.enableEngine) return;
      
      // Get the current turn considering manual moves
      const turn = getCurrentTurn();
      
      const fen = this.boardToFEN(currentBoard, turn);
      
      // Don't re-analyze same position
      if (fen === getCurrentAnalysisFen()) return;
      setCurrentAnalysisFen(fen);
      
      // Store the turn for this analysis (used to interpret score correctly)
      setAnalysisTurn(turn);
      
      // Reset eval state and update display immediately to show "..."
      setEngineEval(null);
      setEngineBestMove(null);
      setEngineDepth(0);
      updateEvalBar();
      updateBestMoveArrow();
      
      // Stop any current analysis and start new one
      worker.postMessage('stop');
      worker.postMessage(`position fen ${fen}`);
      worker.postMessage(`go depth ${this.settings.engineDepth}`);
    };

    const updateEvalBar = () => {
      // Find the current container by boardId (not the captured reference which may be stale)
      const currentContainer = document.querySelector(`[data-board-id="${boardId}"]`) as HTMLElement;
      if (!currentContainer) return;

      const evalBar = currentContainer.querySelector('.chess-eval-bar-fill') as HTMLElement;
      const evalText = currentContainer.querySelector('.chess-eval-text') as HTMLElement;

      if (!evalBar || !evalText) return;
      
      const engineEval = getEngineEval();
      if (engineEval === null) {
        evalBar.setCssStyles({ height: '50%' });
        evalText.textContent = '...';
        return;
      }

      // Convert centipawns to percentage (sigmoid-like scaling)
      // At +/- 500cp, bar is at ~90%/10%
      const sigmoid = (x: number) => 1 / (1 + Math.exp(-x / 250));
      const percentage = sigmoid(engineEval) * 100;

      // The white portion fills from bottom
      evalBar.setCssStyles({ height: `${percentage}%` });
      
      // Format eval text
      let evalString: string;
      if (Math.abs(engineEval) >= 9000) {
        // Mate
        const mateIn = Math.ceil((10000 - Math.abs(engineEval)) / 10);
        evalString = engineEval > 0 ? `M${mateIn}` : `-M${mateIn}`;
      } else {
        const evalPawns = engineEval / 100;
        evalString = evalPawns >= 0 ? `+${evalPawns.toFixed(1)}` : evalPawns.toFixed(1);
      }
      
      evalText.textContent = evalString;
    };

    const updateBestMoveArrow = () => {
      // Find the current container by boardId (not the captured reference which may be stale)
      const currentContainer = document.querySelector(`[data-board-id="${boardId}"]`) as HTMLElement;
      if (!currentContainer) return;
      
      const svgOverlay = currentContainer.querySelector('.chess-svg-overlay') as SVGSVGElement;
      if (!svgOverlay) return;
      
      // Remove existing engine arrow
      const existingArrow = svgOverlay.querySelector('.chess-engine-arrow');
      if (existingArrow) {
        existingArrow.remove();
      }
      
      const engineBestMove = getEngineBestMove();
      if (!engineBestMove || !this.settings.enableEngine) return;
      
      // Note: We use the captured 'flipped' value. If the board was flipped after 
      // analysis started, the arrow might briefly be wrong until re-analysis completes.
      const fromRow = flipped ? 7 - engineBestMove.from[0] : engineBestMove.from[0];
      const fromCol = flipped ? 7 - engineBestMove.from[1] : engineBestMove.from[1];
      const toRow = flipped ? 7 - engineBestMove.to[0] : engineBestMove.to[0];
      const toCol = flipped ? 7 - engineBestMove.to[1] : engineBestMove.to[1];
      
      const x1 = (fromCol * 100) + 50;
      const y1 = (fromRow * 100) + 50;
      const x2 = (toCol * 100) + 50;
      const y2 = (toRow * 100) + 50;
      
      const arrowEl = this.createArrowElement(x1, y1, x2, y2, 'rgba(136, 97, 204, 0.9)', true);
      svgOverlay.appendChild(arrowEl);
    };

    const render = () => {
      // Clean up any orphaned drag clones from document.body
      const orphanedClones = document.querySelectorAll('body > .chess-piece-dragging');
      orphanedClones.forEach(clone => {
        clone.remove();
      });
      
      // Don't clear the entire container - preserve structure to reduce flickering
      const existingLayout = container.querySelector('.chess-layout');
      let layout: HTMLElement;
      let boardSection: HTMLElement;
      let infoSection: HTMLElement;
      let gameInfoSection: HTMLElement;
      let boardWrapper: HTMLElement | null = null;
      let boardContent: HTMLElement | null = null;
      let boardEl: HTMLElement | null = null;
      let svgOverlay: SVGSVGElement | null = null;
      let heightResizer: HTMLElement | null = null;

      if (!existingLayout) {
        // First render - create structure
        container.empty();
        
        // Set container height
        container.setCssStyles({
          height: `${totalHeight}px`,
          minHeight: `${totalHeight}px`
        });
        
        layout = container.createDiv({ cls: 'chess-layout' });
        
        boardSection = layout.createDiv({ cls: 'chess-board-section' });
        // Only set fixed width on desktop - mobile uses CSS 100% width
        if (window.innerWidth >= 1024) {
          boardSection.setCssStyles({ width: `${boardWidth}px` });
        }
        
        // Board resizer (between board and info sections)
        const boardResizer = layout.createDiv({ cls: 'chess-resizer chess-board-resizer' });
        let isResizingBoard = cachedResizeState?.isResizingBoard || false;
        let startX = cachedResizeState?.startX || 0;
        let startBoardWidth = cachedResizeState?.startBoardWidth || 0;
        let startInfoWidth = cachedResizeState?.startInfoWidth || 0;
        
        boardResizer.addEventListener('mousedown', (e) => {
          isResizingBoard = true;
          startX = e.clientX;
          startBoardWidth = boardSection.offsetWidth;
          startInfoWidth = infoSection?.offsetWidth || 0;
          document.body.setCssStyles({ cursor: 'ew-resize' });
          // Update cache to mark resize as active
          this.resizeStateCache.set(boardId, {
            boardWidth, infoWidth, totalHeight, moveListHeight,
            isResizingBoard: true,
            isResizingHeight: false,
            isResizingMovesNotes: false,
            startX, startBoardWidth, startInfoWidth
          });
          e.preventDefault();
        });
        
        const boardResizeMoveHandler = (e: MouseEvent) => {
          if (!isResizingBoard) return;
          const diff = e.clientX - startX;
          const newBoardWidth = Math.max(250, Math.min(1000, startBoardWidth + diff));
          boardWidth = newBoardWidth;
          boardSection.setCssStyles({ width: `${newBoardWidth}px` });
          
          // Update cache with current values during drag
          this.resizeStateCache.set(boardId, {
            boardWidth: newBoardWidth, infoWidth, totalHeight, moveListHeight,
            isResizingBoard: true,
            isResizingHeight: false,
            isResizingMovesNotes: false,
            startX, startBoardWidth, startInfoWidth
          });
          
          // Only update gameInfoSection width if it's visible
          if (gameInfoSection && gameInfoSection.style.display !== 'none') {
            gameInfoSection.setCssStyles({ width: `${newBoardWidth}px` });
          }

          // Force board wrapper to update without full render
          // Must match the calculation in render()
          const evalBarWidth = this.settings.enableEngine ? 20 : 0;
          const availableWidth = newBoardWidth - 32 - evalBarWidth;

          if (boardWrapper) {
            boardWrapper.setCssStyles({
              width: `${availableWidth}px`,
              height: `${availableWidth}px`,
              maxWidth: `${availableWidth}px`,
              maxHeight: `${availableWidth}px`
            });
          }
        };
        
        const boardResizeUpHandler = () => {
          if (isResizingBoard) {
            isResizingBoard = false;
            document.body.setCssStyles({ cursor: '' });
            // Clear the resize state cache since resize is complete
            this.resizeStateCache.delete(boardId);
            // Save move list scroll position to cache BEFORE saving sizes
            // This ensures the scroll position survives the re-render caused by file modification
            const moveList = container.querySelector('.chess-moves');
            if (moveList) {
              this.moveListScrollCache.set(boardId, moveList.scrollTop);
            }
            // Save size only on mouseup (not during drag)
            // Scroll preservation is handled by queueSaveBoardData
            this.saveBoardSizes(boardId, { boardWidth, infoWidth, totalHeight, moveListHeight });
          }
        };
        
        this.registerDocumentListener(boardId, 'mousemove', boardResizeMoveHandler as EventListener);
        this.registerDocumentListener(boardId, 'mouseup', boardResizeUpHandler as EventListener);
        
        // Info section (Current FEN + moves, notes) - fills remaining space
        infoSection = layout.createDiv({ cls: 'chess-info-section' });
        
        // Game info section (below board, same width as board)
        gameInfoSection = layout.createDiv({ cls: 'chess-board-info-section' });
        // Only set fixed width on desktop - mobile uses CSS 100% width
        if (window.innerWidth >= 1024) {
          gameInfoSection.setCssStyles({ width: `${boardWidth}px` });
        }
        
        // Add height resizer at the bottom of the entire container
        heightResizer = container.createDiv({ cls: 'chess-height-resizer' });
        let isResizingHeight = cachedResizeState?.isResizingHeight || false;
        let startY = cachedResizeState?.startY || 0;
        let startHeight = cachedResizeState?.startHeight || 0;
        
        heightResizer.addEventListener('mousedown', (e) => {
          isResizingHeight = true;
          startY = e.clientY;
          startHeight = container.offsetHeight;
          document.body.setCssStyles({ cursor: 'ns-resize' });
          // Update cache to mark resize as active
          this.resizeStateCache.set(boardId, {
            boardWidth, infoWidth, totalHeight, moveListHeight,
            isResizingBoard: false,
            isResizingHeight: true,
            isResizingMovesNotes: false,
            startY, startHeight
          });
          e.preventDefault();
        });
        
        const heightResizeMoveHandler = (e: MouseEvent) => {
          if (!isResizingHeight) return;
          const diff = e.clientY - startY;
          const newHeight = Math.max(300, Math.min(1200, startHeight + diff));
          totalHeight = newHeight;
          container.setCssStyles({
            height: `${newHeight}px`,
            minHeight: `${newHeight}px`
          });
          
          // Update cache with current values during drag
          this.resizeStateCache.set(boardId, {
            boardWidth, infoWidth, totalHeight: newHeight, moveListHeight,
            isResizingBoard: false,
            isResizingHeight: true,
            isResizingMovesNotes: false,
            startY, startHeight
          });
        };
        
        const heightResizeUpHandler = () => {
          if (isResizingHeight) {
            isResizingHeight = false;
            document.body.setCssStyles({ cursor: '' });
            // Clear the resize state cache since resize is complete
            this.resizeStateCache.delete(boardId);
            // Save move list scroll position to cache BEFORE saving sizes
            // This ensures the scroll position survives the re-render caused by file modification
            const moveList = container.querySelector('.chess-moves');
            if (moveList) {
              this.moveListScrollCache.set(boardId, moveList.scrollTop);
            }
            // Save size only on mouseup
            // Scroll preservation is handled by queueSaveBoardData
            this.saveBoardSizes(boardId, { boardWidth, infoWidth, totalHeight, moveListHeight });
          }
        };
        
        this.registerDocumentListener(boardId, 'mousemove', heightResizeMoveHandler as EventListener);
        this.registerDocumentListener(boardId, 'mouseup', heightResizeUpHandler as EventListener);
      } else {
        // Subsequent renders - reuse structure
        layout = existingLayout as HTMLElement;
        boardSection = layout.querySelector('.chess-board-section') as HTMLElement;
        gameInfoSection = layout.querySelector('.chess-board-info-section') as HTMLElement;
        infoSection = layout.querySelector('.chess-info-section') as HTMLElement;
        heightResizer = container.querySelector('.chess-height-resizer');
        
        // Try to preserve board elements - now inside boardContent
        boardContent = boardSection.querySelector('.chess-board-content') as HTMLElement;
        if (boardContent) {
          boardWrapper = boardContent.querySelector('.chess-board-wrapper');
          if (boardWrapper) {
            boardEl = boardWrapper.querySelector('.chess-board');
            svgOverlay = boardWrapper.querySelector('.chess-svg-overlay');
          }
        }
        
        // Clear header and controls by removing them (we'll recreate them)
        const existingHeader = boardSection.querySelector('.chess-header');
        if (existingHeader) existingHeader.remove();
        const existingControls = boardSection.querySelector('.chess-controls');
        if (existingControls) existingControls.remove();
        
        // Clear info sections content
        if (gameInfoSection) gameInfoSection.empty();
        if (infoSection) infoSection.empty();
      }

      // Board header with flip button - create at beginning of boardSection
      const header = document.createElement('div');
      header.className = 'chess-header';
      // Insert as first child
      if (boardSection.firstChild) {
        boardSection.insertBefore(header, boardSection.firstChild);
      } else {
        boardSection.appendChild(header);
      }
      
      const title = document.createElement('h3');
      title.className = 'chess-title';
      title.textContent = 'Chess Plugin';
      header.appendChild(title);
      
      const controls = document.createElement('div');
      controls.className = 'chess-header-controls';
      header.appendChild(controls);
      
      // Add clear annotations button for mobile (only shown when annotations exist)
      if (isMobileDevice() && (arrows.length > 0 || highlightedSquares.size > 0)) {
        const clearBtn = document.createElement('button');
        clearBtn.className = 'chess-clear-annotations-btn';
        clearBtn.textContent = 'Clear';
        clearBtn.title = 'Clear annotations';
        clearBtn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          clearAnnotations();
        };
        controls.appendChild(clearBtn);
      }
      
      const flipBtn = document.createElement('button');
      flipBtn.className = 'chess-flip-btn';
      flipBtn.textContent = '↻';
      flipBtn.title = 'Flip board';
      flipBtn.onclick = () => {
        saveAnnotationsToMemory(); // Save current annotations to memory before flipping
        flipped = !flipped;
        // Save flipped state to cache so it persists across re-renders
        this.flippedCache.set(boardId, flipped);
        // Also save to board data for persistence across sessions
        this.saveBoardFlipped(boardId, flipped);
        // Force board recreation by removing it
        if (boardWrapper) {
          const existingBoard = boardWrapper.querySelector('.chess-board');
          if (existingBoard) existingBoard.remove();
          boardEl = null;
        }
        render();
        // Re-draw best move arrow with updated flipped state
        updateBestMoveArrow();
      };
      controls.appendChild(flipBtn);
      
      // Reset button - clears custom moves but stays on current PGN move
      const resetBtn = document.createElement('button');
      resetBtn.className = 'chess-reset-btn';
      resetBtn.textContent = '⟲';
      resetBtn.title = 'Clear custom moves (return to current PGN/FEN position)';
      resetBtn.onclick = () => {
        saveAnnotationsToMemory(); // Save current annotations to memory before reset
        
        // Clear any custom board state (manual moves)
        clearCustomBoardState();
        manualMoveCount = 0;
        
        if (moveHistory.length > 0) {
          // PGN-based board - rebuild board to current move position (clearing any manual moves)
          let newBoard = this.getInitialBoard();
          let moveSquares = null;
          
          for (let i = 0; i <= currentMove; i++) {
            const result = this.applyMove(newBoard, moveHistory[i], i === currentMove, moveHistory, i);
            newBoard = result.board;
            if (i === currentMove) moveSquares = result.moveSquares;
          }
          
          currentBoard = newBoard;
          lastMove = currentMove >= 0 ? moveSquares : null;
        } else {
          // FEN-based board - restore original FEN position
          currentBoard = board.map(row => [...row]); // Deep copy of original board
          lastMove = null;
        }
        
        // Clear engine state to force re-analysis
        setCurrentAnalysisFen('');
        setEngineBestMove(null);
        setEngineEval(null);
        setEngineDepth(0);
        
        render();
        
        // Trigger engine analysis for reset position
        if (this.settings.enableEngine) {
          analyzePosition();
        }
      };
      controls.appendChild(resetBtn);

      // Navigation controls - put ABOVE the board
      const navigateToMove = (idx: number, forceScroll: boolean = false, skipAnimation: boolean = false) => {
        if (idx < -1 || idx >= moveHistory.length) return;
        
        // Save current move annotations to memory before navigating (no file save)
        saveAnnotationsToMemory();
        
        const previousMove = currentMove;
        let newBoard = this.getInitialBoard();
        let moveSquares = null;
        
        for (let i = 0; i <= idx; i++) {
          const result = this.applyMove(newBoard, moveHistory[i], i === idx, moveHistory, i);
          newBoard = result.board;
          if (i === idx) moveSquares = result.moveSquares;
        }
        
        // Check if we should animate (single step forward, not manual, animation enabled)
        const shouldAnimate = !skipAnimation && 
          !isManualMove && 
          this.settings.animationDuration > 0 &&
          idx === previousMove + 1 && 
          moveSquares && 
          boardEl;
        
        if (shouldAnimate && moveSquares && boardEl) {
          // Animate the piece movement
          this.animatePieceMove(
            boardEl,
            moveSquares.from[0], moveSquares.from[1],
            moveSquares.to[0], moveSquares.to[1],
            flipped,
            this.settings.animationDuration,
            () => {
              // After animation completes, update board state
              finishNavigation(idx, newBoard, moveSquares, forceScroll);
            }
          );
        } else {
          finishNavigation(idx, newBoard, moveSquares, forceScroll);
        }
      };
      
      const finishNavigation = (
        idx: number, 
        newBoard: (string | null)[][], 
        moveSquares: { from: number[], to: number[] } | null,
        forceScroll: boolean
      ) => {
        currentBoard = newBoard;
        currentMove = idx;
        
        // Update in-memory cache (doesn't trigger file save/re-render)
        this.currentMoveCache.set(boardId, currentMove);
        
        // Clear any custom board state since we're navigating to a PGN position
        clearCustomBoardState();
        
        // IMPORTANT: Clear cached analysis FEN to force re-analysis
        // This prevents showing stale engine suggestions when navigating
        setCurrentAnalysisFen('');
        // Also clear the best move and eval to prevent showing stale data
        setEngineBestMove(null);
        setEngineEval(null);
        setEngineDepth(0);
        
        lastMove = moveSquares;
        selectedSquare = null;
        legalMoves = [];
        isManualMove = false; // Reset manual move flag
        manualMoveCount = 0; // Reset manual move count when navigating to a game position
        
        // Update clocks based on timestamp
        // timestamps[0] is initial position (move -1)
        // timestamps[1] is after move 0 (White's first move), etc.
        // When at move index i, we want timestamps[i+1] because that's after move i was played
        if (timestamps.length > 0) {
          const timestampIndex = idx + 1;
          if (timestampIndex >= 0 && timestampIndex < timestamps.length) {
            const moveTime = timestamps[timestampIndex];
            whiteTime = this.parseClockTime(moveTime.white);
            blackTime = this.parseClockTime(moveTime.black);
          } else if (timestampIndex >= timestamps.length && timestamps.length > 0) {
            // Use last available timestamp
            const moveTime = timestamps[timestamps.length - 1];
            whiteTime = this.parseClockTime(moveTime.white);
            blackTime = this.parseClockTime(moveTime.black);
          } else if (idx === -1 && timestamps.length > 0) {
            // At starting position, use initial clocks
            const moveTime = timestamps[0];
            whiteTime = this.parseClockTime(moveTime.white);
            blackTime = this.parseClockTime(moveTime.black);
          }
        }
        
        // Load annotations for new move
        loadAnnotations();
        
        // CRITICAL: Get scroll position BEFORE render destroys the DOM
        const moveListEl = container.querySelector('.chess-moves') as HTMLElement;
        const scrollPosBefore = moveListEl ? moveListEl.scrollTop : 0;
        
        render();
        
        // Trigger engine analysis for new position
        if (this.settings.enableEngine) {
          analyzePosition();
        }
        
        // CRITICAL: Handle scroll AFTER render using requestAnimationFrame to avoid layout thrashing
        // Use preventScroll techniques to ensure we don't affect the main Obsidian scroll
        requestAnimationFrame(() => {
          const newMoveList = container.querySelector('.chess-moves') as HTMLElement;
          if (newMoveList) {
            // Temporarily prevent scroll events from bubbling
            const preventParentScroll = (e: Event) => e.stopPropagation();
            newMoveList.addEventListener('scroll', preventParentScroll, { capture: true });
            
            // Find the active move element
            const activeMove = newMoveList.querySelector('.chess-move-item.active') as HTMLElement;
            
            if (activeMove) {
              const activeTop = activeMove.offsetTop;
              const activeHeight = activeMove.offsetHeight;
              const listHeight = newMoveList.clientHeight;
              
              if (forceScroll) {
                // Force scroll based on position
                if (idx === -1) {
                  // Start position: scroll to top
                  newMoveList.scrollTop = 0;
                } else if (idx >= moveHistory.length - 1) {
                  // Last move: scroll to bottom
                  newMoveList.scrollTop = newMoveList.scrollHeight;
                } else {
                  // Other: center the active move
                  newMoveList.scrollTop = Math.max(0, activeTop - (listHeight / 2) + (activeHeight / 2));
                }
              } else {
                // Not forcing scroll: try to restore previous position first
                newMoveList.scrollTop = scrollPosBefore;
                
                // Check if active move is visible after restoring scroll
                const scrollTop = newMoveList.scrollTop;
                const isAboveView = activeTop < scrollTop;
                const isBelowView = (activeTop + activeHeight) > (scrollTop + listHeight);
                
                if (isAboveView) {
                  // Active move is above visible area, scroll up to show it with some padding at top
                  newMoveList.scrollTop = Math.max(0, activeTop - 8);
                } else if (isBelowView) {
                  // Active move is below visible area, scroll down to show it with some padding at bottom
                  newMoveList.scrollTop = activeTop - listHeight + activeHeight + 8;
                }
                // If visible, keep the restored scroll position
              }
            } else {
              // No active move found (shouldn't happen), just restore scroll
              newMoveList.scrollTop = scrollPosBefore;
            }
            
            // Remove the temporary scroll listener after a frame
            requestAnimationFrame(() => {
              newMoveList.removeEventListener('scroll', preventParentScroll, { capture: true });
            });
          }
        });
      };

      if (moveHistory.length > 0) {
        const navControls = document.createElement('div');
        navControls.className = 'chess-controls';
        
        // Insert after header - find the header and insert after it
        const headerEl = boardSection.querySelector('.chess-header');
        if (headerEl && headerEl.nextSibling) {
          boardSection.insertBefore(navControls, headerEl.nextSibling);
        } else if (headerEl) {
          boardSection.appendChild(navControls);
        }
        
        const createBtn = (text: string, onClick: () => void, disabled: boolean) => {
          const btn = document.createElement('button');
          btn.className = 'chess-control-btn';
          btn.textContent = text;
          btn.disabled = disabled;
          btn.onclick = onClick;
          navControls.appendChild(btn);
          return btn;
        };

        createBtn('⏮', () => navigateToMove(-1, true, true), currentMove === -1);
        createBtn('◀', () => navigateToMove(currentMove - 1), currentMove === -1);
        
        const moveCounter = document.createElement('span');
        moveCounter.className = 'chess-move-counter';
        moveCounter.textContent = `Move ${currentMove + 1} / ${moveHistory.length}`;
        navControls.appendChild(moveCounter);
        
        createBtn('▶', () => navigateToMove(currentMove + 1), currentMove >= moveHistory.length - 1);
        createBtn('⏭', () => navigateToMove(moveHistory.length - 1, true, true), currentMove >= moveHistory.length - 1);
      }

      // Create or reuse board content container (holds eval bar + board)
      if (!boardContent) {
        boardContent = boardSection.querySelector('.chess-board-content') as HTMLElement;
      }
      if (!boardContent) {
        boardContent = document.createElement('div');
        boardContent.className = 'chess-board-content';
        boardSection.appendChild(boardContent);
      }

      // Create eval bar container if engine is enabled
      let evalBarContainer = boardContent.querySelector('.chess-eval-bar-container') as HTMLElement;
      if (this.settings.enableEngine && !evalBarContainer) {
        evalBarContainer = document.createElement('div');
        evalBarContainer.className = 'chess-eval-bar-container';
        const evalBar = document.createElement('div');
        evalBar.className = 'chess-eval-bar';
        const evalBarFill = document.createElement('div');
        evalBarFill.className = 'chess-eval-bar-fill';
        evalBar.appendChild(evalBarFill);
        evalBarContainer.appendChild(evalBar);
        const evalText = document.createElement('div');
        evalText.className = 'chess-eval-text';
        evalText.textContent = '...';
        evalBarContainer.appendChild(evalText);
        
        // Insert at beginning of board content
        boardContent.insertBefore(evalBarContainer, boardContent.firstChild);
      } else if (!this.settings.enableEngine && evalBarContainer) {
        evalBarContainer.remove();
      }

      // Board wrapper - create only if it doesn't exist
      if (!boardWrapper) {
        boardWrapper = boardContent.querySelector('.chess-board-wrapper') as HTMLElement;
      }
      if (!boardWrapper) {
        boardWrapper = document.createElement('div');
        boardWrapper.className = 'chess-board-wrapper';
        boardContent.appendChild(boardWrapper);
      }
      
      // Set wrapper to scale based on section width
      // Use the stored boardWidth on desktop, or actual offsetWidth on mobile for responsive sizing
      const isMobile = window.innerWidth < 1024;
      const sectionWidth = isMobile ? boardSection.offsetWidth : boardWidth;
      const evalBarWidth = this.settings.enableEngine ? 20 : 0; // 14px bar + 6px gap
      const padding = 32; // Account for padding (1rem * 2)
      const availableWidth = Math.max(200, sectionWidth - padding - evalBarWidth);
      
      boardWrapper.setCssStyles({
        width: `${availableWidth}px`,
        height: `${availableWidth}px`,
        maxWidth: `${availableWidth}px`,
        maxHeight: `${availableWidth}px`
      });
      
      // Calculate piece size based on wrapper size
      const squareSize = availableWidth / 8;
      const pieceSize = Math.floor(squareSize * 0.8); // 80% of square size
      
      // Create board and SVG if they don't exist
      if (!boardEl) {
        boardEl = document.createElement('div');
        boardEl.className = 'chess-board';
        boardWrapper.appendChild(boardEl);
      }
      if (!svgOverlay) {
        svgOverlay = this.createSvgOverlay(boardWrapper);
      }
      
      // Check for check/checkmate - use getCurrentTurn to account for manual moves
      const currentTurn = getCurrentTurn();
      const turnColor = currentTurn === 'w' ? 'white' : 'black';
      isInCheck = this.isKingInCheck(currentBoard, turnColor);
      isCheckmate = isInCheck && this.isCheckmate(currentBoard, turnColor);

      // Render the board - update existing or create new
      if (boardEl && svgOverlay) {
        this.updateBoard(currentBoard, boardEl, svgOverlay, flipped, lastMove, selectedSquare, arrows, highlightedSquares, legalMoves, isInCheck, isCheckmate, turnColor, adapter, pluginPath, pieceSize, 
        (row, col) => {
          if (draggedPiece) return;
          
          const piece = currentBoard[row][col];
          const hadAnnotations = arrows.length > 0 || highlightedSquares.size > 0;
          
          // Allow interaction at any position for player exploration
          // Moves made during exploration are not persisted
          const canInteract = true;
          
          // If clicking on a legal move square (empty OR with opponent piece), make the move
          if (canInteract && selectedSquare && legalMoves.some(([r, c]) => r === row && c === col)) {
            const [selRow, selCol] = selectedSquare;
            const newBoard = currentBoard.map(r => [...r]);
            
            // Check for castling
            const movingPiece = newBoard[selRow][selCol];
            if (movingPiece && movingPiece.toLowerCase() === 'k' && Math.abs(col - selCol) === 2) {
              const rookCol = col > selCol ? 7 : 0;
              const newRookCol = col > selCol ? col - 1 : col + 1;
              newBoard[row][newRookCol] = newBoard[row][rookCol];
              newBoard[row][rookCol] = null;
            }
            
            newBoard[row][col] = newBoard[selRow][selCol];
            newBoard[selRow][selCol] = null;
            currentBoard = newBoard;
            lastMove = { from: [selRow, selCol], to: [row, col] };
            selectedSquare = null;
            legalMoves = [];
            isManualMove = true; // Mark as manual move - no animation, no scroll
            manualMoveCount++; // Increment manual move count for turn tracking
            
            // Save custom board state so it persists across re-renders
            saveCustomBoardState();
            
            // IMPORTANT: Clear cached analysis FEN to force re-analysis
            setCurrentAnalysisFen('');
            // Also clear the best move and eval to prevent showing stale data
            setEngineBestMove(null);
            setEngineEval(null);
            setEngineDepth(0);
            
            // Clear annotations when making a move - but NOT on mobile (use clear button instead)
            if (hadAnnotations && !isMobileDevice()) {
              arrows = [];
              highlightedSquares = new Set();
              saveAnnotationsToFile(); // User made a move, persist the cleared annotations
            }
            
            // Save scroll position before render
            const moveListEl = container.querySelector('.chess-moves');
            const savedScrollPos = moveListEl ? moveListEl.scrollTop : 0;
            
            render();
            
            // Restore scroll position after render for manual moves
            requestAnimationFrame(() => {
              const newMoveListEl = container.querySelector('.chess-moves');
              if (newMoveListEl) {
                newMoveListEl.scrollTop = savedScrollPos;
              }
            });
            
            // Trigger engine analysis for new position
            if (this.settings.enableEngine) {
              analyzePosition();
            }
            return;
          }
          
          // Clicking on own piece - select it (don't clear annotations)
          // Only select if it's NOT a legal move target (i.e., not capturing)
          if (piece && canInteract) {
            // Check if this is our own piece (not an opponent's piece we could capture)
            const isSelectedPieceWhite = selectedSquare ? 
              (currentBoard[selectedSquare[0]][selectedSquare[1]]?.toUpperCase() === currentBoard[selectedSquare[0]][selectedSquare[1]]) : false;
            const isClickedPieceWhite = piece.toUpperCase() === piece;
            
            // If we have a selection and clicked piece is same color, switch selection
            // If no selection or clicked piece is same color as what would move, select it
            if (!selectedSquare || isSelectedPieceWhite === isClickedPieceWhite) {
              selectedSquare = [row, col];
              legalMoves = this.getLegalMoves(currentBoard, row, col);
              render();
              return;
            }
          }
          
          // Clicking on empty square (not a legal move)
          if (!piece) {
            // On mobile, don't clear annotations when clicking empty squares - use clear button
            if (hadAnnotations && !isMobileDevice()) {
              const moveList = container.querySelector('.chess-moves');
              const scrollPos = moveList ? moveList.scrollTop : 0;
              
              arrows = [];
              highlightedSquares = new Set();
              saveAnnotationsToFile(); // User clicked to clear, persist it
              render();
              
              requestAnimationFrame(() => {
                const newMoveList = container.querySelector('.chess-moves');
                if (newMoveList) {
                  newMoveList.scrollTop = scrollPos;
                }
              });
              return;
            }
            
            // Deselect any selected piece
            if (selectedSquare) {
              selectedSquare = null;
              legalMoves = [];
              render();
            }
            return;
          }
          
          // Clicked on opponent piece but not a legal capture - deselect
          if (selectedSquare) {
            selectedSquare = null;
            legalMoves = [];
            render();
          }
        },
        (row, col, piece, pieceEl, mouseX, mouseY) => {
          // Allow dragging at any position for player exploration
          
          // Clean up any existing drag state first
          if (draggedPiece) {
            if (draggedPiece.element && draggedPiece.element.parentNode) {
              draggedPiece.element.remove();
            }
            if (draggedPiece.originalElement) {
              draggedPiece.originalElement.setCssStyles({ opacity: '' });
            }
            draggedPiece = null;
          }
          
          selectedSquare = [row, col];
          legalMoves = this.getLegalMoves(currentBoard, row, col);
          
          // Get the ACTUAL rendered size from the piece element's parent (the square)
          // This ensures correct size even on first render when squareSize might be stale
          const squareEl = pieceEl.parentElement;
          const actualSquareSize = squareEl ? squareEl.getBoundingClientRect().width : squareSize;
          
          // Clone the piece for dragging
          const dragClone = document.createElement('div');
          dragClone.className = 'chess-piece chess-piece-dragging';

          // Copy the background image style from the original piece
          const computedStyle = window.getComputedStyle(pieceEl);

          // Position the clone CENTERED on the cursor immediately
          const halfSize = actualSquareSize / 2;

          dragClone.setCssStyles({
            position: 'fixed',
            pointerEvents: 'none',
            zIndex: '10000',
            width: `${actualSquareSize}px`,
            height: `${actualSquareSize}px`,
            opacity: '1',
            backgroundImage: computedStyle.backgroundImage,
            backgroundSize: computedStyle.backgroundSize || '80%',
            backgroundPosition: computedStyle.backgroundPosition || 'center',
            backgroundRepeat: computedStyle.backgroundRepeat || 'no-repeat',
            left: `${mouseX - halfSize}px`,
            top: `${mouseY - halfSize}px`
          });
          
          document.body.appendChild(dragClone);
          
          // Store drag state with reference to BOTH the clone and original
          draggedPiece = { 
            piece, 
            fromRow: row, 
            fromCol: col, 
            element: dragClone,
            originalElement: pieceEl
          };
          
          // Hide original piece
          pieceEl.setCssStyles({ opacity: '0.3' });
          
          // Update square classes directly without full render (to show legal moves and selection)
          if (boardEl) {
            for (let r = 0; r < 8; r++) {
              for (let c = 0; c < 8; c++) {
                const actualR = flipped ? 7 - r : r;
                const actualC = flipped ? 7 - c : c;
                const squareIdx = r * 8 + c;
                const square = boardEl.children[squareIdx] as HTMLElement;
                if (square) {
                  // Add/remove selected class
                  if (selectedSquare && selectedSquare[0] === actualR && selectedSquare[1] === actualC) {
                    square.classList.add('selected');
                  } else {
                    square.classList.remove('selected');
                  }
                  // Add/remove legal-move class
                  const isLegalMove = legalMoves.some(([mr, mc]) => mr === actualR && mc === actualC);
                  if (isLegalMove) {
                    square.classList.add('legal-move');
                  } else {
                    square.classList.remove('legal-move');
                  }
                }
              }
            }
          }
        },
        (row, col) => {
          // onDragEnd - called when piece is dropped on a square
          if (draggedPiece) {
            const { fromRow, fromCol, element, originalElement } = draggedPiece;
            
            // Remove the drag clone
            if (element && element.parentNode) {
              element.remove();
            }
            
            // Restore original piece opacity using stored reference
            if (originalElement) {
              originalElement.setCssStyles({ opacity: '' });
            }
            
            if (this.isLegalMove(currentBoard, fromRow, fromCol, row, col)) {
              const newBoard = currentBoard.map(r => [...r]);
              
              // Check for castling
              const movingPiece = newBoard[fromRow][fromCol];
              if (movingPiece && movingPiece.toLowerCase() === 'k' && Math.abs(col - fromCol) === 2) {
                // This is a castling move
                const rookCol = col > fromCol ? 7 : 0;
                const newRookCol = col > fromCol ? col - 1 : col + 1;
                newBoard[row][newRookCol] = newBoard[row][rookCol];
                newBoard[row][rookCol] = null;
              }
              
              newBoard[row][col] = newBoard[fromRow][fromCol];
              newBoard[fromRow][fromCol] = null;
              currentBoard = newBoard;
              lastMove = { from: [fromRow, fromCol], to: [row, col] };
              isManualMove = true; // Mark as manual move - no animation, no scroll
              manualMoveCount++; // Increment manual move count for turn tracking
              
              // Save custom board state so it persists across re-renders
              saveCustomBoardState();
              
              // IMPORTANT: Clear cached analysis FEN to force re-analysis
              setCurrentAnalysisFen('');
              // Also clear the best move and eval to prevent showing stale data
              setEngineBestMove(null);
              setEngineEval(null);
              setEngineDepth(0);
            }
            
            // Save scroll position before render
            const moveListEl = container.querySelector('.chess-moves');
            const savedScrollPos = moveListEl ? moveListEl.scrollTop : 0;
            
            draggedPiece = null;
            selectedSquare = null;
            legalMoves = [];
            render();
            
            // Restore scroll position after render for manual moves
            requestAnimationFrame(() => {
              const newMoveListEl = container.querySelector('.chess-moves');
              if (newMoveListEl) {
                newMoveListEl.scrollTop = savedScrollPos;
              }
            });
            
            // Trigger engine analysis for new position
            if (this.settings.enableEngine) {
              analyzePosition();
            }
          }
        },
        () => {
          // onDragCancel - called when drag ends without a valid drop
          if (draggedPiece) {
            const { element, originalElement } = draggedPiece;
            
            // Remove the drag clone
            if (element && element.parentNode) {
              element.remove();
            }
            
            // Restore original piece opacity using stored reference
            if (originalElement) {
              originalElement.setCssStyles({ opacity: '' });
            }
            
            draggedPiece = null;
            selectedSquare = null;
            legalMoves = [];
            render();
          }
        },
        (fromRow, fromCol, toRow, toCol, isRightClickDrag) => {
          // Store scroll position
          const moveList = container.querySelector('.chess-moves');
          const scrollPos = moveList ? moveList.scrollTop : 0;
          
          if (isRightClickDrag) {
            // Don't create arrow if start and end are the same square
            if (fromRow === toRow && fromCol === toCol) {
              return;
            }
            
            // Right-click drag creates arrow
            const existingIndex = arrows.findIndex(a => 
              a.from[0] === fromRow && a.from[1] === fromCol && 
              a.to[0] === toRow && a.to[1] === toCol
            );
            
            if (existingIndex >= 0) {
              arrows.splice(existingIndex, 1);
            } else {
              arrows.push({ from: [fromRow, fromCol], to: [toRow, toCol] });
            }
          } else {
            // Single right-click toggles square highlight
            const key = `${fromRow}-${fromCol}`;
            if (highlightedSquares.has(key)) {
              highlightedSquares.delete(key);
            } else {
              highlightedSquares.add(key);
            }
          }
          saveAnnotationsToFile(); // User drew annotation, persist it
          
          // Re-render board elements without full render
          if (boardEl && svgOverlay) {
            while (svgOverlay.firstChild) {
              svgOverlay.removeChild(svgOverlay.firstChild);
            }
            
            arrows.forEach(arrow => {
              const arrowFromRow = flipped ? 7 - arrow.from[0] : arrow.from[0];
              const arrowFromCol = flipped ? 7 - arrow.from[1] : arrow.from[1];
              const arrowToRow = flipped ? 7 - arrow.to[0] : arrow.to[0];
              const arrowToCol = flipped ? 7 - arrow.to[1] : arrow.to[1];
              
              const x1 = (arrowFromCol * 100) + 50;
              const y1 = (arrowFromRow * 100) + 50;
              const x2 = (arrowToCol * 100) + 50;
              const y2 = (arrowToRow * 100) + 50;

              const arrowEl = this.createArrowElement(x1, y1, x2, y2, 'rgba(241, 190, 60, 0.9)');
              svgOverlay.appendChild(arrowEl);
            });
            
            // Update square highlights
            for (let rowIdx = 0; rowIdx < 8; rowIdx++) {
              for (let colIdx = 0; colIdx < 8; colIdx++) {
                const actualRow = flipped ? 7 - rowIdx : rowIdx;
                const actualCol = flipped ? 7 - colIdx : colIdx;
                const squareIdx = rowIdx * 8 + colIdx;
                const square = boardEl.children[squareIdx] as HTMLElement;
                
                if (square) {
                  const isLight = (actualRow + actualCol) % 2 === 0;
                  let squareClass = `chess-square ${isLight ? 'light' : 'dark'}`;
                  
                  if (lastMove && lastMove.from[0] === actualRow && lastMove.from[1] === actualCol) {
                    squareClass += ' move-from';
                  }
                  if (lastMove && lastMove.to[0] === actualRow && lastMove.to[1] === actualCol) {
                    squareClass += ' move-to';
                  }
                  
                  const squareKey = `${actualRow}-${actualCol}`;
                  if (highlightedSquares.has(squareKey)) {
                    squareClass += ' highlighted';
                  }
                  
                  if (selectedSquare && selectedSquare[0] === actualRow && selectedSquare[1] === actualCol) {
                    squareClass += ' selected';
                  }
                  
                  const isLegalMove = legalMoves.some(([r, c]) => r === actualRow && c === actualCol);
                  if (isLegalMove) {
                    squareClass += ' legal-move';
                  }
                  
                  square.className = squareClass;
                }
              }
            }
            
            // Redraw engine best move arrow after annotation arrows
            updateBestMoveArrow();
          }
          
          // Restore scroll position
          requestAnimationFrame(() => {
            const newMoveList = container.querySelector('.chess-moves');
            if (newMoveList) {
              newMoveList.scrollTop = scrollPos;
            }
          });
        }
      );
      }

      // Display player clocks only if timestamps exist (which now only happens when PGN has clock data)
      if (timestamps.length > 0) {
        // Check if clocks already exist, if so update them
        let clocksDiv = boardSection.querySelector('.chess-clocks') as HTMLElement;
        
        if (!clocksDiv) {
          // First render - create the clocks structure
          clocksDiv = boardSection.createDiv({ cls: 'chess-clocks' });
          
          const whiteClockDiv = clocksDiv.createDiv({ cls: 'chess-clock chess-clock-white' });
          whiteClockDiv.createEl('div', { cls: 'chess-clock-name' });
          whiteClockDiv.createEl('div', { cls: 'chess-clock-time' });
          whiteClockDiv.createEl('div', { cls: 'chess-clock-elo' });
          
          const blackClockDiv = clocksDiv.createDiv({ cls: 'chess-clock chess-clock-black' });
          blackClockDiv.createEl('div', { cls: 'chess-clock-name' });
          blackClockDiv.createEl('div', { cls: 'chess-clock-time' });
          blackClockDiv.createEl('div', { cls: 'chess-clock-elo' });
        }
        
        // Update clock values
        const whiteClockDiv = clocksDiv.querySelector('.chess-clock-white') as HTMLElement;
        const blackClockDiv = clocksDiv.querySelector('.chess-clock-black') as HTMLElement;
        
        // Update white clock
        // At move -1 (start), it's white's turn (white is active)
        // At move 0 (after white's first move), it's black's turn (black is active)
        // At move 1 (after black's first move), it's white's turn (white is active)
        // So: white is active when currentMove is -1, 1, 3, 5... (odd or -1)
        // black is active when currentMove is 0, 2, 4, 6... (even and >= 0)
        const isWhiteTurn = currentMove === -1 || currentMove % 2 === 1;
        const isBlackTurn = currentMove >= 0 && currentMove % 2 === 0;
        
        whiteClockDiv.className = `chess-clock chess-clock-white${isWhiteTurn ? ' active' : ''}`;
        (whiteClockDiv.querySelector('.chess-clock-name') as HTMLElement).textContent = whiteName || 'White';
        (whiteClockDiv.querySelector('.chess-clock-time') as HTMLElement).textContent = this.formatTime(whiteTime);
        const whiteEloEl = whiteClockDiv.querySelector('.chess-clock-elo') as HTMLElement;
        whiteEloEl.textContent = whiteElo ? `(${whiteElo})` : '';
        whiteEloEl.setCssStyles({ display: whiteElo ? 'block' : 'none' });
        
        // Update black clock
        blackClockDiv.className = `chess-clock chess-clock-black${isBlackTurn ? ' active' : ''}`;
        (blackClockDiv.querySelector('.chess-clock-name') as HTMLElement).textContent = blackName || 'Black';
        (blackClockDiv.querySelector('.chess-clock-time') as HTMLElement).textContent = this.formatTime(blackTime);
        const blackEloEl = blackClockDiv.querySelector('.chess-clock-elo') as HTMLElement;
        blackEloEl.textContent = blackElo ? `(${blackElo})` : '';
        blackEloEl.setCssStyles({ display: blackElo ? 'block' : 'none' });
      }

      // Current FEN section - NOW IN INFO SECTION (swapped with Game Info)
      const fenSection = infoSection.createDiv({ cls: 'chess-fen' });
      const fenHeader = fenSection.createDiv({ cls: 'chess-section-header' });
      fenHeader.createEl('h4', { text: 'Current FEN' });
      
      const copyBtn = fenHeader.createEl('button', { text: 'Copy', cls: 'chess-copy-fen-btn' });
      // Use getCurrentTurn() to properly handle FEN-based boards and manual moves
      const fenTurn = getCurrentTurn();
      const fenString = this.boardToFEN(currentBoard, fenTurn);
      copyBtn.onclick = async () => {
        await navigator.clipboard.writeText(fenString);
        copyBtn.textContent = 'Copied';
        setTimeout(() => {
          copyBtn.textContent = 'Copy';
        }, 2000);
      };
      
      fenSection.createEl('code', { text: fenString });

      // Move list in 2-column format
      if (moveHistory.length > 0) {
        const moveList = infoSection.createDiv({ cls: 'chess-move-list' });
        moveList.setCssStyles({ height: `${moveListHeight}px` });
        // Note: min/max heights are handled by CSS to allow proper flex shrinking
        
        const moveHeader = moveList.createDiv({ cls: 'chess-section-header' });
        moveHeader.createEl('h4', { text: 'Moves' });
        
        const list = moveList.createDiv({ cls: 'chess-moves' });
        
        // Restore cached scroll position after list is populated
        // We'll do this after all moves are added, using requestAnimationFrame
        const cachedScrollPos = this.moveListScrollCache.get(boardId);
        
        // Add scroll listener to track position for preservation
        list.addEventListener('scroll', () => {
          this.moveListScrollCache.set(boardId, list.scrollTop);
        });
        
        // Add starting position row - check for annotations at move index -1
        const startHasAnnotations = !!(moveAnnotations[-1] && 
          ((moveAnnotations[-1].arrows && moveAnnotations[-1].arrows.length > 0) || 
           (moveAnnotations[-1].highlights && moveAnnotations[-1].highlights.size > 0)));
        const startHasNotes = !!(notes[-1] && notes[-1].trim().length > 0);
        const startMoveClass = `chess-move-item chess-move-start${currentMove === -1 ? ' active' : ''}${startHasAnnotations || startHasNotes ? ' has-annotation' : ''}`;
        
        const startRow = list.createDiv({ cls: 'chess-move-row' });
        startRow.createEl('span', { text: '', cls: 'chess-move-number' });
        const startMove = startRow.createDiv({ cls: startMoveClass });
        
        startMove.createEl('span', { text: 'Start', cls: 'chess-move-text' });
        
        // Add indicator dot AFTER the move text (on the right)
        if (startHasAnnotations || startHasNotes) {
          const indicator = startMove.createEl('span', { cls: 'chess-move-indicator' });
          indicator.title = startHasNotes ? 'Has notes' : 'Has annotations';
        }
        
        startMove.onclick = (e) => {
          e.preventDefault();
          navigateToMove(-1);
        };
        // Empty placeholder for alignment
        startRow.createDiv({ cls: 'chess-move-item chess-move-placeholder' });
        
        // Group moves into pairs (white, black)
        for (let i = 0; i < moveHistory.length; i += 2) {
          const moveRow = list.createDiv({ cls: 'chess-move-row' });
          const moveNum = Math.floor(i / 2) + 1;

          // Move number
          moveRow.createEl('span', { text: `${moveNum}.`, cls: 'chess-move-number' });

          // White's move
          const whiteMoveHasAnnotations = !!(moveAnnotations[i] && 
            ((moveAnnotations[i].arrows && moveAnnotations[i].arrows.length > 0) || 
             (moveAnnotations[i].highlights && moveAnnotations[i].highlights.size > 0)));
          const whiteMoveHasNotes = !!(notes[i] && notes[i].trim().length > 0);
          const whiteMoveClass = `chess-move-item${currentMove === i ? ' active' : ''}${whiteMoveHasAnnotations || whiteMoveHasNotes ? ' has-annotation' : ''}`;
          
          const whiteMove = moveRow.createDiv({ cls: whiteMoveClass });
          
          whiteMove.createEl('span', { text: moveHistory[i], cls: 'chess-move-text' });
          
          // Add indicator dot AFTER the move text (on the right)
          if (whiteMoveHasAnnotations || whiteMoveHasNotes) {
            const indicator = whiteMove.createEl('span', { cls: 'chess-move-indicator' });
            indicator.title = whiteMoveHasNotes ? 'Has notes' : 'Has annotations';
          }
          
          whiteMove.onclick = (e) => {
            e.preventDefault();
            navigateToMove(i);
          };
          
          // Black's move (if exists)
          if (i + 1 < moveHistory.length) {
            const blackMoveHasAnnotations = !!(moveAnnotations[i + 1] && 
              ((moveAnnotations[i + 1].arrows && moveAnnotations[i + 1].arrows.length > 0) || 
               (moveAnnotations[i + 1].highlights && moveAnnotations[i + 1].highlights.size > 0)));
            const blackMoveHasNotes = !!(notes[i + 1] && notes[i + 1].trim().length > 0);
            const blackMoveClass = `chess-move-item${currentMove === i + 1 ? ' active' : ''}${blackMoveHasAnnotations || blackMoveHasNotes ? ' has-annotation' : ''}`;
            
            const blackMove = moveRow.createDiv({ cls: blackMoveClass });
            
            blackMove.createEl('span', { text: moveHistory[i + 1], cls: 'chess-move-text' });
            
            // Add indicator dot AFTER the move text (on the right)
            if (blackMoveHasAnnotations || blackMoveHasNotes) {
              const indicator = blackMove.createEl('span', { cls: 'chess-move-indicator' });
              indicator.title = blackMoveHasNotes ? 'Has notes' : 'Has annotations';
            }
            
            blackMove.onclick = (e) => {
              e.preventDefault();
              navigateToMove(i + 1);
            };
          } else {
            // Empty placeholder for alignment
            moveRow.createDiv({ cls: 'chess-move-item chess-move-placeholder' });
          }
        }
        
        // Restore scroll position after the list is fully rendered
        if (cachedScrollPos !== undefined) {
          requestAnimationFrame(() => {
            list.scrollTop = cachedScrollPos;
          });
        }
        
        // Add resizer between moves and notes
        const movesNotesResizer = infoSection.createDiv({ cls: 'chess-moves-notes-resizer' });
        let isResizingMovesNotes = cachedResizeState?.isResizingMovesNotes || false;
        let startYMovesNotes = cachedResizeState?.startY || 0;
        let startMoveListHeight = cachedResizeState?.startMoveListHeight || 0;
        
        movesNotesResizer.addEventListener('mousedown', (e) => {
          isResizingMovesNotes = true;
          startYMovesNotes = e.clientY;
          startMoveListHeight = moveList.offsetHeight;
          document.body.setCssStyles({ cursor: 'ns-resize' });
          // Update cache to mark resize as active
          this.resizeStateCache.set(boardId, {
            boardWidth, infoWidth, totalHeight, moveListHeight,
            isResizingBoard: false,
            isResizingHeight: false,
            isResizingMovesNotes: true,
            startY: startYMovesNotes,
            startMoveListHeight
          });
          e.preventDefault();
        });
        
        // Clean up old handlers before adding new ones
        if (movesNotesResizeHandler) {
          document.removeEventListener('mousemove', movesNotesResizeHandler);
        }
        if (movesNotesResizeEndHandler) {
          document.removeEventListener('mouseup', movesNotesResizeEndHandler);
        }
        
        movesNotesResizeHandler = (e: MouseEvent) => {
          if (!isResizingMovesNotes) return;
          const diff = e.clientY - startYMovesNotes;
          const newHeight = Math.max(60, Math.min(400, startMoveListHeight + diff));
          moveListHeight = newHeight;
          moveList.setCssStyles({ height: `${newHeight}px` });
          
          // Update cache with current values during drag
          this.resizeStateCache.set(boardId, {
            boardWidth, infoWidth, totalHeight, moveListHeight: newHeight,
            isResizingBoard: false,
            isResizingHeight: false,
            isResizingMovesNotes: true,
            startY: startYMovesNotes,
            startMoveListHeight
          });
        };
        
        movesNotesResizeEndHandler = () => {
          if (isResizingMovesNotes) {
            isResizingMovesNotes = false;
            document.body.setCssStyles({ cursor: '' });
            // Clear the resize state cache since resize is complete
            this.resizeStateCache.delete(boardId);
            // Save move list scroll position to cache BEFORE saving sizes
            // Use the 'list' element which is the actual scrollable container
            if (list) {
              this.moveListScrollCache.set(boardId, list.scrollTop);
            }
            // Save the new height
            // Scroll preservation is handled by queueSaveBoardData
            this.saveBoardSizes(boardId, { boardWidth, infoWidth, totalHeight, moveListHeight });
          }
        };
        
        document.addEventListener('mousemove', movesNotesResizeHandler);
        document.addEventListener('mouseup', movesNotesResizeEndHandler);
      }

      // Notes section with inline markdown editing - fills remaining space
      const notesSection = infoSection.createDiv({ cls: 'chess-notes' });
      notesSection.createEl('h4', { text: 'Notes' });
      
      const notesContainer = notesSection.createDiv({ cls: 'chess-notes-container' });
      const notesEditor = notesContainer.createDiv({ cls: 'chess-notes-editor markdown-preview-view' });
      
      // Render inline content (bold, italic, code, links) with position tracking
      // MUST be defined before renderNotes since it's called from there
      const renderInlineContent = (text: string, container: HTMLElement, startPos: number, sourcePath: string) => {
        let i = 0;
        let rawPos = startPos;
        
        // Buffer for accumulating regular text
        let buffer = '';
        let bufferStart = rawPos;
        
        const createTextSpan = (content: string, pos: number, classes: string[] = []) => {
          if (content.length === 0) return;
          const span = container.createSpan({ cls: classes.join(' ') || undefined, text: content });
          span.dataset.rawStart = String(pos);
          span.dataset.rawEnd = String(pos + content.length);
        };
        
        const flushBuffer = () => {
          if (buffer.length > 0) {
            createTextSpan(buffer, bufferStart);
            buffer = '';
          }
          bufferStart = rawPos;
        };
        
        while (i < text.length) {
          const remaining = text.substring(i);
          
          // Wiki links [[target]] or [[target|display]]
          const wikiMatch = remaining.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
          if (wikiMatch) {
            flushBuffer();
            const fullMatch = wikiMatch[0];
            const target = wikiMatch[1];
            const display = wikiMatch[2] || target;
            
            const linkEl = container.createEl('a', {
              cls: 'chess-notes-link internal-link',
              text: display,
              href: target
            });
            linkEl.dataset.rawStart = String(rawPos);
            linkEl.dataset.rawEnd = String(rawPos + fullMatch.length);
            linkEl.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              this.app.workspace.openLinkText(target, sourcePath, false);
            });
            
            i += fullMatch.length;
            rawPos += fullMatch.length;
            bufferStart = rawPos;
            continue;
          }
          
          // External links [text](url)
          const extMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
          if (extMatch) {
            flushBuffer();
            const fullMatch = extMatch[0];
            const linkText = extMatch[1];
            const url = extMatch[2];
            
            const linkEl = container.createEl('a', {
              cls: 'chess-notes-link external-link',
              text: linkText,
              href: url
            });
            linkEl.dataset.rawStart = String(rawPos);
            linkEl.dataset.rawEnd = String(rawPos + fullMatch.length);
            linkEl.addEventListener('click', (e) => {
              e.stopPropagation();
            });
            
            i += fullMatch.length;
            rawPos += fullMatch.length;
            bufferStart = rawPos;
            continue;
          }
          
          // Bold+Italic ***text***
          if (remaining.startsWith('***')) {
            const closeIdx = text.indexOf('***', i + 3);
            if (closeIdx !== -1) {
              flushBuffer();
              const content = text.substring(i + 3, closeIdx);
              const span = container.createSpan({ cls: 'chess-notes-bold chess-notes-italic', text: content });
              span.dataset.rawStart = String(rawPos);
              span.dataset.rawEnd = String(rawPos + 6 + content.length);
              i = closeIdx + 3;
              rawPos += 6 + content.length;
              bufferStart = rawPos;
              continue;
            }
          }
          
          // Bold **text**
          if (remaining.startsWith('**') && !remaining.startsWith('***')) {
            const closeIdx = text.indexOf('**', i + 2);
            if (closeIdx !== -1) {
              flushBuffer();
              const content = text.substring(i + 2, closeIdx);
              const span = container.createSpan({ cls: 'chess-notes-bold', text: content });
              span.dataset.rawStart = String(rawPos);
              span.dataset.rawEnd = String(rawPos + 4 + content.length);
              i = closeIdx + 2;
              rawPos += 4 + content.length;
              bufferStart = rawPos;
              continue;
            }
          }
          
          // Italic *text* (not ** or ***)
          if (text[i] === '*' && !remaining.startsWith('**')) {
            const closeIdx = text.indexOf('*', i + 1);
            if (closeIdx !== -1 && text[closeIdx - 1] !== '*' && !text.substring(i+1, closeIdx).includes('*')) {
              flushBuffer();
              const content = text.substring(i + 1, closeIdx);
              const span = container.createSpan({ cls: 'chess-notes-italic', text: content });
              span.dataset.rawStart = String(rawPos);
              span.dataset.rawEnd = String(rawPos + 2 + content.length);
              i = closeIdx + 1;
              rawPos += 2 + content.length;
              bufferStart = rawPos;
              continue;
            }
          }
          
          // Inline code `text`
          if (text[i] === '`' && !remaining.startsWith('```')) {
            const closeIdx = text.indexOf('`', i + 1);
            if (closeIdx !== -1) {
              flushBuffer();
              const content = text.substring(i + 1, closeIdx);
              const span = container.createSpan({ cls: 'chess-notes-code', text: content });
              span.dataset.rawStart = String(rawPos);
              span.dataset.rawEnd = String(rawPos + 2 + content.length);
              i = closeIdx + 1;
              rawPos += 2 + content.length;
              bufferStart = rawPos;
              continue;
            }
          }
          
          // Strikethrough ~~text~~
          if (remaining.startsWith('~~')) {
            const closeIdx = text.indexOf('~~', i + 2);
            if (closeIdx !== -1) {
              flushBuffer();
              const content = text.substring(i + 2, closeIdx);
              const span = container.createSpan({ cls: 'chess-notes-strike', text: content });
              span.dataset.rawStart = String(rawPos);
              span.dataset.rawEnd = String(rawPos + 4 + content.length);
              i = closeIdx + 2;
              rawPos += 4 + content.length;
              bufferStart = rawPos;
              continue;
            }
          }
          
          // Highlight ==text==
          if (remaining.startsWith('==')) {
            const closeIdx = text.indexOf('==', i + 2);
            if (closeIdx !== -1) {
              flushBuffer();
              const content = text.substring(i + 2, closeIdx);
              const span = container.createSpan({ cls: 'chess-notes-highlight', text: content });
              span.dataset.rawStart = String(rawPos);
              span.dataset.rawEnd = String(rawPos + 4 + content.length);
              i = closeIdx + 2;
              rawPos += 4 + content.length;
              bufferStart = rawPos;
              continue;
            }
          }
          
          // Regular character - add to buffer
          buffer += text[i];
          i++;
          rawPos++;
        }
        
        // Flush remaining buffer
        flushBuffer();
      };
      
      // Function to render notes as proper markdown with position tracking for accurate cursor placement
      // This renders markdown properly (headers without #, bold without **, etc.) but stores
      // raw position information on each element for click-to-cursor mapping
      const renderNotes = () => {
        isEditingNotes = false;
        notesEditor.empty();
        const noteText = notes[currentMove] || '';
        
        if (noteText.trim()) {
          const displayDiv = notesEditor.createDiv({ cls: 'chess-notes-display' });
          
          // Process the text line by line
          const lines = noteText.split('\n');
          let rawPos = 0; // Track position in raw text
          
          for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const line = lines[lineIdx];

            if (line === '') {
              // Empty line
              const lineEl = displayDiv.createDiv({ cls: 'chess-notes-line chess-notes-empty-line' });
              lineEl.dataset.rawStart = String(rawPos);
              lineEl.dataset.rawEnd = String(rawPos);
              lineEl.createSpan({ text: '\u200B' }); // zero-width space for height
            } else {
              // Parse line type and render appropriately
              const lineEl = displayDiv.createDiv({ cls: 'chess-notes-line' });
              lineEl.dataset.rawStart = String(rawPos);
              
              // Check for headers: # Header
              const headerMatch = line.match(/^(#{1,6}) (.*)$/);
              // Check for checkbox BEFORE list (more specific pattern first)
              const checkboxMatch = line.match(/^([-*+]) \[([x ])\] (.*)$/i);
              // Check for unordered list: - item, * item, + item
              const listMatch = line.match(/^([-*+]) (.*)$/);
              // Check for ordered list: 1. item
              const orderedMatch = line.match(/^(\d+)\. (.*)$/);
              // Check for blockquote: > text
              const quoteMatch = line.match(/^> (.*)$/);
              
              if (headerMatch) {
                const hashes = headerMatch[1];
                const content = headerMatch[2];
                const level = hashes.length;
                lineEl.addClass(`chess-notes-h${level}`);
                // Render content without the #, but track positions
                renderInlineContent(content, lineEl, rawPos + hashes.length + 1, ctx.sourcePath);
                lineEl.dataset.rawEnd = String(rawPos + line.length);
                rawPos += line.length;
              }
              else if (checkboxMatch) {
                const checked = checkboxMatch[2].toLowerCase() === 'x';
                const content = checkboxMatch[3];
                const prefixLen = 6; // "- [ ] " or "- [x] "
                lineEl.addClass('chess-notes-checkbox');
                const checkSpan = lineEl.createSpan({ cls: 'chess-notes-checkbox-box' + (checked ? ' checked' : '') });
                checkSpan.textContent = checked ? '☑' : '☐';
                checkSpan.dataset.rawStart = String(rawPos);
                checkSpan.dataset.rawEnd = String(rawPos + prefixLen);
                const contentSpan = lineEl.createSpan({ cls: 'chess-notes-list-content' });
                renderInlineContent(content, contentSpan, rawPos + prefixLen, ctx.sourcePath);
                lineEl.dataset.rawEnd = String(rawPos + line.length);
                rawPos += line.length;
              }
              else if (listMatch) {
                const content = listMatch[2];
                lineEl.addClass('chess-notes-list-item');
                const bulletSpan = lineEl.createSpan({ cls: 'chess-notes-list-bullet', text: '•' });
                bulletSpan.dataset.rawStart = String(rawPos);
                bulletSpan.dataset.rawEnd = String(rawPos + 2); // "- "
                const contentSpan = lineEl.createSpan({ cls: 'chess-notes-list-content' });
                renderInlineContent(content, contentSpan, rawPos + 2, ctx.sourcePath);
                lineEl.dataset.rawEnd = String(rawPos + line.length);
                rawPos += line.length;
              }
              else if (orderedMatch) {
                const num = orderedMatch[1];
                const content = orderedMatch[2];
                const prefixLen = num.length + 2; // "1. "
                lineEl.addClass('chess-notes-list-item chess-notes-ordered');
                const numSpan = lineEl.createSpan({ cls: 'chess-notes-list-number', text: num + '.' });
                numSpan.dataset.rawStart = String(rawPos);
                numSpan.dataset.rawEnd = String(rawPos + prefixLen);
                const contentSpan = lineEl.createSpan({ cls: 'chess-notes-list-content' });
                renderInlineContent(content, contentSpan, rawPos + prefixLen, ctx.sourcePath);
                lineEl.dataset.rawEnd = String(rawPos + line.length);
                rawPos += line.length;
              }
              else if (quoteMatch) {
                const content = quoteMatch[1];
                lineEl.addClass('chess-notes-blockquote');
                renderInlineContent(content, lineEl, rawPos + 2, ctx.sourcePath);
                lineEl.dataset.rawEnd = String(rawPos + line.length);
                rawPos += line.length;
              }
              // Regular paragraph
              else {
                renderInlineContent(line, lineEl, rawPos, ctx.sourcePath);
                lineEl.dataset.rawEnd = String(rawPos + line.length);
                rawPos += line.length;
              }
            }
            
            // Add newline position (except for last line)
            if (lineIdx < lines.length - 1) {
              rawPos++; // Account for \n
            }
          }
        } else {
          notesEditor.createEl('p', { 
            text: 'Click to add notes for this move...', 
            cls: 'chess-notes-empty' 
          });
        }
      };
      
      // Check if we have a cached edit state that needs to be restored
      // This happens when a re-render occurs while the user was editing notes
      // We only restore if:
      // 1. There's cached state for this board and move
      // 2. The document is currently hidden OR we're within a short window after regaining focus
      //    (this prevents restoring after intentional blur within the app)
      const restoreEditStateIfNeeded = () => {
        const cachedEditState = this.activeNotesEditCache.get(boardId);
        if (cachedEditState && cachedEditState.moveIndex === currentMove) {
          // Only restore if the window is hidden or was very recently hidden
          // This prevents restoration after normal blur (clicking elsewhere in the app)
          // The cache is only meant to survive window/tab switches, not in-app navigation
          
          // Check if we should restore: only if document is hidden or suppressBlur is active
          // suppressBlur being active means we're in the middle of a save operation
          const shouldRestore = document.hidden || this.suppressBlur.get(boardId);
          
          if (!shouldRestore) {
            // Clear the stale cache - we're not in a window-blur scenario
            this.activeNotesEditCache.delete(boardId);
            return false;
          }
          
          // We were editing this move's notes - restore the edit mode
          isEditingNotes = true;
          notesEditor.empty();
          
          const textarea = notesEditor.createEl('textarea', { 
            cls: 'chess-notes-input-inline'
          });
          textarea.value = cachedEditState.textValue;
          textarea.setCssStyles({
            resize: 'none',
            boxSizing: 'border-box'
          });
          
          // Restore cursor position and scroll
          textarea.focus({ preventScroll: true });
          textarea.setSelectionRange(cachedEditState.cursorPosition, cachedEditState.cursorPosition);
          textarea.scrollTop = cachedEditState.scrollTop;
          
          // Re-attach all the event handlers (same as in the click handler)
          const saveEditState = () => {
            if (textarea && textarea.isConnected) {
              this.activeNotesEditCache.set(boardId, {
                cursorPosition: textarea.selectionStart,
                scrollTop: textarea.scrollTop,
                textValue: textarea.value,
                moveIndex: currentMove
              });
            }
          };
          
          textarea.addEventListener('input', saveEditState);
          textarea.addEventListener('keyup', saveEditState);
          textarea.addEventListener('click', saveEditState);
          
          textarea.onblur = (blurEvent) => {
            if (this.suppressBlur.get(boardId)) {
              return;
            }
            
            // Use a small delay to check where focus actually went
            setTimeout(() => {
              if (!textarea.isConnected) {
                return;
              }
              
              const newActiveElement = document.activeElement;
              const isDocumentHidden = document.hidden;
              const isFocusOnBody = newActiveElement === document.body || newActiveElement === document.documentElement;
              const isWindowBlur = isDocumentHidden || (isFocusOnBody && !document.hasFocus());
              
              if (isWindowBlur) {
                notes[currentMove] = textarea.value;
                saveEditState();
                return;
              }
              
              if (document.activeElement === textarea) {
                return;
              }
              
              // Normal blur - clear the cache and exit edit mode
              notes[currentMove] = textarea.value;
              this.saveBoardNotes(boardId, notes);
              this.activeNotesEditCache.delete(boardId);
              isEditingNotes = false;
              renderNotes();
            }, 10);
          };
          
          const visibilityHandler = () => {
            if (!document.hidden && textarea.isConnected && isEditingNotes) {
              textarea.focus({ preventScroll: true });
            }
          };
          document.addEventListener('visibilitychange', visibilityHandler);
          
          const windowFocusHandler = () => {
            if (textarea.isConnected && isEditingNotes) {
              setTimeout(() => {
                if (textarea.isConnected && isEditingNotes) {
                  textarea.focus({ preventScroll: true });
                }
              }, 10);
            }
          };
          window.addEventListener('focus', windowFocusHandler);
          
          const observer = new MutationObserver((mutations) => {
            if (!textarea.isConnected) {
              document.removeEventListener('visibilitychange', visibilityHandler);
              window.removeEventListener('focus', windowFocusHandler);
              observer.disconnect();
            }
          });
          observer.observe(notesEditor, { childList: true, subtree: true });
          
          // Keyboard handling
          textarea.onkeydown = (ke) => {
            if ((ke.ctrlKey || ke.metaKey) && ke.key === 'Enter') {
              ke.preventDefault();
              textarea.blur();
              return;
            }
            
            if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(ke.key)) {
              ke.stopPropagation();
            }
          };
          
          return true; // State was restored
        }
        return false; // No state to restore
      };
      
      // Initial render - but check for edit state restoration first
      if (!restoreEditStateIfNeeded()) {
        renderNotes();
      }
      
      // === CURSOR POSITION FINDING USING DATA ATTRIBUTES ===
      // Each rendered element has data-raw-start and data-raw-end attributes
      // that tell us exactly which raw text positions it represents
      
      /**
       * Find cursor position using the position data stored on elements
       */
      const findCursorPositionFromClick = (
        container: HTMLElement,
        clickX: number,
        clickY: number,
        rawMarkdown: string
      ): number => {
        // Use caretPositionFromPoint to find which element/text was clicked
        let clickedNode: Node | null = null;
        let clickedOffset = 0;

        if ((document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null }).caretPositionFromPoint) {
          const pos = (document as Document & { caretPositionFromPoint: (x: number, y: number) => { offsetNode: Node; offset: number } | null }).caretPositionFromPoint(clickX, clickY);
          if (pos) {
            clickedNode = pos.offsetNode;
            clickedOffset = pos.offset;
          }
        } else if ((document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint) {
          const range = (document as Document & { caretRangeFromPoint: (x: number, y: number) => Range | null }).caretRangeFromPoint(clickX, clickY);
          if (range) {
            clickedNode = range.startContainer;
            clickedOffset = range.startOffset;
          }
        }
        
        if (!clickedNode) {
          return rawMarkdown.length;
        }
        
        // Find the element with position data that contains this node
        let element: HTMLElement | null = null;
        if (clickedNode.nodeType === Node.TEXT_NODE) {
          element = clickedNode.parentElement;
        } else if (clickedNode.nodeType === Node.ELEMENT_NODE) {
          element = clickedNode as HTMLElement;
        }
        
        // Walk up to find an element with rawStart/rawEnd data
        while (element && !element.dataset.rawStart) {
          element = element.parentElement;
        }
        
        if (element && element.dataset.rawStart) {
          const rawStart = parseInt(element.dataset.rawStart, 10);
          const rawEnd = parseInt(element.dataset.rawEnd || element.dataset.rawStart, 10);
          
          // Get the visible text content of this element
          const visibleText = element.textContent || '';
          
          // The clicked offset is within the visible text
          // We need to map this to the raw position
          // For most elements, this is straightforward:
          // rawPosition = rawStart + (clickedOffset relative to element)
          
          // But for elements where syntax was stripped (like headers, bold, etc.),
          // the visible text is shorter than the raw text range
          // In those cases, we proportionally map the position

          const visibleLength = visibleText.length;

          if (visibleLength === 0) {
            return rawStart;
          }
          
          // Calculate where in the visible text we clicked
          // We need to find the offset relative to this element's text
          let offsetInElement = 0;
          
          if (clickedNode.nodeType === Node.TEXT_NODE && element.contains(clickedNode)) {
            // Find offset by walking text nodes in this element
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);
            let node;
            while ((node = walker.nextNode())) {
              if (node === clickedNode) {
                offsetInElement += clickedOffset;
                break;
              }
              offsetInElement += (node.textContent || '').length;
            }
          } else {
            offsetInElement = clickedOffset;
          }
          
          // Clamp to valid range
          offsetInElement = Math.max(0, Math.min(offsetInElement, visibleLength));
          
          // For simple text (no syntax stripped), rawLength === visibleLength
          // For elements with stripped syntax, we need to account for the difference
          // The mapping depends on where the syntax is (beginning, end, or both sides)
          
          // Check if this is a line element with content that had prefix stripped
          const lineEl = element.closest('.chess-notes-line');
          if (lineEl && lineEl.classList.contains('chess-notes-h1') || 
              lineEl?.classList.contains('chess-notes-h2') ||
              lineEl?.classList.contains('chess-notes-h3') ||
              lineEl?.classList.contains('chess-notes-h4') ||
              lineEl?.classList.contains('chess-notes-h5') ||
              lineEl?.classList.contains('chess-notes-h6')) {
            // For headers, the # prefix was stripped from display but rawStart accounts for it
            // So we just add offset directly
            return Math.min(rawStart + offsetInElement, rawEnd);
          }
          
          // For inline formatting (bold, italic, etc.) the syntax markers are at both ends
          // visible text is the content between markers
          // rawStart points to opening marker, rawEnd points past closing marker
          if (element.classList.contains('chess-notes-bold') ||
              element.classList.contains('chess-notes-italic') ||
              element.classList.contains('chess-notes-code') ||
              element.classList.contains('chess-notes-strike') ||
              element.classList.contains('chess-notes-highlight')) {
            // For **bold**, raw is "**bold**" (8 chars), visible is "bold" (4 chars)
            // If clicking at visible offset 2, raw position should be 2 + 2 (for opening **)
            // Determine marker length based on class
            let openMarkerLen = 0;
            if (element.classList.contains('chess-notes-bold') && element.classList.contains('chess-notes-italic')) {
              openMarkerLen = 3; // ***
            } else if (element.classList.contains('chess-notes-bold')) {
              openMarkerLen = 2; // **
            } else if (element.classList.contains('chess-notes-italic')) {
              openMarkerLen = 1; // *
            } else if (element.classList.contains('chess-notes-code')) {
              openMarkerLen = 1; // `
            } else if (element.classList.contains('chess-notes-strike')) {
              openMarkerLen = 2; // ~~
            } else if (element.classList.contains('chess-notes-highlight')) {
              openMarkerLen = 2; // ==
            }
            return Math.min(rawStart + openMarkerLen + offsetInElement, rawEnd);
          }
          
          // For links, the display text maps to a specific part of the raw text
          if (element.classList.contains('chess-notes-link')) {
            // For [[link]], visible is "link" but we show full [[link]]
            // For [text](url), visible is "text"
            // The rawStart/rawEnd covers the whole syntax
            // Just place cursor at beginning of link for simplicity
            return rawStart + offsetInElement;
          }
          
          // Default: direct mapping
          return Math.min(rawStart + offsetInElement, rawEnd);
        }
        
        // If we couldn't find position data, try to find which line we're in
        const lines = container.querySelectorAll('.chess-notes-line');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] as HTMLElement;
          const rect = line.getBoundingClientRect();
          
          if (clickY >= rect.top && clickY <= rect.bottom) {
            // Click is in this line's vertical space
            if (line.dataset.rawStart) {
              return parseInt(line.dataset.rawStart, 10);
            }
          } else if (clickY < rect.top && i === 0) {
            // Click is above first line
            return 0;
          } else if (i < lines.length - 1) {
            const nextLine = lines[i + 1] as HTMLElement;
            const nextRect = nextLine.getBoundingClientRect();
            if (clickY > rect.bottom && clickY < nextRect.top) {
              // Click is between this line and next - go to start of next line
              if (nextLine.dataset.rawStart) {
                return parseInt(nextLine.dataset.rawStart, 10);
              }
            }
          }
        }
        
        // Fallback to end
        return rawMarkdown.length;
      };
      
      // Click to edit - but only if not selecting text
      let mouseDownTime = 0;
      let mouseDownPos = { x: 0, y: 0 };
      
      notesEditor.addEventListener('mousedown', (e) => {
        // Don't interfere if already in edit mode
        if (isEditingNotes) return;
        
        mouseDownTime = Date.now();
        mouseDownPos = { x: e.clientX, y: e.clientY };
      });
      
      notesEditor.addEventListener('mouseup', (e) => {
        // Don't interfere if already in edit mode
        if (isEditingNotes) return;
        
        // Check if click was on a link - if so, don't enter edit mode
        const target = e.target as HTMLElement;
        if (target.tagName === 'A' || target.closest('a')) {
          return;
        }
        
        const timeDiff = Date.now() - mouseDownTime;
        const distMoved = Math.sqrt(
          Math.pow(e.clientX - mouseDownPos.x, 2) + 
          Math.pow(e.clientY - mouseDownPos.y, 2)
        );
        
        // Only enter edit mode if it was a quick click without much movement
        if (timeDiff < 300 && distMoved < 5) {
          // Check if there's a text selection
          const selection = window.getSelection();
          if (selection && selection.toString().length > 0) {
            return;
          }
          
          // Get the raw markdown text
          const rawMarkdownText = notes[currentMove] || '';
          
          // Calculate cursor position BEFORE clearing the editor
          let cursorPosition = rawMarkdownText.length; // Default to end
          
          if (rawMarkdownText.length > 0) {
            cursorPosition = findCursorPositionFromClick(
              notesEditor,
              e.clientX,
              e.clientY,
              rawMarkdownText
            );
          }
          
          // Now create the textarea
          isEditingNotes = true;
          notesEditor.empty();
          
          const textarea = notesEditor.createEl('textarea', { 
            cls: 'chess-notes-input-inline'
          });
          textarea.value = rawMarkdownText;
          textarea.setCssStyles({
            resize: 'none',
            boxSizing: 'border-box'
          });
          
          // Focus and set cursor position
          textarea.focus({ preventScroll: true });
          textarea.setSelectionRange(cursorPosition, cursorPosition);
          
          // Scroll textarea to show the cursor
          const textBeforeCursor = rawMarkdownText.substring(0, cursorPosition);
          const lineNumber = (textBeforeCursor.match(/\n/g) || []).length;
          const style = window.getComputedStyle(textarea);
          const lineHeight = parseFloat(style.lineHeight) || 20;
          const scrollTarget = Math.max(0, lineNumber * lineHeight - textarea.clientHeight / 3);
          textarea.scrollTop = scrollTarget;
          
          // Track that we're actively editing this board's notes
          // Store current state so we can restore after re-renders
          const saveEditState = () => {
            if (textarea && textarea.isConnected) {
              this.activeNotesEditCache.set(boardId, {
                cursorPosition: textarea.selectionStart,
                scrollTop: textarea.scrollTop,
                textValue: textarea.value,
                moveIndex: currentMove
              });
            }
          };
          
          // Save state periodically and on input
          textarea.addEventListener('input', saveEditState);
          textarea.addEventListener('keyup', saveEditState);
          textarea.addEventListener('click', saveEditState);
          
          // Initial save of edit state
          saveEditState();
          
          // Save and switch back to preview on blur - but only for intentional blur
          textarea.onblur = (blurEvent) => {
            // Check if blur was caused by window/tab losing focus
            // In that case, we want to keep the textarea active
            if (this.suppressBlur.get(boardId)) {
              return;
            }
            
            // Use a small delay to check where focus actually went
            // This is necessary because at the moment of blur, the new activeElement
            // might not be set yet (it could temporarily be body)
            setTimeout(() => {
              // If textarea was removed from DOM during the delay, don't do anything
              if (!textarea.isConnected) {
                return;
              }
              
              // Check if the document is hidden (tab switched) or if focus went outside the window
              const newActiveElement = document.activeElement;
              const isDocumentHidden = document.hidden;
              const isFocusOnBody = newActiveElement === document.body || newActiveElement === document.documentElement;

              // True window blur: document is hidden OR focus is on body AND we're not focused within the container
              // AND the textarea no longer has focus (someone else has it or nobody does)
              const isWindowBlur = isDocumentHidden || (isFocusOnBody && !document.hasFocus());
              
              if (isWindowBlur) {
                // Window lost focus - save state but DON'T exit edit mode
                // The visibilitychange/focus handlers will restore focus when window regains focus
                notes[currentMove] = textarea.value;
                this.activeNotesEditCache.set(boardId, {
                  cursorPosition: textarea.selectionStart,
                  scrollTop: textarea.scrollTop,
                  textValue: textarea.value,
                  moveIndex: currentMove
                });
                return;
              }
              
              // If focus moved back to the textarea (e.g., from our focus restoration), don't exit
              if (document.activeElement === textarea) {
                return;
              }
              
              // Normal blur (clicked somewhere else in the app) - save and exit edit mode
              notes[currentMove] = textarea.value;
              this.saveBoardNotes(boardId, notes);
              // Clear the edit state cache since we're intentionally exiting
              this.activeNotesEditCache.delete(boardId);
              isEditingNotes = false;
              renderNotes();
            }, 10); // Small delay to let focus settle
          };
          
          // Handle visibility change to restore focus when window regains focus
          const visibilityHandler = () => {
            if (!document.hidden && textarea.isConnected && isEditingNotes) {
              // Window became visible again, restore focus to textarea
              textarea.focus({ preventScroll: true });
            }
          };
          document.addEventListener('visibilitychange', visibilityHandler);
          
          // Handle window focus to restore textarea focus
          const windowFocusHandler = () => {
            if (textarea.isConnected && isEditingNotes) {
              // Small delay to let the window fully activate
              setTimeout(() => {
                if (textarea.isConnected && isEditingNotes) {
                  textarea.focus({ preventScroll: true });
                }
              }, 10);
            }
          };
          window.addEventListener('focus', windowFocusHandler);
          
          // Clean up handlers when textarea is removed
          const cleanupHandlers = () => {
            document.removeEventListener('visibilitychange', visibilityHandler);
            window.removeEventListener('focus', windowFocusHandler);
          };
          
          // Use MutationObserver to detect when textarea is removed from DOM
          const observer = new MutationObserver((mutations) => {
            if (!textarea.isConnected) {
              cleanupHandlers();
              observer.disconnect();
            }
          });
          observer.observe(notesEditor, { childList: true, subtree: true });
          
          // Keyboard handling
          textarea.onkeydown = (ke) => {
            if ((ke.ctrlKey || ke.metaKey) && ke.key === 'Enter') {
              ke.preventDefault();
              textarea.blur();
              return;
            }
            
            // Prevent scroll-related keys from bubbling to parent
            if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(ke.key)) {
              ke.stopPropagation();
            }
          };
        }
      });

      // Game info - NOW IN GAME INFO SECTION BELOW BOARD (swapped with FEN)
      if (Object.keys(pgnData).length > 0) {
        gameInfoSection.setCssStyles({ display: '' });
        const info = gameInfoSection.createDiv({ cls: 'chess-game-info' });
        info.createEl('h4', { text: 'Game Info' });
        const infoList = info.createDiv({ cls: 'chess-info-list' });
        for (const [key, value] of Object.entries(pgnData)) {
          const item = infoList.createDiv({ cls: 'chess-info-item' });
          item.createEl('strong', { text: key + ': ' });
          
          // Check if value is a URL
          if (typeof value === 'string' && (value.startsWith('http://') || value.startsWith('https://'))) {
            const link = item.createEl('a', { text: value, href: value });
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
          } else {
            item.createEl('span', { text: value });
          }
        }
      } else {
        // Hide the game info section when there's no data
        gameInfoSection.setCssStyles({ display: 'none' });
      }
      
      // Redraw engine best move arrow (it gets cleared by drawArrows)
      // Always call this to ensure the arrow is present if we have a best move
      updateBestMoveArrow();
      
      // Update eval bar display (in case it was recreated)
      updateEvalBar();
    };

    // Set up drag piece following cursor handler
    const dragMoveHandler = (e: MouseEvent) => {
      if (draggedPiece && draggedPiece.element) {
        // Check if element is still in DOM
        if (draggedPiece.element.parentNode) {
          // Use getBoundingClientRect for accurate size, fallback to style parsing
          const rect = draggedPiece.element.getBoundingClientRect();
          const size = rect.width || parseInt(draggedPiece.element.style.width) || 60;
          draggedPiece.element.setCssStyles({
            left: `${e.clientX - size / 2}px`,
            top: `${e.clientY - size / 2}px`
          });
        } else {
          // Element was removed but drag state wasn't cleaned up - fix it
          if (draggedPiece.originalElement) {
            draggedPiece.originalElement.setCssStyles({ opacity: '' });
          }
          draggedPiece = null;
        }
      }
    };
    
    this.registerDocumentListener(boardId, 'mousemove', dragMoveHandler as EventListener);

    render();
    
    // On mobile, recalculate board size after layout is complete
    if (window.innerWidth < 1024) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const bSection = container.querySelector('.chess-board-section') as HTMLElement;
          const bWrapper = container.querySelector('.chess-board-wrapper') as HTMLElement;
          if (bSection && bWrapper) {
            const evalW = this.settings.enableEngine ? 20 : 0;
            const padW = 32;
            const secW = bSection.offsetWidth;
            const availW = Math.max(200, secW - padW - evalW);
            const curW = parseInt(bWrapper.style.width) || 0;
            if (Math.abs(availW - curW) > 5) {
              bWrapper.setCssStyles({
                width: `${availW}px`,
                height: `${availW}px`,
                maxWidth: `${availW}px`,
                maxHeight: `${availW}px`
              });
            }
          }
        });
      });
    }
    
    // Initialize engine after first render, or update display with cached results
    if (this.settings.enableEngine) {
      if (getEngineWorker()) {
        // Engine already initialized - check if cached analysis matches current position
        const currentFen = this.boardToFEN(currentBoard, getCurrentTurn());
        const cachedFen = getCurrentAnalysisFen();
        
        if (currentFen === cachedFen) {
          // Cached analysis is for current position - display it
          updateEvalBar();
          updateBestMoveArrow();
        } else {
          // Position changed - need to re-analyze
          analyzePosition();
        }
      } else {
        // Initialize engine for the first time
        initEngine();
      }
    }
  }

  createSvgOverlay(container: HTMLElement): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'chess-svg-overlay');
    svg.setAttribute('viewBox', '0 0 800 800');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setCssStyles({ pointerEvents: 'none' });
    
    // We don't use markers because they have rendering issues on mobile
    // Instead, arrows are drawn as paths with the arrowhead built-in
    
    container.appendChild(svg);
    return svg;
  }

  // Helper method to create an arrow (line + arrowhead) as a single SVG group
  createArrowElement(x1: number, y1: number, x2: number, y2: number, color: string, isEngine: boolean = false): SVGGElement {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    if (isEngine) {
      group.classList.add('chess-engine-arrow');
    }
    
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.sqrt(dx * dx + dy * dy);
    
    if (length === 0) return group;
    
    const nx = dx / length;
    const ny = dy / length;
    
    const headLength = 26;
    const headWidth = 22;
    const lineWidth = 14;
    
    const lineEndX = x2 - nx * headLength;
    const lineEndY = y2 - ny * headLength;
    
    const px = -ny;
    const py = nx;
    
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1.toString());
    line.setAttribute('y1', y1.toString());
    line.setAttribute('x2', lineEndX.toString());
    line.setAttribute('y2', lineEndY.toString());
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', lineWidth.toString());
    line.setAttribute('stroke-linecap', 'round');
    
    const arrowhead = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    const tipX = x2;
    const tipY = y2;
    const baseLeftX = lineEndX + px * headWidth;
    const baseLeftY = lineEndY + py * headWidth;
    const baseRightX = lineEndX - px * headWidth;
    const baseRightY = lineEndY - py * headWidth;
    
    arrowhead.setAttribute('points', `${tipX},${tipY} ${baseLeftX},${baseLeftY} ${baseRightX},${baseRightY}`);
    arrowhead.setAttribute('fill', color);
    
    group.appendChild(line);
    group.appendChild(arrowhead);
    
    return group;
  }

  // Animate a piece moving from one square to another
  animatePieceMove(
    boardEl: HTMLElement,
    fromRow: number,
    fromCol: number,
    toRow: number,
    toCol: number,
    flipped: boolean,
    duration: number,
    onComplete: () => void
  ) {
    // Get display coordinates (accounting for flip)
    const displayFromRow = flipped ? 7 - fromRow : fromRow;
    const displayFromCol = flipped ? 7 - fromCol : fromCol;
    const displayToRow = flipped ? 7 - toRow : toRow;
    const displayToCol = flipped ? 7 - toCol : toCol;
    
    const fromSquareIdx = displayFromRow * 8 + displayFromCol;
    const fromSquare = boardEl.children[fromSquareIdx] as HTMLElement;
    const pieceEl = fromSquare?.querySelector('.chess-piece') as HTMLElement;
    
    if (!pieceEl || !fromSquare) {
      onComplete();
      return;
    }
    
    // Calculate movement distance in pixels
    const squareSize = fromSquare.getBoundingClientRect().width;
    const deltaX = (displayToCol - displayFromCol) * squareSize;
    const deltaY = (displayToRow - displayFromRow) * squareSize;
    
    // Apply animation
    pieceEl.setCssStyles({
      transition: `transform ${duration}ms ease-out`,
      transform: `translate(${deltaX}px, ${deltaY}px)`
    });
    pieceEl.setCssStyles({ zIndex: '100' });
    
    setTimeout(() => {
      // Reset styles before callback
      pieceEl.setCssStyles({
        transition: '',
        transform: '',
        zIndex: ''
      });
      onComplete();
    }, duration);
  }

  updateBoard(
    board: (string | null)[][],
    container: HTMLElement,
    svgOverlay: SVGSVGElement,
    flipped: boolean,
    lastMove: { from: number[], to: number[] } | null,
    selectedSquare: number[] | null,
    arrows: { from: [number, number], to: [number, number] }[],
    highlightedSquares: Set<string>,
    legalMoves: number[][],
    isInCheck: boolean,
    isCheckmate: boolean,
    turnColor: string,
    adapter: DataAdapter,
    pluginPath: string,
    pieceSize: number,
    onSquareClick: (row: number, col: number) => void,
    onDragStart: (row: number, col: number, piece: string, pieceEl: HTMLElement, mouseX: number, mouseY: number) => void,
    onDragEnd: (row: number, col: number) => void,
    onDragCancel: () => void,
    onDrawArrow: (fromRow: number, fromCol: number, toRow: number, toCol: number, isRightClickDrag: boolean) => void
  ) {
    // Store the flipped state to detect when it changes
    const wasFlipped = container.dataset.flipped === 'true';
    const flipChanged = wasFlipped !== flipped;
    container.dataset.flipped = flipped.toString();
    
    // If board was flipped, clear all squares to recreate with new coordinates
    if (flipChanged) {
      container.empty();
    }
    
    const displayBoard = flipped ? board.slice().reverse().map(row => row.slice().reverse()) : board;
    const files = flipped ? ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a'] : ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const ranks = flipped ? ['1', '2', '3', '4', '5', '6', '7', '8'] : ['8', '7', '6', '5', '4', '3', '2', '1'];

    let rightClickStart: [number, number] | null = null;
    let isRightDragging = false;
    let previewArrowElement: SVGGElement | null = null;

    // Function to draw arrows
    const drawArrows = () => {
      if (previewArrowElement && previewArrowElement.parentNode === svgOverlay) {
        svgOverlay.removeChild(previewArrowElement);
        previewArrowElement = null;
      }

      while (svgOverlay.firstChild) {
        svgOverlay.removeChild(svgOverlay.firstChild);
      }

      arrows.forEach(arrow => {
        const fromRow = flipped ? 7 - arrow.from[0] : arrow.from[0];
        const fromCol = flipped ? 7 - arrow.from[1] : arrow.from[1];
        const toRow = flipped ? 7 - arrow.to[0] : arrow.to[0];
        const toCol = flipped ? 7 - arrow.to[1] : arrow.to[1];
        
        const x1 = (fromCol * 100) + 50;
        const y1 = (fromRow * 100) + 50;
        const x2 = (toCol * 100) + 50;
        const y2 = (toRow * 100) + 50;

        const arrowEl = this.createArrowElement(x1, y1, x2, y2, 'rgba(241, 190, 60, 0.9)');
        svgOverlay.appendChild(arrowEl);
      });
    };

    const drawPreviewArrow = (fromR: number, fromC: number, toR: number, toC: number) => {
      if (previewArrowElement && previewArrowElement.parentNode === svgOverlay) {
        svgOverlay.removeChild(previewArrowElement);
      }

      const fromRow = flipped ? 7 - fromR : fromR;
      const fromCol = flipped ? 7 - fromC : fromC;
      const toRow = flipped ? 7 - toR : toR;
      const toCol = flipped ? 7 - toC : toC;
      
      const x1 = (fromCol * 100) + 50;
      const y1 = (fromRow * 100) + 50;
      const x2 = (toCol * 100) + 50;
      const y2 = (toRow * 100) + 50;

      previewArrowElement = this.createArrowElement(x1, y1, x2, y2, 'rgba(241, 190, 60, 0.6)');
      svgOverlay.appendChild(previewArrowElement);
    };

    const clearPreviewArrow = () => {
      if (previewArrowElement && previewArrowElement.parentNode === svgOverlay) {
        svgOverlay.removeChild(previewArrowElement);
        previewArrowElement = null;
      }
    };

    for (let rowIdx = 0; rowIdx < 8; rowIdx++) {
      for (let colIdx = 0; colIdx < 8; colIdx++) {
        const actualRow = flipped ? 7 - rowIdx : rowIdx;
        const actualCol = flipped ? 7 - colIdx : colIdx;
        const isLight = (actualRow + actualCol) % 2 === 0;
        const piece = displayBoard[rowIdx][colIdx];
        
        const squareIdx = rowIdx * 8 + colIdx;
        let square = container.children[squareIdx] as HTMLElement;
        
        // Always recreate squares if flip changed or square doesn't exist properly
        const needsRecreate = flipChanged || !square || !square.classList.contains('chess-square');
        
        if (needsRecreate) {
          // Remove old square if exists
          if (square && square.classList.contains('chess-square')) {
            square.remove();
          }
          
          square = container.createDiv();
          if (container.children[squareIdx]) {
            container.insertBefore(square, container.children[squareIdx]);
          } else {
            container.appendChild(square);
          }
          
          // No HTML5 drag handlers needed - we use pure mouse events

          square.addEventListener('contextmenu', (e) => {
            e.preventDefault();
          });
          
          square.addEventListener('mousedown', (e) => {
            if (e.button === 2) {
              e.preventDefault();
              rightClickStart = [actualRow, actualCol];
              isRightDragging = false;
              clearPreviewArrow();
            }
          });

          square.addEventListener('mousemove', (e) => {
            if (e.buttons === 2 && rightClickStart) {
              // Only set dragging if we've moved to a different square
              if (rightClickStart[0] !== actualRow || rightClickStart[1] !== actualCol) {
                isRightDragging = true;
                drawPreviewArrow(rightClickStart[0], rightClickStart[1], actualRow, actualCol);
              }
            }
          });

          square.addEventListener('mouseup', (e) => {
            if (e.button === 2 && rightClickStart) {
              e.preventDefault();
              clearPreviewArrow();
              
              if (isRightDragging && (rightClickStart[0] !== actualRow || rightClickStart[1] !== actualCol)) {
                // Right-click drag - create arrow
                onDrawArrow(rightClickStart[0], rightClickStart[1], actualRow, actualCol, true);
              } else if (!isRightDragging && rightClickStart[0] === actualRow && rightClickStart[1] === actualCol) {
                // Single right-click on same square - highlight square
                onDrawArrow(rightClickStart[0], rightClickStart[1], actualRow, actualCol, false);
              }
              
              rightClickStart = null;
              isRightDragging = false;
            }
          });
          
          square.dataset.listenersAttached = 'true';
        }
        
        // ALWAYS update click and drop handlers to use current callbacks
        // Store row/col in data attributes for the handlers to use
        square.dataset.row = actualRow.toString();
        square.dataset.col = actualCol.toString();
        
        // Square click handler - only fires if not on a piece
        square.onclick = (e) => {
          // Only handle if the click target is the square itself (not a piece)
          if (e.target === square) {
            const r = parseInt(square.dataset.row);
            const c = parseInt(square.dataset.col);
            onSquareClick(r, c);
          }
        };
        
        // Update square classes
        let squareClass = `chess-square ${isLight ? 'light' : 'dark'}`;
        
        // Highlight from square (lighter)
        if (lastMove && lastMove.from[0] === actualRow && lastMove.from[1] === actualCol) {
          squareClass += ' move-from';
        }
        
        // Highlight to square (darker)
        if (lastMove && lastMove.to[0] === actualRow && lastMove.to[1] === actualCol) {
          squareClass += ' move-to';
        }
        
        // Right-click highlight (red)
        const squareKey = `${actualRow}-${actualCol}`;
        if (highlightedSquares.has(squareKey)) {
          squareClass += ' highlighted';
        }
        
        if (selectedSquare && selectedSquare[0] === actualRow && selectedSquare[1] === actualCol) {
          squareClass += ' selected';
        }

        const isLegalMove = legalMoves.some(([r, c]) => r === actualRow && c === actualCol);
        if (isLegalMove) {
          squareClass += ' legal-move';
        }
        
        // Add check/checkmate class to king's square
        if (piece && piece.toLowerCase() === 'k') {
          // Determine if this king is in check
          const isWhiteKing = piece === 'K';
          // isInCheck is for the side to move
          // turnColor determines whose turn it is (who is potentially in check)
          // We need to match the king color with the turn color
          const turnIsWhite = turnColor === 'white';
          
          // Only highlight if this king matches the side that is in check
          if (isWhiteKing === turnIsWhite) {
            if (isCheckmate) {
              squareClass += ' checkmate';
            } else if (isInCheck) {
              squareClass += ' in-check';
            }
          }
        }

        square.className = squareClass;
        
        // Update piece - check if piece changed
        const existingPiece = square.querySelector('.chess-piece');
        const existingPieceType = existingPiece?.getAttribute('data-piece');
        
        if (piece !== existingPieceType) {
          // Remove old piece if exists
          if (existingPiece) {
            existingPiece.remove();
          }
          
          // Add new piece if needed
          if (piece) {
            const pieceEl = square.createDiv({ 
              cls: `chess-piece ${piece === piece.toLowerCase() ? 'black' : 'white'}`
            });
            pieceEl.setAttribute('data-piece', piece);
            
            // Load SVG - use Obsidian's resource path method
            const pieceColor = piece === piece.toLowerCase() ? 'b' : 'w';
            const pieceName = this.getPieceName(piece.toLowerCase());
            const svgFilename = `${pieceName}-${pieceColor}.svg`;
            
            // Use adapter.getResourcePath for proper resource loading from pieces folder
            const svgPath = `${pluginPath}pieces/${svgFilename}`;
            const resourceUrl = adapter.getResourcePath(svgPath);
            
            pieceEl.setCssStyles({
              backgroundImage: `url("${resourceUrl}")`,
              backgroundSize: '80%',
              backgroundPosition: 'center',
              backgroundRepeat: 'no-repeat',
              fontSize: `${pieceSize}px`
            });
            
            // IMPORTANT: Disable HTML5 drag - we use custom mouse-based dragging
            pieceEl.draggable = false;
            
            // Store coordinates in data attributes
            pieceEl.dataset.row = actualRow.toString();
            pieceEl.dataset.col = actualCol.toString();
            pieceEl.dataset.piece = piece;
            
            let isMouseDown = false;
            let isDragging = false;
            let startX = 0;
            let startY = 0;
            
            // Use document-level listeners for drag tracking
            const handleMouseMove = (e: MouseEvent) => {
              if (isMouseDown) {
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                // Start drag if moved more than 3 pixels
                if (!isDragging && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
                  isDragging = true;
                  const r = parseInt(pieceEl.dataset.row);
                  const c = parseInt(pieceEl.dataset.col);
                  const p = pieceEl.dataset.piece;
                  // NOW create the drag clone, at current mouse position
                  onDragStart(r, c, p, pieceEl, e.clientX, e.clientY);
                }
              }
            };
            
            const handleMouseUp = (e: MouseEvent) => {
              if (isMouseDown) {
                isMouseDown = false;
                
                // Clean up listeners first
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);
                
                if (!isDragging) {
                  // This was a click, not a drag - handle as click
                  const r = parseInt(pieceEl.dataset.row);
                  const c = parseInt(pieceEl.dataset.col);
                  onSquareClick(r, c);
                } else {
                  // This was a drag - find the target square
                  const targetElement = document.elementFromPoint(e.clientX, e.clientY);
                  if (targetElement) {
                    const square = targetElement.closest('.chess-square') as HTMLElement;
                    if (square && square.dataset.row && square.dataset.col) {
                      const targetRow = parseInt(square.dataset.row);
                      const targetCol = parseInt(square.dataset.col);
                      onDragEnd(targetRow, targetCol);
                    } else {
                      onDragCancel();
                    }
                  } else {
                    onDragCancel();
                  }
                }
                isDragging = false;
              }
            };
            
            pieceEl.addEventListener('mousedown', (e) => {
              if (e.button === 0) {
                e.preventDefault();
                e.stopPropagation();
                isMouseDown = true;
                isDragging = false;
                startX = e.clientX;
                startY = e.clientY;
                
                // Add document-level listeners for tracking
                document.addEventListener('mousemove', handleMouseMove);
                document.addEventListener('mouseup', handleMouseUp);
                
                // DON'T start drag here - wait for movement
              }
            });
          } else if (existingPiece) {
            // Piece exists and type matches - just update data attributes
            (existingPiece as HTMLElement).dataset.row = actualRow.toString();
            (existingPiece as HTMLElement).dataset.col = actualCol.toString();
          }
        }

        // Update labels - only add if they don't exist
        if (rowIdx === 7) {
          let fileLabel = square.querySelector('.chess-file-label') as HTMLElement;
          if (!fileLabel) {
            fileLabel = square.createDiv({ cls: 'chess-file-label', text: files[colIdx] });
          } else {
            fileLabel.textContent = files[colIdx];
          }
        }
        if (colIdx === 0) {
          let rankLabel = square.querySelector('.chess-rank-label') as HTMLElement;
          if (!rankLabel) {
            rankLabel = square.createDiv({ cls: 'chess-rank-label', text: ranks[rowIdx] });
          } else {
            rankLabel.textContent = ranks[rowIdx];
          }
        }
      }
    }

    // Initial arrow drawing
    drawArrows();
  }

  getLegalMoves(board: (string | null)[][], row: number, col: number): number[][] {
    const piece = board[row][col];
    if (!piece) return [];

    const moves: number[][] = [];
    const isWhite = piece === piece.toUpperCase();
    const p = piece.toLowerCase();

    if (p === 'p') {
      const dir = isWhite ? -1 : 1;
      const startRow = isWhite ? 6 : 1;
      
      if (board[row + dir]?.[col] === null) {
        moves.push([row + dir, col]);
        if (row === startRow && board[row + 2 * dir]?.[col] === null) {
          moves.push([row + 2 * dir, col]);
        }
      }
      
      [-1, 1].forEach(dc => {
        const target = board[row + dir]?.[col + dc];
        if (target && this.isOpponentPiece(target, isWhite)) {
          moves.push([row + dir, col + dc]);
        }
      });
    } else if (p === 'n') {
      const knightMoves = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
      knightMoves.forEach(([dr, dc]) => {
        const nr = row + dr, nc = col + dc;
        if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
          const target = board[nr][nc];
          if (!target || this.isOpponentPiece(target, isWhite)) {
            moves.push([nr, nc]);
          }
        }
      });
    } else if (p === 'k') {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = row + dr, nc = col + dc;
          if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
            const target = board[nr][nc];
            if (!target || this.isOpponentPiece(target, isWhite)) {
              moves.push([nr, nc]);
            }
          }
        }
      }
      
      // Castling logic
      const backRank = isWhite ? 7 : 0;
      if (row === backRank && col === 4) {
        // Kingside castling
        if (board[backRank][7] && board[backRank][7]!.toLowerCase() === 'r' &&
            board[backRank][5] === null && board[backRank][6] === null) {
          moves.push([backRank, 6]);
        }
        // Queenside castling
        if (board[backRank][0] && board[backRank][0]!.toLowerCase() === 'r' &&
            board[backRank][1] === null && board[backRank][2] === null && board[backRank][3] === null) {
          moves.push([backRank, 2]);
        }
      }
    } else {
      const directions = p === 'b' ? [[-1,-1],[-1,1],[1,-1],[1,1]] :
                        p === 'r' ? [[-1,0],[1,0],[0,-1],[0,1]] :
                        [[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]];
      
      directions.forEach(([dr, dc]) => {
        let nr = row + dr, nc = col + dc;
        while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
          const target = board[nr][nc];
          if (target) {
            if (this.isOpponentPiece(target, isWhite)) moves.push([nr, nc]);
            break;
          }
          moves.push([nr, nc]);
          nr += dr;
          nc += dc;
        }
      });
    }

    return moves;
  }

  isOpponentPiece(piece: string, isWhite: boolean): boolean {
    return isWhite ? piece === piece.toLowerCase() : piece === piece.toUpperCase();
  }

  isLegalMove(board: (string | null)[][], fromRow: number, fromCol: number, toRow: number, toCol: number): boolean {
    const piece = board[fromRow][fromCol];
    if (!piece) return false;
    
    const legalMoves = this.getLegalMoves(board, fromRow, fromCol);
    const isLegal = legalMoves.some(([r, c]) => r === toRow && c === toCol);
    
    // Special handling for castling by dragging king onto rook
    if (piece.toLowerCase() === 'k' && !isLegal) {
      const targetPiece = board[toRow][toCol];
      if (targetPiece && targetPiece.toLowerCase() === 'r' && 
          this.isOpponentPiece(targetPiece, piece === piece.toLowerCase())) {
        // Check if this would be a valid castle
        const isWhite = piece === piece.toUpperCase();
        const backRank = isWhite ? 7 : 0;
        
        if (fromRow === backRank && toRow === backRank && fromCol === 4) {
          // Kingside castle (rook on h-file)
          if (toCol === 7 && board[backRank][5] === null && board[backRank][6] === null) {
            return true;
          }
          // Queenside castle (rook on a-file)
          if (toCol === 0 && board[backRank][1] === null && board[backRank][2] === null && board[backRank][3] === null) {
            return true;
          }
        }
      }
    }
    
    return isLegal;
  }

  isKingInCheck(board: (string | null)[][], color: 'white' | 'black'): boolean {
    const king = color === 'white' ? 'K' : 'k';
    let kingPos: [number, number] | null = null;
    
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (board[r][c] === king) {
          kingPos = [r, c];
          break;
        }
      }
      if (kingPos) break;
    }
    
    if (!kingPos) return false;
    
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const piece = board[r][c];
        if (piece && this.isOpponentPiece(piece, color === 'white')) {
          const moves = this.getLegalMoves(board, r, c);
          if (moves.some(([mr, mc]) => mr === kingPos![0] && mc === kingPos![1])) {
            return true;
          }
        }
      }
    }
    
    return false;
  }

  isCheckmate(board: (string | null)[][], color: 'white' | 'black'): boolean {
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const piece = board[r][c];
        if (piece && !this.isOpponentPiece(piece, color === 'white')) {
          const moves = this.getLegalMoves(board, r, c);
          if (moves.length > 0) return false;
        }
      }
    }
    return true;
  }

  parseInput(source: string): { 
    board: (string | null)[][], 
    moveHistory: string[], 
    pgnData: { [key: string]: string },
    timestamps: { white: string, black: string }[],
    whiteElo: string | null,
    blackElo: string | null,
    whiteName: string | null,
    blackName: string | null,
    inlineData: InlineBoardData,
    pgnSource: string, // The PGN/FEN portion without inline data, trimmed
    initialTurn: 'w' | 'b' // The initial turn from FEN or 'w' for standard start
  } {
    // Check for inline data delimiter
    const dataDelimiter = '<!--chess-data-->';
    let pgnSource: string;
    let inlineData: InlineBoardData = {};
    
    const delimiterIndex = source.indexOf(dataDelimiter);
    if (delimiterIndex !== -1) {
      pgnSource = source.substring(0, delimiterIndex).trim();
      const dataSection = source.substring(delimiterIndex + dataDelimiter.length).trim();
      
      // Try to parse the JSON data
      try {
        if (dataSection) {
          inlineData = JSON.parse(dataSection);
        }
      } catch (e) {
        console.warn('Chess plugin: Failed to parse inline data:', e);
      }
    } else {
      // No delimiter - entire source is PGN, trim it for consistency
      pgnSource = source.trim();
    }
    
    const trimmed = pgnSource; // Already trimmed above
    
    if (trimmed.includes('/') && !trimmed.includes('[')) {
      // Parse FEN - extract turn from FEN string (second field after the position)
      const fenParts = trimmed.split(/\s+/);
      const initialTurn: 'w' | 'b' = (fenParts.length > 1 && fenParts[1] === 'b') ? 'b' : 'w';
      
      return {
        board: this.parseFEN(trimmed),
        moveHistory: [],
        pgnData: {},
        timestamps: [],
        whiteElo: null,
        blackElo: null,
        whiteName: null,
        blackName: null,
        inlineData,
        pgnSource,
        initialTurn
      };
    }
    
    const { tags, moves, timestamps, hasClockData } = this.parsePGN(trimmed);
    return {
      board: this.getInitialBoard(),
      moveHistory: moves,
      pgnData: tags,
      timestamps: hasClockData ? timestamps : [], // Only include timestamps if actual clock data exists
      whiteElo: tags.WhiteElo || null,
      blackElo: tags.BlackElo || null,
      whiteName: tags.White || null,
      blackName: tags.Black || null,
      inlineData,
      pgnSource,
      initialTurn: 'w' // Standard starting position is always white to move
    };
  }

  parsePGN(pgn: string): { 
    tags: { [key: string]: string }, 
    moves: string[],
    timestamps: { white: string, black: string }[],
    hasClockData: boolean // New flag to indicate if real clock data was found
  } {
    const lines = pgn.split('\n');
    const tags: { [key: string]: string } = {};
    const moves: string[] = [];
    const timestamps: { white: string, black: string }[] = [];
    let moveText = '';

    // Extract tags
    for (const line of lines) {
      const trimmed = line.trim();
      
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        const match = trimmed.match(/\[(\w+)\s+"(.+?)"\]/);
        if (match) {
          tags[match[1]] = match[2];
        }
      } else if (trimmed && !trimmed.startsWith('[')) {
        moveText += ' ' + trimmed;
      }
    }

    moveText = moveText.trim();
    
    // Remove result indicators (at end of game) - handle with or without leading space
    moveText = moveText.replace(/\s*(1-0|0-1|1\/2-1\/2|\*)\s*$/, '');
    
    // Extract clock times first (before removing annotations)
    const clockTimes: string[] = [];
    const clkMatches = [...moveText.matchAll(/\[%clk\s+([\d:\.]+)\]/g)];
    clkMatches.forEach(match => clockTimes.push(match[1]));
    
    // Track if we actually found clock data in the PGN
    const hasClockData = clockTimes.length > 0;
    
    // Remove all curly brace comments (including timestamps, eval, etc.)
    moveText = moveText.replace(/\{[^}]*\}/g, ' ');
    
    // Remove variations in parentheses (handle nested parentheses)
    let prevLength;
    do {
      prevLength = moveText.length;
      moveText = moveText.replace(/\([^()]*\)/g, ' ');
    } while (moveText.length !== prevLength);
    
    // Remove NAGs (Numeric Annotation Glyphs like $1, $2, etc.)
    moveText = moveText.replace(/\$\d+/g, ' ');
    
    // Remove ALL square bracket annotations ([%eval ...], [%clk ...], etc.)
    moveText = moveText.replace(/\[%[^\]]*\]/g, ' ');
    
    // Remove annotation symbols at the end of moves but keep the move
    // Handle moves like Qe8+??, Bxf2+?!, etc. (annotation after check/checkmate symbols)
    moveText = moveText.replace(/([NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=[NBRQ])?[+#]?|O-O(?:-O)?[+#]?)[!?]+/g, '$1');
    
    // Normalize whitespace
    moveText = moveText.replace(/\s+/g, ' ').trim();
    
    // Get initial time from TimeControl or default to 10 minutes
    const timeControl = tags.TimeControl || '600';
    const initialSeconds = parseInt(timeControl.split('+')[0]) || 600;
    const initialTime = this.formatTimeFromSeconds(initialSeconds);
    
    // timestamps array structure:
    // timestamps[0] = initial position (both players start with full time)
    // timestamps[i] = state after move (i-1), where i is 1-indexed
    // So timestamps[1] has times after move 0, timestamps[2] after move 1, etc.
    
    // Only populate timestamps if we have actual clock data
    if (hasClockData) {
      // Start with initial state
      timestamps.push({ white: initialTime, black: initialTime });
      
      // Current times being built (start with initial)
      let currentWhiteTime = initialTime;
      let currentBlackTime = initialTime;
    
      // Parse moves and timestamps together when we have clock data
      const tokens = moveText.split(/\s+/);
      let clockIndex = 0;
      
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        
        // Skip move numbers (e.g., "1.", "2.", "1...", "2...", etc.)
        // This handles both white move numbers (1.) and black move numbers (1...)
        if (/^\d+\.+$/.test(token)) {
          continue;
        }
        
        // Skip ellipsis (used for black's move when white's is omitted)
        if (token === '...' || token === '…') {
          continue;
        }
        
        // Check if this is a valid chess move
        // Handles: e4, Nf3, Nbd7, N1c3, exd5, Qh4+, O-O, O-O-O, e8=Q, e8=Q+, etc.
        if (/^([NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=[NBRQ])?[+#]?|O-O(?:-O)?[+#]?)$/.test(token)) {
          moves.push(token);
          const moveIndex = moves.length - 1; // 0-indexed move number
          
          // Update the time for the player who just moved
          if (clockIndex < clockTimes.length) {
            const timeAfterMove = clockTimes[clockIndex];
            
            if (moveIndex % 2 === 0) {
              // White just moved (moves 0, 2, 4, ...)
              currentWhiteTime = timeAfterMove;
            } else {
              // Black just moved (moves 1, 3, 5, ...)
              currentBlackTime = timeAfterMove;
            }
            clockIndex++;
          }
          
          // After each move, add a timestamp entry with current times
          timestamps.push({ 
            white: currentWhiteTime, 
            black: currentBlackTime 
          });
        }
      }
    } else {
      // No clock data - just parse moves without timestamps
      const tokens = moveText.split(/\s+/);
      
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        
        // Skip move numbers
        if (/^\d+\.+$/.test(token)) {
          continue;
        }
        
        // Skip ellipsis
        if (token === '...' || token === '…') {
          continue;
        }
        
        // Check if this is a valid chess move
        if (/^([NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](?:=[NBRQ])?[+#]?|O-O(?:-O)?[+#]?)$/.test(token)) {
          moves.push(token);
        }
      }
    }

    return { tags, moves, timestamps, hasClockData };
  }

  formatTimeFromSeconds(totalSeconds: number): string {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    } else {
      return `${minutes}:${seconds.toString().padStart(2, '0')}`;
    }
  }

  parseClockTime(timeStr: string): number {
    // Parse time string like "0:09:56.6" or "9:56.6" into seconds
    const parts = timeStr.split(':');
    if (parts.length === 3) {
      // H:MM:SS.s format
      const hours = parseInt(parts[0]);
      const minutes = parseInt(parts[1]);
      const seconds = parseFloat(parts[2]);
      return hours * 3600 + minutes * 60 + seconds;
    } else if (parts.length === 2) {
      // M:SS.s format (no hours)
      const minutes = parseInt(parts[0]);
      const seconds = parseFloat(parts[1]);
      return minutes * 60 + seconds;
    }
    return 0;
  }

  formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
      return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  getInitialBoard(): (string | null)[][] {
    return [
      ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'],
      ['p', 'p', 'p', 'p', 'p', 'p', 'p', 'p'],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P'],
      ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R']
    ];
  }

  parseFEN(fen: string): (string | null)[][] {
    const parts = fen.split(' ');
    const position = parts[0];
    const rows = position.split('/');
    const board: (string | null)[][] = [];

    for (const row of rows) {
      const boardRow: (string | null)[] = [];
      for (const char of row) {
        if (char >= '1' && char <= '8') {
          const emptySquares = parseInt(char);
          for (let i = 0; i < emptySquares; i++) {
            boardRow.push(null);
          }
        } else {
          boardRow.push(char);
        }
      }
      board.push(boardRow);
    }

    return board;
  }

  boardToFEN(board: (string | null)[][], turn: 'w' | 'b' = 'w'): string {
    let fen = '';
    for (const row of board) {
      let emptyCount = 0;
      for (const square of row) {
        if (square === null) {
          emptyCount++;
        } else {
          if (emptyCount > 0) {
            fen += emptyCount;
            emptyCount = 0;
          }
          fen += square;
        }
      }
      if (emptyCount > 0) {
        fen += emptyCount;
      }
      fen += '/';
    }
    return fen.slice(0, -1) + ` ${turn} - - 0 1`;
  }

  applyMove(
    board: (string | null)[][], 
    move: string, 
    trackSquares: boolean,
    moveHistory: string[],
    moveIndex: number
  ): { board: (string | null)[][], moveSquares: { from: number[], to: number[] } | null } {
    const newBoard = board.map(row => [...row]);
    const originalMove = move;
    
    // Remove check/checkmate indicators and annotations
    move = move.replace(/[+#!?]/g, '');
    
    // Castling
    if (move === 'O-O' || move === 'O-O-O') {
      const isWhite = moveIndex % 2 === 0;
      const row = isWhite ? 7 : 0;
      
      if (move === 'O-O') {
        // Kingside
        newBoard[row][6] = newBoard[row][4];
        newBoard[row][5] = newBoard[row][7];
        newBoard[row][4] = null;
        newBoard[row][7] = null;
        return { board: newBoard, moveSquares: trackSquares ? { from: [row, 4], to: [row, 6] } : null };
      } else {
        // Queenside
        newBoard[row][2] = newBoard[row][4];
        newBoard[row][3] = newBoard[row][0];
        newBoard[row][4] = null;
        newBoard[row][0] = null;
        return { board: newBoard, moveSquares: trackSquares ? { from: [row, 4], to: [row, 2] } : null };
      }
    }

    // Parse regular move
    const isWhite = moveIndex % 2 === 0;
    let piece = 'p';
    let fromFile: string | null = null;
    let fromRank: number | null = null;
    let toFile: string;
    let toRank: number;
    let isCapture = move.includes('x');
    let promotion: string | null = null;

    // Remove 'x' for capture
    move = move.replace('x', '');

    // Check for piece letter at start
    if (move.length > 0 && move[0] >= 'A' && move[0] <= 'Z') {
      piece = move[0].toLowerCase();
      move = move.substring(1);
    }

    // Check for promotion
    if (move.includes('=')) {
      const parts = move.split('=');
      promotion = parts[1].toLowerCase();
      move = parts[0];
    }

    // Now move should be: [disambiguation][destination]
    // Destination is always the last 2 characters
    if (move.length < 2) {
      console.warn(`Invalid move format: ${originalMove}`);
      return { board: newBoard, moveSquares: null };
    }
    
    toFile = move[move.length - 2];
    toRank = parseInt(move[move.length - 1]);
    
    if (toFile < 'a' || toFile > 'h' || isNaN(toRank) || toRank < 1 || toRank > 8) {
      console.warn(`Invalid destination in move: ${originalMove}`);
      return { board: newBoard, moveSquares: null };
    }
    
    move = move.substring(0, move.length - 2);

    // Remaining characters are disambiguation
    if (move.length > 0) {
      for (const char of move) {
        if (char >= 'a' && char <= 'h') {
          fromFile = char;
        } else if (char >= '1' && char <= '8') {
          fromRank = parseInt(char);
        }
      }
    }

    const toCol = toFile.charCodeAt(0) - 'a'.charCodeAt(0);
    const toRow = 8 - toRank;

    // Compute en passant square from previous move
    let enPassantCol: number | null = null;
    if (moveIndex > 0 && piece === 'p' && isCapture) {
      const prevMove = moveHistory[moveIndex - 1].replace(/[+#!?x]/g, '');
      // Check if previous move was a 2-square pawn move
      if (prevMove.length === 2 && prevMove[0] >= 'a' && prevMove[0] <= 'h') {
        const prevToRank = parseInt(prevMove[1]);
        const prevToCol = prevMove[0].charCodeAt(0) - 'a'.charCodeAt(0);
        // White pawns go from rank 2 to rank 4, black from rank 7 to rank 5
        const prevIsWhite = (moveIndex - 1) % 2 === 0;
        if ((prevIsWhite && prevToRank === 4) || (!prevIsWhite && prevToRank === 5)) {
          enPassantCol = prevToCol;
        }
      }
    }

    // Find the piece that can make this move
    const targetPiece = isWhite ? piece.toUpperCase() : piece.toLowerCase();
    let foundFrom: { r: number, c: number } | null = null;
    
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (newBoard[r][c] !== targetPiece) continue;
        
        // Check disambiguation
        if (fromFile !== null && c !== fromFile.charCodeAt(0) - 'a'.charCodeAt(0)) continue;
        if (fromRank !== null && r !== 8 - fromRank) continue;
        
        // Check if this piece can legally move to the target
        if (this.canPieceMove(piece, r, c, toRow, toCol, isCapture, newBoard, isWhite, enPassantCol)) {
          foundFrom = { r, c };
          break;
        }
      }
      if (foundFrom) break;
    }

    if (foundFrom) {
      const { r, c } = foundFrom;
      const moveSquares = trackSquares ? { from: [r, c], to: [toRow, toCol] } : null;
      
      // Handle en passant capture
      if (piece === 'p' && isCapture && newBoard[toRow][toCol] === null) {
        // This is en passant - remove the captured pawn
        const capturedPawnRow = isWhite ? toRow + 1 : toRow - 1;
        newBoard[capturedPawnRow][toCol] = null;
      }
      
      // Make the move
      newBoard[toRow][toCol] = promotion ? (isWhite ? promotion.toUpperCase() : promotion.toLowerCase()) : newBoard[r][c];
      newBoard[r][c] = null;
      return { board: newBoard, moveSquares };
    }

    // Fallback: no valid move found
    console.warn(`Could not find piece for move: ${originalMove} (piece=${piece}, to=${toFile}${toRank}, isWhite=${isWhite})`);
    return { board: newBoard, moveSquares: null };
  }

  canPieceMove(piece: string, fromR: number, fromC: number, toR: number, toC: number, isCapture: boolean, board: (string | null)[][], isWhite: boolean, enPassantCol: number | null): boolean {
    const target = board[toR][toC];
    
    // Can't capture your own piece
    if (target !== null) {
      const targetIsWhite = target === target.toUpperCase();
      if (targetIsWhite === isWhite) return false;
    }
    
    // Note: We don't strictly enforce that captures must have a target piece
    // because the board state might be out of sync if previous moves failed.
    // The PGN is authoritative about whether a move is a capture.

    switch (piece) {
      case 'p': {
        const dir = isWhite ? -1 : 1;
        const startRow = isWhite ? 6 : 1;
        
        if (isCapture) {
          // Diagonal capture - just check the geometry
          if (toR === fromR + dir && Math.abs(toC - fromC) === 1) {
            return true; // Trust the PGN that this is a valid capture
          }
          return false;
        } else {
          // Forward move (non-capture)
          if (toC !== fromC) return false;
          if (target !== null) return false;
          if (toR === fromR + dir) return true;
          if (fromR === startRow && toR === fromR + 2 * dir && board[fromR + dir][toC] === null) return true;
          return false;
        }
      }
      
      case 'n': {
        const dr = Math.abs(toR - fromR);
        const dc = Math.abs(toC - fromC);
        return (dr === 2 && dc === 1) || (dr === 1 && dc === 2);
      }
      
      case 'k': {
        return Math.abs(toR - fromR) <= 1 && Math.abs(toC - fromC) <= 1;
      }
      
      case 'b': {
        // Must move diagonally
        if (Math.abs(toR - fromR) !== Math.abs(toC - fromC)) return false;
        if (toR === fromR) return false;
        return this.isPathClear(fromR, fromC, toR, toC, board);
      }
      
      case 'r': {
        // Must move in straight line
        if (toR !== fromR && toC !== fromC) return false;
        if (toR === fromR && toC === fromC) return false;
        return this.isPathClear(fromR, fromC, toR, toC, board);
      }
      
      case 'q': {
        // Can move like bishop or rook
        const isDiagonal = Math.abs(toR - fromR) === Math.abs(toC - fromC);
        const isStraight = toR === fromR || toC === fromC;
        if (!isDiagonal && !isStraight) return false;
        if (toR === fromR && toC === fromC) return false;
        return this.isPathClear(fromR, fromC, toR, toC, board);
      }
    }
    
    return false;
  }

  isPathClear(fromR: number, fromC: number, toR: number, toC: number, board: (string | null)[][]): boolean {
    const dr = toR > fromR ? 1 : toR < fromR ? -1 : 0;
    const dc = toC > fromC ? 1 : toC < fromC ? -1 : 0;
    
    let r = fromR + dr;
    let c = fromC + dc;
    
    while (r !== toR || c !== toC) {
      if (r < 0 || r >= 8 || c < 0 || c >= 8) return false;
      if (board[r][c] !== null) return false;
      r += dr;
      c += dc;
    }
    
    return true;
  }

  // Keep the old canMoveTo for the interactive move validation (getLegalMoves uses it)
  canMoveTo(piece: string, fromR: number, fromC: number, toR: number, toC: number, capture: boolean, board: (string | null)[][], enPassantSquare: [number, number] | null = null): boolean {
    const p = piece.toLowerCase();
    const isWhite = piece === piece.toUpperCase();

    if (p === 'p') {
      const dir = isWhite ? -1 : 1;
      const startRow = isWhite ? 6 : 1;
      
      if (capture) {
        // Normal capture or en passant
        if (toR === fromR + dir && Math.abs(toC - fromC) === 1) {
          // Check if there's a piece to capture or if this is en passant
          const targetPiece = board[toR][toC];
          if (targetPiece !== null) {
            return true; // Normal capture
          }
          // Check for en passant
          if (enPassantSquare && enPassantSquare[0] === toR && enPassantSquare[1] === toC) {
            return true; // En passant capture
          }
        }
        return false;
      }
      if (toC !== fromC) return false;
      if (toR === fromR + dir && board[toR][toC] === null) return true;
      if (fromR === startRow && toR === fromR + 2 * dir && board[toR][toC] === null && board[fromR + dir][toC] === null) return true;
      return false;
    }

    if (p === 'n') {
      const dr = Math.abs(toR - fromR);
      const dc = Math.abs(toC - fromC);
      return (dr === 2 && dc === 1) || (dr === 1 && dc === 2);
    }

    if (p === 'k') {
      return Math.abs(toR - fromR) <= 1 && Math.abs(toC - fromC) <= 1;
    }

    // Bishop, Rook, Queen - check path is clear
    if (p === 'b' || p === 'r' || p === 'q') {
      const dr = toR > fromR ? 1 : toR < fromR ? -1 : 0;
      const dc = toC > fromC ? 1 : toC < fromC ? -1 : 0;
      
      // Bishop must move diagonally
      if (p === 'b') {
        if (dr === 0 || dc === 0) return false;
        if (Math.abs(toR - fromR) !== Math.abs(toC - fromC)) return false;
      }
      // Rook must move straight
      if (p === 'r' && dr !== 0 && dc !== 0) return false;
      
      let r = fromR + dr;
      let c = fromC + dc;
      
      while (r !== toR || c !== toC) {
        if (r < 0 || r >= 8 || c < 0 || c >= 8) return false;
        if (board[r][c] !== null) return false;
        r += dr;
        c += dc;
      }
      
      return true;
    }

    return false;
  }

  getPieceSymbol(piece: string): string {
    const symbols: { [key: string]: string } = {
      'r': '♜', 'n': '♞', 'b': '♝', 'q': '♛', 'k': '♚', 'p': '♟',
      'R': '♖', 'N': '♘', 'B': '♗', 'Q': '♕', 'K': '♔', 'P': '♙'
    };
    return symbols[piece] || piece;
  }

  getPieceName(piece: string): string {
    const names: { [key: string]: string } = {
      'k': 'king',
      'q': 'queen',
      'r': 'rook',
      'b': 'bishop',
      'n': 'knight',
      'p': 'pawn'
    };
    return names[piece.toLowerCase()] || 'pawn';
  }

  algebraicToCoords(square: string): [number, number] | null {
    if (square.length !== 2) return null;
    const file = square.charCodeAt(0) - 'a'.charCodeAt(0);
    const rank = 8 - parseInt(square[1]);
    if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
    return [rank, file];
  }

  coordsToAlgebraic(row: number, col: number): string {
    const file = String.fromCharCode('a'.charCodeAt(0) + col);
    const rank = (8 - row).toString();
    return file + rank;
  }

  hashCode(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
    
    // Migrate from old data.json format if needed
    if (data?.boardData) {
      await this.migrateFromLegacyData(data.boardData);
    }
    
    // Migrate from localStorage if data exists there (one-time migration)
    await this.migrateFromLocalStorage();
  }

  async saveSettings() {
    await this.saveData({ settings: this.settings });
  }
  
  // Load board data from individual file
  async loadBoardData(boardId: string): Promise<BoardFileData> {
    // Check cache first
    if (this.boardDataCache.has(boardId)) {
      return this.boardDataCache.get(boardId)!;
    }
    
    const filePath = this.getBoardFilePath(boardId);
    const adapter = this.app.vault.adapter;
    
    try {
      const exists = await adapter.exists(filePath);
      if (exists) {
        const content = await adapter.read(filePath);
        const data = JSON.parse(content) as BoardFileData;
        this.boardDataCache.set(boardId, data);
        return data;
      }
    } catch (e) {
      console.error(`Chess plugin: Error loading board data for ${boardId}:`, e);
    }
    
    // Return empty data if file doesn't exist or error
    const emptyData: BoardFileData = {};
    this.boardDataCache.set(boardId, emptyData);
    return emptyData;
  }
  
  // Save board data inline to the code block source
  async saveBoardData(boardId: string): Promise<void> {
    const data = this.boardDataCache.get(boardId);
    if (!data) {
      return;
    }
    
    // Check if data has any content worth saving
    const hasAnnotations = data.annotations && Object.keys(data.annotations).length > 0;
    const hasNotes = data.notes && Object.keys(data.notes).length > 0;
    const hasSizes = data.sizes && Object.keys(data.sizes).length > 0;
    
    if (!hasAnnotations && !hasNotes && !hasSizes) {
      return;
    }
    
    // Get context info for this board
    const contextInfo = this.boardContextCache.get(boardId);
    if (!contextInfo) {
      console.error(`Chess plugin: [SAVE FAILED] No context for board ${boardId}`);
      console.error(`Chess plugin: Available boards in cache:`, Array.from(this.boardContextCache.keys()));
      return await this.saveBoardDataToFile(boardId);
    }
    
    const { ctx, pgnSource } = contextInfo;
    const filePath = ctx.sourcePath;
    
    if (!filePath) {
      console.error(`Chess plugin: [SAVE FAILED] No file path in context`);
      return await this.saveBoardDataToFile(boardId);
    }
    
    try {
      // Get the TFile from the vault - try multiple methods
      let file = this.app.vault.getAbstractFileByPath(filePath);
      
      if (!file) {
        // Try with .md extension if not present
        if (!filePath.endsWith('.md')) {
          file = this.app.vault.getAbstractFileByPath(filePath + '.md');
        }
      }
      
      if (!file) {
        console.error(`Chess plugin: [SAVE FAILED] Could not find file: ${filePath}`);
        return await this.saveBoardDataToFile(boardId);
      }
      
      // Verify it's a file not a folder (TFile has 'basename', TFolder doesn't)
      if (!('basename' in file)) {
        console.error(`Chess plugin: [SAVE FAILED] Path is a folder, not a file: ${filePath}`);
        return await this.saveBoardDataToFile(boardId);
      }
      
      // Read current file content
      const content = await this.app.vault.read(file as any);
      
      // Prepare data delimiter
      const dataDelimiter = '<!--chess-data-->';
      
      // Normalize pgnSource for comparison (handle line endings and whitespace)
      const normalizePgn = (s: string): string => {
        return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
      };
      const normalizedPgnSource = normalizePgn(pgnSource);
      
      // Find all chess code blocks - use multiple patterns to handle different formats
      // IMPORTANT: There may be a space between ``` and chess (``` chess vs ```chess)
      let matches: Array<{full: string, content: string, start: number, end: number}> = [];
      
      // Pattern: 3 backticks, optional space, "chess", optional whitespace, newline, content, 3 backticks
      // This handles both ```chess and ``` chess
      let codeBlockPattern = /```\s*chess\s*\n([\s\S]*?)```/g;
      let match;
      while ((match = codeBlockPattern.exec(content)) !== null) {
        matches.push({
          full: match[0],
          content: match[1],
          start: match.index,
          end: match.index + match[0].length
        });
      }
      
      // Try pattern 2: With \r\n line endings  
      if (matches.length === 0) {
        codeBlockPattern = /```\s*chess\s*\r\n([\s\S]*?)```/g;
        while ((match = codeBlockPattern.exec(content)) !== null) {
          matches.push({
            full: match[0],
            content: match[1],
            start: match.index,
            end: match.index + match[0].length
          });
        }
      }
      
      // Try pattern 3: Handle any whitespace after chess including \r\n
      if (matches.length === 0) {
        codeBlockPattern = /```\s*chess[\s]*([\s\S]*?)```/g;
        while ((match = codeBlockPattern.exec(content)) !== null) {
          // Skip the leading whitespace in the content
          let contentText = match[1];
          if (contentText.startsWith('\n')) contentText = contentText.substring(1);
          if (contentText.startsWith('\r\n')) contentText = contentText.substring(2);
          matches.push({
            full: match[0],
            content: contentText,
            start: match.index,
            end: match.index + match[0].length
          });
        }
      }
      
      if (matches.length === 0) {
        console.error(`Chess plugin: [SAVE FAILED] No chess code blocks found in file`);
        return await this.saveBoardDataToFile(boardId);
      }
      
      let foundMatch = false;
      let newContent = content;
      
      for (const m of matches) {
        const blockContent = m.content;
        
        // Extract the PGN part (before any existing data delimiter)
        let blockPgn = blockContent;
        const delimIdx = blockContent.indexOf(dataDelimiter);
        if (delimIdx !== -1) {
          blockPgn = blockContent.substring(0, delimIdx);
        }
        
        // Normalize and compare
        const normalizedBlockPgn = normalizePgn(blockPgn);
        
        if (normalizedBlockPgn === normalizedPgnSource) {
          // Found the matching block!
          foundMatch = true;
          
          // Build the new block content
          const jsonData = JSON.stringify(data);
          const newBlockContent = normalizedPgnSource + '\n' + dataDelimiter + '\n' + jsonData;
          const newBlock = '```chess\n' + newBlockContent + '\n```';
          
          // Replace in content
          newContent = content.substring(0, m.start) + newBlock + content.substring(m.end);
          break;
        }
      }
      
      if (foundMatch) {
        if (newContent !== content) {
          // Actually write the changes
          await this.app.vault.modify(file as any, newContent);
        }
        // Success - don't fall back to file save
        return;
      } else {
        // Could not find matching code block
        console.error(`Chess plugin: [SAVE FAILED] No matching chess code block found`);
        return await this.saveBoardDataToFile(boardId);
      }
      
    } catch (e) {
      console.error(`Chess plugin: [SAVE FAILED] Error:`, e);
      return await this.saveBoardDataToFile(boardId);
    }
  }
  
  // Legacy file-based save - DEPRECATED, only used as absolute last resort
  // This should NOT be called in normal operation - data should save inline
  async saveBoardDataToFile(boardId: string): Promise<void> {
    console.error(`Chess plugin: FALLING BACK TO FILE SAVE for ${boardId} - this indicates inline save failed!`);
    
    const data = this.boardDataCache.get(boardId);
    if (!data) return;
    
    // Don't save if data is empty
    if (!data.sizes && !data.annotations && !data.notes) return;
    if (Object.keys(data.sizes || {}).length === 0 && 
        Object.keys(data.annotations || {}).length === 0 && 
        Object.keys(data.notes || {}).length === 0) return;
    
    const filePath = this.getBoardFilePath(boardId);
    const adapter = this.app.vault.adapter;
    
    try {
      await this.ensureAnnotationsFolder();
      await adapter.write(filePath, JSON.stringify(data, null, 2));
      console.error(`Chess plugin: Data saved to ${filePath} - please report this as a bug`);
    } catch (e) {
      console.error(`Chess plugin: Even file save failed for ${boardId}:`, e);
    }
  }
  
  // Debounced save for a specific board
  queueSaveBoardData(boardId: string) {
    // Clear existing timeout for this board
    const existingTimeout = this.saveTimeouts.get(boardId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }
    
    // Set new timeout - 100ms to batch nearly-simultaneous changes without noticeable delay
    const timeout = setTimeout(async () => {
      // Find all scroll containers and save their positions JUST before save
      const scrollContainers = document.querySelectorAll('.markdown-preview-view, .markdown-source-view, .cm-scroller');
      const savedScrollPositions: { el: Element, top: number }[] = [];
      scrollContainers.forEach(el => {
        savedScrollPositions.push({ el, top: el.scrollTop });
      });
      
      // Save move list scroll positions to the persistent cache
      // This allows the scroll position to survive re-renders
      const boardContainer = document.querySelector(`[data-board-id="${boardId}"]`);
      if (boardContainer) {
        const moveList = boardContainer.querySelector('.chess-moves');
        if (moveList) {
          this.moveListScrollCache.set(boardId, moveList.scrollTop);
        }
      }
      
      // Also save move list scroll positions for all chess boards (legacy approach for immediate restore)
      const moveListContainers = document.querySelectorAll('.chess-moves');
      const savedMoveListScrolls: { el: Element, top: number }[] = [];
      moveListContainers.forEach(el => {
        savedMoveListScrolls.push({ el, top: el.scrollTop });
      });
      
      // Set suppressBlur flag to prevent textarea blur from triggering during save
      // This prevents the edit mode from closing when the save causes DOM changes
      this.suppressBlur.set(boardId, true);
      
      await this.saveBoardData(boardId);
      this.saveTimeouts.delete(boardId);
      
      // Clear suppressBlur after a short delay to allow DOM to settle
      setTimeout(() => {
        this.suppressBlur.delete(boardId);
      }, 100);
      
      // Restore scroll positions after save - use multiple attempts
      // to handle any re-renders that might happen
      const restoreScrolls = () => {
        savedScrollPositions.forEach(({ el, top }) => {
          if (el.isConnected) {
            el.scrollTop = top;
          }
        });
        savedMoveListScrolls.forEach(({ el, top }) => {
          if (el.isConnected) {
            el.scrollTop = top;
          }
        });
        
        // Also restore from cache for newly created elements
        const newBoardContainer = document.querySelector(`[data-board-id="${boardId}"]`);
        if (newBoardContainer) {
          const newMoveList = newBoardContainer.querySelector('.chess-moves');
          const cachedScroll = this.moveListScrollCache.get(boardId);
          if (newMoveList && cachedScroll !== undefined) {
            newMoveList.scrollTop = cachedScroll;
          }
        }
      };
      
      // Restore immediately
      restoreScrolls();
      
      // And after potential re-renders
      requestAnimationFrame(() => {
        restoreScrolls();
        setTimeout(restoreScrolls, 50);
        setTimeout(restoreScrolls, 150);
        setTimeout(restoreScrolls, 300);
      });
    }, 100); // Save after 100ms - just enough to batch simultaneous changes
    
    this.saveTimeouts.set(boardId, timeout);
  }
  
  // Migrate from legacy data.json format to individual files
  async migrateFromLegacyData(legacyData: LegacyChessBoardData) {
    try {
      let migrated = false;
      const boardIds = new Set([
        ...Object.keys(legacyData.sizes || {}),
        ...Object.keys(legacyData.annotations || {}),
        ...Object.keys(legacyData.notes || {})
      ]);
      
      for (const boardId of boardIds) {
        const filePath = this.getBoardFilePath(boardId);
        const adapter = this.app.vault.adapter;
        
        // Only migrate if the individual file doesn't exist yet
        const exists = await adapter.exists(filePath);
        if (!exists) {
          const boardData: BoardFileData = {
            sizes: legacyData.sizes?.[boardId],
            annotations: legacyData.annotations?.[boardId],
            notes: legacyData.notes?.[boardId]
          };
          
          // Only save if there's actual data
          if (boardData.sizes || boardData.annotations || boardData.notes) {
            this.boardDataCache.set(boardId, boardData);
            await this.saveBoardData(boardId);
            migrated = true;
          }
        }
      }
      
      if (migrated) {
        // Remove legacy boardData from data.json
        await this.saveData({ settings: this.settings });
        console.warn('Chess plugin: Migrated legacy data to individual annotation files');
      }
    } catch (e) {
      console.error('Chess plugin: Error during legacy data migration:', e);
    }
  }
  
  // One-time migration from localStorage to individual files
  async migrateFromLocalStorage() {
    try {
      let migrated = false;

      // Collect all data from localStorage
      const sizesData = this.app.loadLocalStorage('chess-board-sizes');
      const annotationsData = this.app.loadLocalStorage('chess-board-annotations');
      const notesData = this.app.loadLocalStorage('chess-board-notes');

      const sizes = sizesData ? JSON.parse(sizesData) : {};
      const annotations = annotationsData ? JSON.parse(annotationsData) : {};
      const notes = notesData ? JSON.parse(notesData) : {};

      const boardIds = new Set([
        ...Object.keys(sizes),
        ...Object.keys(annotations),
        ...Object.keys(notes)
      ]);

      for (const boardId of boardIds) {
        const filePath = this.getBoardFilePath(boardId);
        const adapter = this.app.vault.adapter;

        // Only migrate if the individual file doesn't exist yet
        const exists = await adapter.exists(filePath);
        if (!exists) {
          const boardData: BoardFileData = {
            sizes: sizes[boardId],
            annotations: annotations[boardId],
            notes: notes[boardId]
          };

          if (boardData.sizes || boardData.annotations || boardData.notes) {
            this.boardDataCache.set(boardId, boardData);
            await this.saveBoardData(boardId);
            migrated = true;
          }
        }
      }

      if (migrated) {
        // Clear localStorage after successful migration
        this.app.saveLocalStorage('chess-board-sizes', null);
        this.app.saveLocalStorage('chess-board-annotations', null);
        this.app.saveLocalStorage('chess-board-notes', null);
        console.warn('Chess plugin: Migrated data from localStorage to individual annotation files');
      }
    } catch (e) {
      console.error('Chess plugin: Error during localStorage migration:', e);
    }
  }

  loadBoardSizes(boardId: string): { boardWidth?: number, infoWidth?: number, totalHeight?: number, moveListHeight?: number } {
    const data = this.boardDataCache.get(boardId);
    return data?.sizes || {};
  }

  saveBoardSizes(boardId: string, sizes: { boardWidth: number, infoWidth: number, totalHeight?: number, moveListHeight?: number }) {
    // Ensure move list scroll position is cached (may have already been saved by resize handler)
    const boardContainer = document.querySelector(`[data-board-id="${boardId}"]`);
    if (boardContainer) {
      const moveList = boardContainer.querySelector('.chess-moves');
      if (moveList && !this.moveListScrollCache.has(boardId)) {
        this.moveListScrollCache.set(boardId, moveList.scrollTop);
      }
    }
    
    let data = this.boardDataCache.get(boardId);
    if (!data) {
      data = {};
      this.boardDataCache.set(boardId, data);
    }
    data.sizes = sizes;
    this.queueSaveBoardData(boardId);
  }

  loadBoardAnnotations(boardId: string): { [key: number]: { arrows: { from: [number, number], to: [number, number] }[], highlights: Set<string> } } {
    const data = this.boardDataCache.get(boardId);
    const boardAnnotations = data?.annotations;
    if (boardAnnotations) {
      // Convert highlights arrays back to Sets
      const result: { [key: number]: { arrows: { from: [number, number], to: [number, number] }[], highlights: Set<string> } } = {};
      for (const [key, value] of Object.entries(boardAnnotations)) {
        result[parseInt(key)] = {
          arrows: (value as any).arrows || [],
          highlights: new Set((value as any).highlights || [])
        };
      }
      return result;
    }
    return {};
  }

  saveBoardAnnotations(boardId: string, annotations: { [key: number]: { arrows: { from: [number, number], to: [number, number] }[], highlights: Set<string> } }) {
    // Convert Sets to arrays for JSON serialization
    const serializable: { [key: number]: { arrows: { from: [number, number], to: [number, number] }[], highlights: string[] } } = {};
    for (const [key, value] of Object.entries(annotations)) {
      serializable[parseInt(key)] = {
        arrows: value.arrows,
        highlights: Array.from(value.highlights)
      };
    }
    
    let data = this.boardDataCache.get(boardId);
    if (!data) {
      data = {};
      this.boardDataCache.set(boardId, data);
    }
    data.annotations = serializable;
    this.queueSaveBoardData(boardId);
  }

  loadBoardNotes(boardId: string): { [key: number]: string } {
    const data = this.boardDataCache.get(boardId);
    return data?.notes || {};
  }

  saveBoardNotes(boardId: string, notes: { [key: number]: string }) {
    // Save move list scroll position to cache BEFORE queueing save
    // This ensures the scroll position survives the re-render
    const boardContainer = document.querySelector(`[data-board-id="${boardId}"]`);
    if (boardContainer) {
      const moveList = boardContainer.querySelector('.chess-moves');
      if (moveList) {
        this.moveListScrollCache.set(boardId, moveList.scrollTop);
      }
    }
    
    let data = this.boardDataCache.get(boardId);
    if (!data) {
      data = {};
      this.boardDataCache.set(boardId, data);
    }
    data.notes = notes;
    this.queueSaveBoardData(boardId);
  }

  saveBoardCurrentMove(boardId: string, currentMove: number) {
    // Update in-memory cache (fast, no file I/O)
    this.currentMoveCache.set(boardId, currentMove);
    
    // Also update the data cache so currentMove gets saved when other data is saved
    // But DON'T trigger a file save here - that would cause re-render loops
    let data = this.boardDataCache.get(boardId);
    if (!data) {
      data = {};
      this.boardDataCache.set(boardId, data);
    }
    data.currentMove = currentMove;
    // Note: No queueSaveBoardData call here - currentMove will be saved when annotations/notes/sizes are saved
  }

  saveBoardFlipped(boardId: string, flipped: boolean) {
    let data = this.boardDataCache.get(boardId);
    if (!data) {
      data = {};
      this.boardDataCache.set(boardId, data);
    }
    data.flipped = flipped;
    this.queueSaveBoardData(boardId);
  }
}

class ChessSettingTab extends PluginSettingTab {
  plugin: ChessPlugin;

  constructor(app: App, plugin: ChessPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const {containerEl} = this;
    containerEl.empty();
    
    new Setting(containerEl)
      .setName('Default board orientation')
      .setDesc('Start with board flipped')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.defaultFlipped)
        .onChange(async (value) => {
          this.plugin.settings.defaultFlipped = value;
          await this.plugin.saveSettings();
        }));
    
    new Setting(containerEl)
      .setName('Default board size')
      .setDesc('Default size for chess boards (300-800px)')
      .addSlider(slider => slider
        .setLimits(300, 800, 50)
        .setValue(this.plugin.settings.defaultBoardSize)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.defaultBoardSize = value;
          await this.plugin.saveSettings();
        }));
    
    new Setting(containerEl)
      .setName('Move animation duration')
      .setDesc('Duration of piece movement animation in milliseconds (0 to disable)')
      .addSlider(slider => slider
        .setLimits(0, 500, 50)
        .setValue(this.plugin.settings.animationDuration)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.animationDuration = value;
          await this.plugin.saveSettings();
        }));
    
    new Setting(containerEl)
      .setName('Engine analysis')
      .setHeading();

    new Setting(containerEl)
      .setName('Enable engine analysis')
      .setDesc('Show evaluation bar and best move suggestions (requires internet for first load)')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableEngine)
        .onChange(async (value) => {
          this.plugin.settings.enableEngine = value;
          await this.plugin.saveSettings();
        }));
    
    new Setting(containerEl)
      .setName('Engine depth')
      .setDesc('Analysis depth (higher = stronger but slower, 12-20 recommended)')
      .addSlider(slider => slider
        .setLimits(8, 24, 2)
        .setValue(this.plugin.settings.engineDepth)
        .setDynamicTooltip()
        .onChange(async (value) => {
          this.plugin.settings.engineDepth = value;
          await this.plugin.saveSettings();
        }));
  }
}