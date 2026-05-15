import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RangeInput } from '@/components/ui/range-input';
import { useShortcuts } from '@/hooks/viewer/useShortcuts';
import { useViewerSettings } from '@/hooks/viewer/useViewerSettings';
import type { ShortcutActionKey } from '@/store/slices/viewer/shortcutsSlice';
import { CheckCircle2, XCircle } from 'lucide-react';
import React, { useState, useEffect } from 'react';

type SettingsSubmenu = 'general' | 'pathlearn';

const SidebarPrefs = () => {
    const [isElectron, setIsElectron] = useState(false);
    const [submenu, setSubmenu] = useState<SettingsSubmenu>('general');

    useEffect(() => {
        if (typeof window !== 'undefined' && (window as any).electron) {
            setIsElectron(true);
        }
    }, []);
    const {
        zoomSpeed,
        centroidSize,
        overlayAlpha,
        centroidThreshold,
        trackpadGesture,
        highlightGtAnnotations,
        enableMouseTracking,
        enableViewportHistory,
        handleZoomSpeedChange,
        handleCentroidSizeChange,
        handleOverlayAlphaChange,
        handleCentroidThresholdChange,
        toggleTrackpadGesture,
        toggleHighlightGt,
        toggleMouseTracking,
        toggleViewportHistory,
        resetToDefaults,
        DEFAULT_SETTINGS
    } = useViewerSettings();

    return (
        <div className="flex flex-col justify-between h-full w-full overflow-hidden rounded-lg">
            {/* Fixed Header */}
            <div className="bg-card border-b border-border h-8 flex items-center justify-center">
                <span className="font-medium text-sm text-foreground">Preferences</span>
            </div>

            {/* Submenu: General | PathLearn (PathLearn only in Electron) */}
            {isElectron && (
            <div className="flex border-b border-border bg-background">
                <button
                    type="button"
                    onClick={() => setSubmenu('general')}
                    className={`flex-1 py-2 text-xs font-medium transition-colors border-b-2 ${submenu === 'general' ? 'bg-transparent text-foreground/80 border-primary' : 'border-transparent bg-transparent text-foreground hover:bg-foreground/10'}`}
                >
                    General
                </button>
                <button
                    type="button"
                    onClick={() => setSubmenu('pathlearn')}
                    className={`flex-1 py-2 text-xs font-medium transition-colors border-b-2 ${submenu === 'pathlearn' ? 'bg-transparent text-foreground/80 border-primary' : 'border-transparent bg-transparent text-foreground hover:bg-foreground/10'}`}
                >
                    PathLearn
                </button>
            </div>
            )}

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto bg-background p-2">
                <div className="flex flex-row gap-2">
                    {(submenu === 'general' || !isElectron) && (
                    <Card className="w-[280px]">
                        <CardHeader className="p-2 pb-2">
                            <CardTitle className="text-sm">General Settings</CardTitle>
                        </CardHeader>
                        <CardContent className="p-2 pt-0 flex flex-col items-start gap-1.5">
                            <div className="flex items-center gap-2 w-full justify-between">
                                <div className="text-xs text-foreground flex items-center gap-2">
                                    Trackpad Gesture
                                </div>
                                <button
                                    onClick={toggleTrackpadGesture}
                                    className={`w-10 h-5 flex items-center rounded-full p-0.5 transition-colors ${trackpadGesture ? "bg-primary" : "bg-muted"}`}
                                >
                                    <div className={`w-4 h-4 bg-card rounded-full shadow-md transform transition-transform ${trackpadGesture ? "translate-x-5" : ""}`} />
                                </button>
                            </div>
                            <div className="flex items-center gap-2 w-full justify-between">
                                <div className="text-xs text-foreground flex items-center gap-2">
                                    Highlight user annotations (GT)
                                </div>
                                <button
                                    onClick={toggleHighlightGt}
                                    className={`w-10 h-5 flex items-center rounded-full p-0.5 transition-colors ${highlightGtAnnotations ? "bg-primary" : "bg-muted"}`}
                                >
                                    <div className={`w-4 h-4 bg-card rounded-full shadow-md transform transition-transform ${highlightGtAnnotations ? "translate-x-5" : ""}`} />
                                </button>
                            </div>
                            {/* Zoom speed */}
                            <RangeInput
                                label="Zoom speed"
                                defaultHint="(Default = 0.5)"
                                min={0.1}
                                max={2}
                                step={0.1}
                                value={zoomSpeed}
                                onChange={handleZoomSpeedChange}
                                showNumberInput={true}
                                formatValue={(v) => Number(v).toFixed(1)}
                            />
                            {/* Centroid size */}
                            <RangeInput
                                label="Centroid size"
                                defaultHint="(Default = 1.5)"
                                min={0.5}
                                max={5}
                                step={0.1}
                                value={centroidSize}
                                onChange={handleCentroidSizeChange}
                                showNumberInput={true}
                                formatValue={(v) => Number(v).toFixed(1)}
                            />
                            {/* Overlay alpha */}
                            <RangeInput
                                label="Overlay alpha"
                                defaultHint="(Default = 0.4)"
                                min={0}
                                max={1}
                                step={0.01}
                                value={overlayAlpha}
                                onChange={handleOverlayAlphaChange}
                                showNumberInput={true}
                                formatValue={(v) => Number(v).toFixed(2)}
                            />
                            {/* Centroid threshold */}
                            <RangeInput
                                label="Centroid threshold"
                                defaultHint="(Default = 10x)"
                                min={0.1}
                                max={100}
                                step={0.1}
                                value={centroidThreshold}
                                onChange={handleCentroidThresholdChange}
                                showNumberInput={true}
                            />
                            
                            {/* Reset to Default Button */}
                            <div className="flex justify-start mt-2 pt-1">
                                <Button
                                    onClick={resetToDefaults}
                                    variant="outline"
                                    size="sm"
                                    className="text-xs px-3 py-1 h-7"
                                >
                                    Reset to Default Settings
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                    )}
                    {(submenu === 'general' || !isElectron) && <ShortcutsCard />}
                    {isElectron && submenu === 'pathlearn' && (
                    <Card className="w-[280px]">
                        <CardHeader className="p-2 pb-2">
                            <CardTitle className="text-sm">PathLearn</CardTitle>
                        </CardHeader>
                        <CardContent className="p-2 pt-0 flex flex-col items-start gap-1.5">
                            <div className="flex items-center gap-2 w-full justify-between">
                                <div className="text-xs text-foreground flex items-center gap-2">Mouse Tracking</div>
                                <button
                                    onClick={toggleMouseTracking}
                                    className={`w-10 h-5 flex items-center rounded-full p-0.5 transition-colors ${enableMouseTracking ? "bg-primary" : "bg-muted"}`}
                                >
                                    <div className={`w-4 h-4 bg-card rounded-full shadow-md transform transition-transform ${enableMouseTracking ? "translate-x-5" : ""}`} />
                                </button>
                            </div>
                            <div className="flex items-center gap-2 w-full justify-between">
                                <div className="text-xs text-foreground flex items-center gap-2">Viewport History</div>
                                <button
                                    onClick={toggleViewportHistory}
                                    className={`w-10 h-5 flex items-center rounded-full p-0.5 transition-colors ${enableViewportHistory ? "bg-primary" : "bg-muted"}`}
                                >
                                    <div className={`w-4 h-4 bg-card rounded-full shadow-md transform transition-transform ${enableViewportHistory ? "translate-x-5" : ""}`} />
                                </button>
                            </div>
                        </CardContent>
                    </Card>
                    )}
                </div>
            </div>
        </div>
    );
};

