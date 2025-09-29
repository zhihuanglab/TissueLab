import React from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableRow, TableCell } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { useViewerSettings } from '@/hooks/useViewerSettings';
import { useShortcuts } from '@/hooks/useShortcuts';
import type { ShortcutActionKey } from '@/store/slices/shortcutsSlice';

const KeyboardKey = ({ children }: { children: React.ReactNode }) => (
    <span className="relative inline-flex items-center justify-center min-w-[24px] px-2 py-1 text-xs font-semibold text-gray-700">
        {/* Smaller Base Layer for a deeper 3D effect with darkened corners */}
        <span className="absolute inset-0 transform translate-x-0.5 translate-y-0.5 scale-x-80 scale-y-85 bg-gradient-to-br from-gray-500 to-gray-400 rounded-md shadow-[2px_2px_4px_rgba(0,0,0,0.3)]"></span>

        {/* Top Layer - Main Key with darker border and inner shadow */}
        <span className="relative inline-flex items-center justify-center min-w-[24px] px-2 py-1 text-xs font-semibold text-gray-700 bg-gradient-to-b from-gray-200 to-gray-100 rounded-md border border-gray-400 shadow-[inset_0_-1px_1px_rgba(0,0,0,0.2), inset_0_0_4px_rgba(0,0,0,0.15)]">
            {children}
        </span>
    </span>
);

