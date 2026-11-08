import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RangeInput } from '@/components/ui/range-input';
import { useShortcuts } from '@/hooks/viewer/useShortcuts';
import { useViewerSettings } from '@/hooks/viewer/useViewerSettings';
import { findShortcutConflict, shortcutKeyFromEvent, type ShortcutActionKey } from '@/store/slices/viewer/shortcutsSlice';
import { CheckCircle2, XCircle } from 'lucide-react';
import React from 'react';

const SidebarPrefs = () => {
    const {
        zoomSpeed,
        centroidSize,
        overlayAlpha,
        centroidThreshold,
        trackpadGesture,
        highlightGtAnnotations,
        handleZoomSpeedChange,
        handleCentroidSizeChange,
        handleOverlayAlphaChange,
        handleCentroidThresholdChange,
        toggleTrackpadGesture,
        toggleHighlightGt,
        resetToDefaults,
        DEFAULT_SETTINGS
    } = useViewerSettings();

    return (
        <div className="flex flex-col justify-between h-full w-full overflow-hidden rounded-lg">
            {/* Fixed Header */}
            <div className="bg-card border-b border-border h-8 flex items-center justify-center">
                <span className="font-medium text-sm text-foreground">Preferences</span>
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto bg-background p-2">
                <div className="flex flex-row gap-2">
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
                    <ShortcutsCard />
                </div>
            </div>
        </div>
    );
};

export default SidebarPrefs;

/** Same top-to-bottom order as the viewer toolbar (tools left to right, then the overlay toggles). */
const SHORTCUT_ROWS: { label: string; action: ShortcutActionKey }[] = [
    { label: 'Tool: Move', action: 'tool.move' },
    { label: 'Tool: Lasso', action: 'tool.lasso' },
    { label: 'Tool: Rectangle', action: 'tool.rectangle' },
    { label: 'Tool: Polygon', action: 'tool.polygon' },
    { label: 'Tool: Ruler', action: 'tool.line' },
    { label: 'Tool: Filter', action: 'tool.filter' },
    { label: 'Toggle Nuclei Annotations', action: 'toggleNuclei' },
    { label: 'Toggle Patch Annotations', action: 'togglePatches' },
    { label: 'Toggle Tissue Overlay', action: 'toggleMask' },
];

/** Keys the viewer itself owns ('f' flips the slide), so they cannot be rebound. */
const RESERVED_KEYS = new Set(['f']);

/**
 * The row waiting for a key press, if any, and why its last key was refused.
 * The binding only changes once an accepted key arrives, so leaving capture
 * (Esc, click outside, focus loss) has nothing to undo.
 */
type ShortcutCapture = {
    action: ShortcutActionKey;
    refused?: { reason: 'conflict'; with: ShortcutActionKey } | { reason: 'reserved'; key: string };
} | null;

