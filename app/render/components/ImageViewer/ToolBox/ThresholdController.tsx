import { useRef, useEffect, useState, useCallback } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { updateThreshold } from '@/store/slices/annotationSlice'
import { RootState } from '@/store'
import throttle from 'lodash/throttle'

const ThresholdController = () => {
  const dispatch = useDispatch()

  const threshold = useSelector((state: RootState) => state.annotations.threshold)

  const [isDragging, setIsDragging] = useState(false)
  const sliderRef = useRef<HTMLDivElement>(null)

  const handleMouseDown = useCallback(() => {
    setIsDragging(true)
  }, [])

  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
  }, [])

  const throttledDispatch = useRef(
    throttle((newThreshold: number) => {
      dispatch(updateThreshold(newThreshold))
    }, 100)
  ).current

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (isDragging && sliderRef.current) {
        const rect = sliderRef.current.getBoundingClientRect()
        const x = e.clientX - rect.left
        const newThreshold = Math.max(
          10,
          Math.min(852, Math.round((x / rect.width) * (852 - 10) + 10))
        )

        throttledDispatch(newThreshold)
      }
    },
    [isDragging, throttledDispatch]
  )

  const incrementThreshold = useCallback(() => {
    dispatch(updateThreshold(Math.min(threshold + 1, 852)))
  }, [threshold, dispatch])

  const decrementThreshold = useCallback(() => {
    dispatch(updateThreshold(Math.max(threshold - 1, 10)))
  }, [threshold, dispatch])

  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [handleMouseMove, handleMouseUp])

  return (
    <div className="fixed bottom-4 right-14 z-[9] flex items-center space-x-4">
      {/* Decrement Button */}
      <button
        onClick={decrementThreshold}
        className="w-4 h-4 flex items-center justify-center bg-gray-200 text-gray-800 rounded-full shadow hover:bg-gray-300 text-sm leading-none"
      >
        -
      </button>

      {/* Slider */}
      <div
        className="relative w-48 h-1 bg-gray-300 rounded-full cursor-pointer"
        ref={sliderRef}
        onMouseDown={handleMouseDown}
      >
        {/* Slider bar */}
        <div
          className="absolute top-0 left-0 h-full bg-gradient-to-r from-[#30cfd0] to-[#3308] rounded-full transition-all duration-300 ease-out"
          style={{width: `${((threshold - 10) / (852 - 10)) * 100}%`}}
        />

        {/* Draggable button */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-5 h-5 bg-gray-200 rounded-full shadow-md flex items-center justify-center text-[8px] font-semibold text-gray-200 cursor-pointer transition-all duration-300 ease-out"
          style={{
            left: `calc(${((threshold - 10) / (852 - 10)) * 100}% - 0.5rem)`
          }}
          onMouseDown={handleMouseDown}
        >
          <span className="text-black">{threshold}</span>
        </div>
      </div>

      {/* Increment Button */}
      <button
        onClick={incrementThreshold}
        className="w-4 h-4 flex items-center justify-center bg-gray-200 text-gray-800 rounded-full shadow hover:bg-gray-300 text-sm"
      >
        +
      </button>
    </div>
  )
}

export default ThresholdController