const SidebarPrefs = () => {
    const {
        zoomSpeed,
        centroidSize,
        trackpadGesture,
        handleZoomSpeedChange,
        handleCentroidSizeChange,
        toggleTrackpadGesture,
        resetToDefaults,
        DEFAULT_SETTINGS
    } = useViewerSettings();

    return (
        <div className="flex flex-col justify-between h-full w-full p-1">
            {/* Fixed Header */}
            <div className="bg-white border-b h-8 flex items-center justify-center">
                <span className="font-medium text-base">Preferences</span>
            </div>

            {/* Scrollable Chat Area */}
            <div className="flex-1 overflow-y-auto bg-slate-50 p-1">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    <Card>
                        <CardHeader className="p-3">
                            <CardTitle className="text-sm">General Settings</CardTitle>
                        </CardHeader>
                        <CardContent className="p-3 pt-0 flex flex-col items-start gap-2">
                            <div className="flex items-center gap-2 w-full justify-between">
                                <div className="text-xs text-gray-700 flex items-center gap-2">
                                    Trackpad Gesture
                                </div>
                                <button
                                    onClick={toggleTrackpadGesture}
                                    className={`w-10 h-5 flex items-center rounded-full p-0.5 transition-colors ${trackpadGesture ? "bg-blue-500" : "bg-gray-300"}`}
                                >
                                    <div className={`w-4 h-4 bg-white rounded-full shadow-md transform transition-transform ${trackpadGesture ? "translate-x-5" : ""}`} />
                                </button>
                            </div>
                            {/* Zoom speed */}
                            <div className="w-full">
                                <div className="flex items-center gap-2 mb-1">
                                    <span className="text-xs text-gray-700">Zoom speed</span>
                                    <span className="text-xs text-gray-400">(Default = 2.0)</span>
                                </div>
                                <div className="flex items-center gap-2 w-full">
                                    <input
                                        type="range"
                                        min={0.5}
                                        max={10}
                                        step={0.1}
                                        value={zoomSpeed}
                                        onChange={handleZoomSpeedChange}
                                        className="flex-1 w-full h-2 rounded-lg appearance-none bg-gray-200 transition-all focus:outline-none focus:ring-2 focus:ring-blue-400 hover:bg-gray-300"
                                    />
                                    <input
                                        type="number"
                                        min={0.5}
                                        max={10}
                                        step={0.1}
                                        value={Number(zoomSpeed).toFixed(1)}
                                        onChange={handleZoomSpeedChange}
                                        className="text-xs text-gray-700 w-14 text-right font-mono bg-gray-100 rounded px-1 py-0.5 border border-gray-200 ml-2"
                                    />
                                </div>
                            </div>
                            {/* Centroid size */}
                            <div className="w-full">
                                <div className="flex items-center gap-2 mb-1">
                                    <span className="text-xs text-gray-700">Centroid size</span>
                                    <span className="text-xs text-gray-400">(Default = 1.5)</span>
                                </div>
                                <div className="flex items-center gap-2 w-full">
                                    <input
                                        type="range"
                                        min={0.5}
                                        max={5}
                                        step={0.1}
                                        value={centroidSize}
                                        onChange={handleCentroidSizeChange}
                                        className="flex-1 w-full h-2 rounded-lg appearance-none bg-gray-200 transition-all focus:outline-none focus:ring-2 focus:ring-blue-400 hover:bg-gray-300"
                                    />
                                    <input
                                        type="number"
                                        min={0.5}
                                        max={5}
                                        step={0.1}
                                        value={Number(centroidSize).toFixed(1)}
                                        onChange={handleCentroidSizeChange}
                                        className="text-xs text-gray-700 w-14 text-right font-mono bg-gray-100 rounded px-1 py-0.5 border border-gray-200 ml-2"
                                    />
                                </div>
                            </div>
                            
                            {/* Reset to Default Button */}
                            <div className="flex justify-center mt-3 pt-2">
                                <Button
                                    onClick={resetToDefaults}
                                    variant="outline"
                                    size="sm"
                                    className="text-xs px-3 py-1"
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

// Editable shortcuts card
const ShortcutsCard: React.FC = () => {
    const { bindings, updateShortcut, reset } = useShortcuts();
    const [waitingKeyFor, setWaitingKeyFor] = React.useState<string | null>(null);
    const [conflictFor, setConflictFor] = React.useState<ShortcutActionKey | null>(null);
    const [conflictWith, setConflictWith] = React.useState<ShortcutActionKey | null>(null);
    const [reservedFor, setReservedFor] = React.useState<ShortcutActionKey | null>(null);
    const [reservedKey, setReservedKey] = React.useState<string | null>(null);

    const Row: React.FC<{ label: string; value: string; actionKey: ShortcutActionKey; onChange: (k: string) => void }> = ({ label, value, actionKey, onChange }) => {
        const onBadgeClick = () => {
            setWaitingKeyFor(label);
            const onKeyDown = (e: KeyboardEvent) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.key === 'Escape') {
                    setWaitingKeyFor(null);
                    setConflictFor(null);
                    setConflictWith(null);
                    setReservedFor(null);
                    setReservedKey(null);
                    window.removeEventListener('keydown', onKeyDown, true);
                    return;
                }
                const key = (e.key === ' ')
                    ? 'Space'
                    : (e.key && e.key.length === 1 ? e.key.toLowerCase() : e.code);
                // reserved key guard (system-reserved)
                if (key === 'f') {
                    setReservedFor(actionKey);
                    setReservedKey('f');
                    // Keep listening for another key or Esc
                    return;
                }
                // conflict detection
                const hit = Object.entries(bindings).find(([k, v]) => v === key && (k as ShortcutActionKey) !== actionKey) as [ShortcutActionKey, string] | undefined;
                if (hit) {
                    setConflictFor(actionKey);
                    setConflictWith(hit[0]);
                    // Keep listening for the next key or Esc; do not remove listener
                    return;
                } else {
                    onChange(key);
                    setConflictFor(null);
                    setConflictWith(null);
                    setWaitingKeyFor(null);
                    setReservedFor(null);
                    setReservedKey(null);
                }
                window.removeEventListener('keydown', onKeyDown, true);
            };
            window.addEventListener('keydown', onKeyDown, true);
        };
        return (
            <TableRow className="compact-row">
                <TableCell className="font-medium text-xs py-1 px-2">{label}</TableCell>
                <TableCell className="flex items-center gap-2 py-1 px-2">
                    <button onClick={onBadgeClick} title={waitingKeyFor === label ? 'Press a key or Esc to cancel' : 'Click and press a key'}>
                        <KeyboardKey>{waitingKeyFor === label ? '...' : value}</KeyboardKey>
                    </button>
                </TableCell>
            </TableRow>
        );
    };

    return (
        <Card>
            <CardHeader className="p-3 flex flex-row items-center justify-between">
                <CardTitle className="text-sm">Keyboard Shortcuts</CardTitle>
                <Button size="sm" variant="outline" className="h-7" onClick={reset}>Reset</Button>
            </CardHeader>
            <CardContent className="p-3 pt-0">
                {conflictFor && conflictWith && (
                    <div className="mb-2 px-2 py-1 rounded-sm text-[11px] bg-red-50 text-red-700 border border-red-200 text-center">
                        Conflict: <span className="font-medium">{conflictFor}</span> conflicts with <span className="font-medium">{conflictWith}</span>.
                        <br />
                        Press another key or Esc to cancel.
                    </div>
                )}
                {reservedFor && reservedKey && (
                    <div className="mb-2 px-2 py-1 rounded-sm text-[11px] bg-yellow-50 text-yellow-800 border border-yellow-200 text-center">
                        &quot;{reservedKey}&quot; is reserved by the OSD.flip.
                        <br />
                        Press another key or Esc to cancel.
                    </div>
                )}
                <Table className="compact-table">
                    <TableBody>
                        <Row label="Toggle Nuclei Annotations" actionKey={'toggleNuclei'} value={bindings.toggleNuclei} onChange={(k) => updateShortcut('toggleNuclei', k)} />
                        <Row label="Toggle Patch Annotations" actionKey={'togglePatches'} value={bindings.togglePatches} onChange={(k) => updateShortcut('togglePatches', k)} />
                        <Row label="Tool: Move" actionKey={'tool.move'} value={bindings['tool.move']} onChange={(k) => updateShortcut('tool.move', k)} />
                        <Row label="Tool: Polygon" actionKey={'tool.polygon'} value={bindings['tool.polygon']} onChange={(k) => updateShortcut('tool.polygon', k)} />
                        <Row label="Tool: Rectangle" actionKey={'tool.rectangle'} value={bindings['tool.rectangle']} onChange={(k) => updateShortcut('tool.rectangle', k)} />
                        <Row label="Tool: Ruler" actionKey={'tool.line'} value={bindings['tool.line']} onChange={(k) => updateShortcut('tool.line', k)} />
                    </TableBody>
                </Table>
            </CardContent>
        </Card>
    );
};

// Removed Change button; capture via clicking the key badge