// One shortcut row. Declared at module scope: a component declared inside
// ShortcutsCard is a new type on every render, so every row would remount.
const ShortcutRow: React.FC<{
    label: string;
    action: ShortcutActionKey;
    bindings: Record<ShortcutActionKey, string>;
    capture: ShortcutCapture;
    setCapture: (capture: ShortcutCapture) => void;
    updateShortcut: (action: ShortcutActionKey, key: string) => void;
}> = ({ label, action, bindings, capture, setCapture, updateShortcut }) => {
    const buttonRef = React.useRef<HTMLButtonElement>(null);
    const isWaiting = capture?.action === action;

    // While this row waits: take the next key press, and leave on a click
    // elsewhere or focus loss. Clicking another row ends this one the same way.
    React.useEffect(() => {
        if (!isWaiting) return;

        const onKeyDown = (e: KeyboardEvent) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === 'Escape') {
                setCapture(null);
                return;
            }
            const key = shortcutKeyFromEvent(e);
            if (RESERVED_KEYS.has(key)) {
                setCapture({ action, refused: { reason: 'reserved', key } });
                return;
            }
            const taken = findShortcutConflict(bindings, key, action);
            if (taken) {
                setCapture({ action, refused: { reason: 'conflict', with: taken } });
                return;
            }
            updateShortcut(action, key);
            setCapture(null);
        };
        const onMouseDown = (e: MouseEvent) => {
            if (!buttonRef.current?.contains(e.target as Node)) setCapture(null);
        };
        const onBlur = () => setCapture(null);

        const button = buttonRef.current;
        window.addEventListener('keydown', onKeyDown, true);
        // Deferred so the click that started capture does not end it.
        const timeoutId = setTimeout(() => document.addEventListener('mousedown', onMouseDown), 0);
        button?.addEventListener('blur', onBlur);
        return () => {
            window.removeEventListener('keydown', onKeyDown, true);
            clearTimeout(timeoutId);
            document.removeEventListener('mousedown', onMouseDown);
            button?.removeEventListener('blur', onBlur);
        };
    }, [isWaiting, action, bindings, setCapture, updateShortcut]);

    const refused = isWaiting && capture?.refused;

    return (
        <div className="grid grid-cols-[1fr_120px_24px] items-center gap-2 py-1.5 px-1 hover:bg-muted/50 rounded transition-colors">
            <div className="text-xs font-medium text-foreground">{label}</div>
            <button
                ref={buttonRef}
                onClick={() => setCapture({ action })}
                className={`h-8 w-full rounded border border-border bg-background text-center text-xs font-medium hover:bg-muted transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 ${
                    isWaiting ? 'text-muted-foreground leading-tight' : 'text-foreground'
                }`}
            >
                {isWaiting ? (
                    <>
                        Press a key<br />or Esc to cancel
                    </>
                ) : (
                    bindings[action]
                )}
            </button>
            <div className="flex items-center justify-center">
                {refused ? (
                    <XCircle className="h-4 w-4 text-destructive" />
                ) : !isWaiting && (
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                )}
            </div>
        </div>
    );
};

// Editable shortcuts card; a binding is changed by clicking its key badge.
const ShortcutsCard: React.FC = () => {
    const { bindings, updateShortcut, reset } = useShortcuts();
    const [capture, setCapture] = React.useState<ShortcutCapture>(null);
    const refused = capture?.refused;

    return (
        <Card className="w-[280px]">
            <CardHeader className="p-2 pb-2 flex flex-row items-center justify-between">
                <CardTitle className="text-sm">Keyboard Shortcuts</CardTitle>
                <Button size="sm" variant="outline" className="h-7" onClick={reset}>Reset</Button>
            </CardHeader>
            <CardContent className="p-2 pt-0">
                {refused?.reason === 'conflict' && (
                    <div className="mb-1.5 px-2 py-1 rounded-sm text-[11px] bg-destructive/10 text-destructive border border-destructive/20 text-center">
                        Conflict: <span className="font-medium">{capture!.action}</span> conflicts with <span className="font-medium">{refused.with}</span>.
                        <br />
                        Press another key or Esc to cancel.
                    </div>
                )}
                {refused?.reason === 'reserved' && (
                    <div className="mb-1.5 px-2 py-1 rounded-sm text-[11px] bg-muted text-foreground border border-border text-center">
                        &quot;{refused.key}&quot; is reserved by the OSD.flip.
                        <br />
                        Press another key or Esc to cancel.
                    </div>
                )}
                <div className="space-y-0">
                    {SHORTCUT_ROWS.map(({ label, action }) => (
                        <ShortcutRow
                            key={action}
                            label={label}
                            action={action}
                            bindings={bindings}
                            capture={capture}
                            setCapture={setCapture}
                            updateShortcut={updateShortcut}
                        />
                    ))}
                </div>
            </CardContent>
        </Card>
    );
};

// Removed Change button; capture via clicking the key badge
