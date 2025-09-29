'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Cpu, Settings2, RefreshCw, ChevronUp, ChevronDown } from 'lucide-react'
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { motion, AnimatePresence } from "framer-motion"

interface GPUFeatures {
  canvas_2d: boolean
  webgl: boolean
  webgl2: boolean
  webgpu: boolean
}

const formatFeatureName = (name: string) => {
  return name
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

const getStatusColor = (status: boolean) => {
  if (status) return 'bg-green-500/20 text-green-500'
  return 'bg-red-500/20 text-red-500'
}

export default function GPUStatusWatchDog() {
  const [features, setFeatures] = useState<GPUFeatures | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const [renderer, setRenderer] = useState('Unknown')
  const [vendor, setVendor] = useState('Unknown')

  const getGpuStatus = async () => {
    const results = {
      canvas_2d: false,
      webgl: false,
      webgl2: false,
      webgpu: false
    }

    const canvas = document.createElement('canvas');
    // Detect GPU features
    results.canvas_2d = !!canvas.getContext('2d');
    const canvas_gl = document.createElement('canvas');
    results.webgl = !!canvas_gl.getContext('webgl');
    const canvas_gl2 = document.createElement('canvas');
    results.webgl2 = !!canvas_gl2.getContext('webgl2')
    results.webgpu = 'gpu' in navigator;

    // Detect GPU renderer and vendor
    const gl = canvas_gl.getContext('webgl');
    if (gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = debugInfo && gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
      const vendor = debugInfo && gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
      setRenderer(renderer || 'Unknown')
      setVendor(vendor || 'Unknown')
    } else {
      console.log('WebGL not supported or GPU disabled.');
    }
    setFeatures(results)
  };

  const handleRefresh = async () => {
    setIsRefreshing(true)
    getGpuStatus()
    setTimeout(() => {
      setIsRefreshing(false)
    }, 500)
  }

  const toggleExpand = () => {
    setIsExpanded(!isExpanded)
  }

  useEffect(() => {
    getGpuStatus()
  }, [])

  if (!features) {
    return (
      <Card className="w-96 h-48 bg-black/30 backdrop-blur-md rounded-xl flex items-center justify-center fixed bottom-5 right-5 z-50">
        <div className="animate-pulse text-white/70">Loading GPU features...</div>
      </Card>
    )
  }

  return (
    <Card className={`fixed bottom-5 right-5 z-50 bg-black/30 backdrop-blur-md overflow-hidden border-0 transition-all duration-300 ${isExpanded ? 'w-96 rounded-xl' : 'w-12 h-12 rounded-full'}`}>
      <CardContent className={`p-0 ${isExpanded ? '' : 'flex items-center justify-center h-full'}`}>
        {!isExpanded ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleExpand}
            className="w-full h-full rounded-full text-white/70 hover:text-white hover:bg-white/10"
          >
            <Settings2 className="w-6 h-6" />
          </Button>
        ) : (
          <div className="p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Settings2 className="w-5 h-5 text-white/70" />
                <h2 className="text-lg font-semibold text-white">GPU Info</h2>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleRefresh}
                  disabled={isRefreshing}
                  className="text-white/70 hover:text-white hover:bg-white/10"
                >
                  <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={toggleExpand}
                  className="text-white/70 hover:text-white hover:bg-white/10"
                >
                  <ChevronDown className="w-4 h-4" />
                </Button>
              </div>
            </div>
            <Separator className="mb-4 bg-white/10" />
            <AnimatePresence>
              {isExpanded && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.3 }}
                >
                  <ScrollArea className="h-[400px] pr-4">
                    <div className="space-y-4">
                      <div>
                        <h3 className="text-sm font-semibold text-white mb-2">GPU Renderer</h3>
                        <p className="text-sm text-white/70">{renderer}</p>
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-white mb-2">GPU Vendor</h3>
                        <p className="text-sm text-white/70">{vendor}</p>
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-white mb-2">GPU Features</h3>
                        <div className="space-y-3">
                          {(Object.entries(features) as [keyof GPUFeatures, boolean][]).map(([key, value]) => (
                            <div key={key} className="flex items-center justify-between group">
                              <span className="text-sm text-white/70 group-hover:text-white transition-colors">
                                {formatFeatureName(key)}
                              </span>
                              <Badge
                                variant="secondary"
                                className={`${getStatusColor(value)} border-0 font-medium`}
                              >
                                {value ? 'Enabled' : 'Disabled'}
                              </Badge>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </ScrollArea>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