export default SidebarPrefs;

// Editable shortcuts card
const ShortcutsCard: React.FC = () => {
    const { bindings, updateShortcut, reset } = useShortcuts();
    const [waitingKeyFor, setWaitingKeyFor] = React.useState<string | null>(null);
    const [conflictFor, setConflictFor] = React.useState<ShortcutActionKey | null>(null);
    const [conflictWith, setConflictWith] = React.useState<ShortcutActionKey | null>(null);
    const [reservedFor, setReservedFor] = React.useState<ShortcutActionKey | null>(null);
    const [reservedKey, setReservedKey] = React.useState<string | null>(null);

    const Row: React.FC<{ label: string; value: string; actionKey: ShortcutActionKey; onChange: (k: string) => void }> = ({ label, value, actionKey, onChange }) => {
        const buttonRef = React.useRef<HTMLButtonElement>(null);
        const keyDownHandlerRef = React.useRef<((e: KeyboardEvent) => void) | null>(null);
        const previousValueRef = React.useRef<string>(value);

        // Update previous value ref when value changes (outside waiting mode)
        React.useEffect(() => {
            if (waitingKeyFor !== label) {
                previousValueRef.current = value;
            }
        }, [value, waitingKeyFor, label]);

        // Cleanup function to exit waiting mode
        const exitWaitingMode = React.useCallback((restoreValue = false) => {
            if (restoreValue && previousValueRef.current !== value) {
                // Restore previous value if it was changed
                onChange(previousValueRef.current);
            }
            setWaitingKeyFor(null);
            setConflictFor(null);
            setConflictWith(null);
            setReservedFor(null);
            setReservedKey(null);
            if (keyDownHandlerRef.current) {
                window.removeEventListener('keydown', keyDownHandlerRef.current, true);
                keyDownHandlerRef.current = null;
            }
        }, [value, onChange]);

        // Handle click outside or focus loss
        React.useEffect(() => {
            if (waitingKeyFor !== label) return;

            const handleClickOutside = (e: MouseEvent) => {
                if (buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
                    // Exit waiting mode and restore previous value
                    exitWaitingMode(true);
                }
            };

            const handleFocusLoss = () => {
                // Exit waiting mode and restore previous value
                exitWaitingMode(true);
            };

            // Add click outside listener (use setTimeout to avoid immediate trigger)
            const timeoutId = setTimeout(() => {
                document.addEventListener('mousedown', handleClickOutside);
            }, 0);

            // Add blur listener to button
            const button = buttonRef.current;
            if (button) {
                button.addEventListener('blur', handleFocusLoss);
            }

            return () => {
                clearTimeout(timeoutId);
                document.removeEventListener('mousedown', handleClickOutside);
                if (button) {
                    button.removeEventListener('blur', handleFocusLoss);
                }
            };
        }, [waitingKeyFor, label, exitWaitingMode]);

        const onBadgeClick = () => {
            // Exit any existing waiting mode first
            if (keyDownHandlerRef.current) {
                window.removeEventListener('keydown', keyDownHandlerRef.current, true);
            }
            
            // Save current value before entering waiting mode
            previousValueRef.current = value;
            
            setWaitingKeyFor(label);
            setConflictFor(null);
            setConflictWith(null);
            setReservedFor(null);
            setReservedKey(null);
            
            const onKeyDown = (e: KeyboardEvent) => {
                // Check if we're still waiting for this specific row
                setWaitingKeyFor((current) => {
                    if (current !== label) {
                        window.removeEventListener('keydown', onKeyDown, true);
                        keyDownHandlerRef.current = null;
                        return current;
                    }
                    return current;
                });
                
                e.preventDefault();
                e.stopPropagation();
                
                if (e.key === 'Escape') {
                    // Cancel - exit waiting mode and restore previous value
                    exitWaitingMode(true);
                    return;
                }
                
                const key = (e.key === ' ')
                    ? 'Space'
                    : (e.key && e.key.length === 1 ? e.key.toLowerCase() : e.code);
                
                // reserved key guard (system-reserved)
                if (key === 'f') {
                    setReservedFor(actionKey);
                    setReservedKey('f');
                    // Keep listening for another key or Esc - stay in waiting mode, don't update value
                    return;
                }
                
                // conflict detection
                const hit = Object.entries(bindings).find(([k, v]) => v === key && (k as ShortcutActionKey) !== actionKey) as [ShortcutActionKey, string] | undefined;
                if (hit) {
                    setConflictFor(actionKey);
                    setConflictWith(hit[0]);
                    // Keep listening for the next key or Esc - stay in waiting mode, don't update value
                    return;
                }
                
                // Valid key - update the binding and exit waiting mode (don't restore value)
                onChange(key);
                exitWaitingMode(false);
            };
            
            keyDownHandlerRef.current = onKeyDown;
            window.addEventListener('keydown', onKeyDown, true);
        };

        // Determine status
        const isWaiting = waitingKeyFor === label;
        const hasConflict = conflictFor === actionKey;
        const isReserved = reservedFor === actionKey;
        const status = isWaiting ? 'waiting' : hasConflict || isReserved ? 'conflict' : 'ok';

        return (
            <div className="grid grid-cols-[1fr_120px_24px] items-center gap-2 py-1.5 px-1 hover:bg-muted/50 rounded transition-colors">
                <div className="text-xs font-medium text-foreground">{label}</div>
                <button
                    ref={buttonRef}
                    onClick={onBadgeClick}
                    className={`h-8 w-full rounded border border-border bg-background text-center text-xs font-medium hover:bg-muted transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 ${
                        isWaiting ? 'text-muted-foreground leading-tight' : 'text-foreground'
                    }`}
                >
                    {isWaiting ? (
                        <>
                            Press a key<br />or Esc to cancel
                        </>
                    ) : (
                        value
                    )}
                </button>
                <div className="flex items-center justify-center">
                    {status === 'ok' && (
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                    )}
                    {status === 'conflict' && (
                        <XCircle className="h-4 w-4 text-destructive" />
                    )}
                </div>
            </div>
        );
    };

    return (
        <Card className="w-[280px]">
            <CardHeader className="p-2 pb-2 flex flex-row items-center justify-between">
                <CardTitle className="text-sm">Keyboard Shortcuts</CardTitle>
                <Button size="sm" variant="outline" className="h-7" onClick={reset}>Reset</Button>
            </CardHeader>
            <CardContent className="p-2 pt-0">
                {conflictFor && conflictWith && (
                    <div className="mb-1.5 px-2 py-1 rounded-sm text-[11px] bg-destructive/10 text-destructive border border-destructive/20 text-center">
                        Conflict: <span className="font-medium">{conflictFor}</span> conflicts with <span className="font-medium">{conflictWith}</span>.
                        <br />
                        Press another key or Esc to cancel.
                    </div>
                )}
                {reservedFor && reservedKey && (
                    <div className="mb-1.5 px-2 py-1 rounded-sm text-[11px] bg-muted text-foreground border border-border text-center">
                        &quot;{reservedKey}&quot; is reserved by the OSD.flip.
                        <br />
                        Press another key or Esc to cancel.
                    </div>
                )}
                <div className="space-y-0">
                    <Row label="Toggle Nuclei Annotations" actionKey={'toggleNuclei'} value={bindings.toggleNuclei} onChange={(k) => updateShortcut('toggleNuclei', k)} />
                    <Row label="Toggle Patch Annotations" actionKey={'togglePatches'} value={bindings.togglePatches} onChange={(k) => updateShortcut('togglePatches', k)} />
                    <Row label="Toggle Mask Overlay" actionKey={'toggleMask'} value={bindings.toggleMask} onChange={(k) => updateShortcut('toggleMask', k)} />
                    <Row label="Tool: Move" actionKey={'tool.move'} value={bindings['tool.move']} onChange={(k) => updateShortcut('tool.move', k)} />
                    <Row label="Tool: Polygon" actionKey={'tool.polygon'} value={bindings['tool.polygon']} onChange={(k) => updateShortcut('tool.polygon', k)} />
                    <Row label="Tool: Rectangle" actionKey={'tool.rectangle'} value={bindings['tool.rectangle']} onChange={(k) => updateShortcut('tool.rectangle', k)} />
                    <Row label="Tool: Ruler" actionKey={'tool.line'} value={bindings['tool.line']} onChange={(k) => updateShortcut('tool.line', k)} />
                    <Row label="Tool: Filter" actionKey={'tool.filter'} value={bindings['tool.filter']} onChange={(k) => updateShortcut('tool.filter', k)} />
                </div>
            </CardContent>
        </Card>
    );
};

// Removed Change button; capture via clicking the key badge
